import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { HerdrAdapter } from './herdr-adapter.ts';
import type { NormalizedPhase, NormalizedWorkflow } from './workflow.ts';
import type { DaemonStepResult } from './runtime.ts';
import {
  applyAcceptedResultArtifact,
  createAcceptedResultArtifactSummary,
  evaluateResultArtifact,
} from './result-artifact.ts';
import {
  isRecord,
  optionalBoolean,
  optionalTrimmedString,
} from './validation.ts';
import type {
  DaemonHandleState,
  PendingAgentRunState,
  RoleAgentState,
  WorkflowRunState,
} from './workflow-state-store.ts';

export type AgentLifecycleOptions = {
  cwd: string;
  state: WorkflowRunState;
  handleState: DaemonHandleState;
  adapter: HerdrAdapter;
  now: () => Date;
};

export type AgentLifecycleResult = {
  state: WorkflowRunState;
  handleState: DaemonHandleState;
  result: DaemonStepResult;
};

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function requireString(value: unknown, field: string): string {
  const stringValue = optionalTrimmedString(value);
  if (!stringValue) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return stringValue;
}

function renderTemplate(source: string, values: Record<string, string>): string {
  return source.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key: string) => values[key] ?? '');
}

function readPromptTemplate(cwd: string, workflowPath: string, templateName: string): string {
  const projectPath = join(dirname(resolve(workflowPath)), 'prompts', templateName);
  if (existsSync(projectPath)) {
    return readFileSync(projectPath, 'utf8');
  }

  const skillPath = resolve(cwd, 'skills/herdr-implement/prompts', templateName);
  if (existsSync(skillPath)) {
    return readFileSync(skillPath, 'utf8');
  }

  throw new Error(`prompt template does not exist: ${templateName}`);
}

function renderAgentName(template: string, state: WorkflowRunState, roleId: string): string {
  return renderTemplate(template, {
    'issue.canonical': state.issue.canonical,
    'issue.input': state.issue.input,
    'issue.number': String(state.issue.number ?? ''),
    roleId,
  });
}

function buildCompletionUtilityCommand(): string {
  return 'node skills/herdr-worktree-flow/scripts/agent-run-complete.ts';
}

function completionRoleFor(roleId: string): 'implementer' | 'reviewer' {
  return roleId === 'reviewer' ? 'reviewer' : 'implementer';
}

function agentRunPrefix(issue: WorkflowRunState['issue']): string {
  return issue.number === null ? 'issue-bootstrap' : `issue-${issue.number}`;
}

function buildAgentRunId(state: WorkflowRunState, roleId: string, attemptNumber: number): string {
  return `${agentRunPrefix(state.issue)}-${roleId}-${attemptNumber}`;
}

function parseAgentRunAttemptNumber(runId: string): number | null {
  const match = runId.match(/-(\d+)$/);
  if (!match) {
    return null;
  }

  const attemptNumber = Number(match[1]);
  return Number.isFinite(attemptNumber) ? attemptNumber : null;
}

function nextAgentAttemptNumber(state: WorkflowRunState, phaseId: string, roleId: string): number {
  let highestAttempt = 0;

  // Reuse the same phase/role identity, but always move forward from any
  // accepted or still-pending visit so a looped workflow gets a fresh run id.
  for (const run of Object.values(state.acceptedAgentRuns)) {
    if (run.phaseId !== phaseId || run.roleId !== roleId) {
      continue;
    }

    const attemptNumber = parseAgentRunAttemptNumber(run.runId);
    if (attemptNumber !== null) {
      highestAttempt = Math.max(highestAttempt, attemptNumber);
    }
  }

  const pendingRun = state.pendingAgentRun;
  if (pendingRun?.phaseId === phaseId && pendingRun.roleId === roleId) {
    highestAttempt = Math.max(highestAttempt, pendingRun.attemptNumber);
  }

  return highestAttempt + 1;
}

function buildNotifyTarget(state: WorkflowRunState): string {
  return `${agentRunPrefix(state.issue)}-orchestrator`;
}

function createPendingAgentRun(
  state: WorkflowRunState,
  runId: string,
  phaseId: string,
  roleId: string,
  completionRole: 'implementer' | 'reviewer',
  roleLabel: string,
  agentName: string,
  resultSchema: string | null,
  attemptNumber: number,
  startedAt: string,
): PendingAgentRunState {
  return {
    runId,
    phaseId,
    roleId,
    completionRole,
    roleLabel,
    agentName,
    resultSchema,
    resultPath: join(state.worktreePath, '.agent', 'runs', runId, 'result.json'),
    notifyTarget: buildNotifyTarget(state),
    attemptNumber,
    startedAt,
    status: 'pending',
  };
}

function loadRoleAgent(handleState: DaemonHandleState, roleId: string): RoleAgentState | null {
  return handleState.roleAgents[roleId] ?? null;
}

function saveRoleAgent(handleState: DaemonHandleState, roleAgent: RoleAgentState): DaemonHandleState {
  return {
    ...handleState,
    roleAgents: {
      ...handleState.roleAgents,
      [roleAgent.roleId]: roleAgent,
    },
  };
}

function agentTargetForPendingRun(
  state: WorkflowRunState,
  handleState: DaemonHandleState,
  pendingRun: PendingAgentRunState,
): string | null {
  if (pendingRun.agentName) {
    return pendingRun.agentName;
  }

  const roleAgent = loadRoleAgent(handleState, pendingRun.roleId);
  if (roleAgent?.agentName) {
    return roleAgent.agentName;
  }

  const phase = state.workflow.phases[pendingRun.phaseId];
  if (!phase || phase.type !== 'agent') {
    return null;
  }

  const roleId = requireString(phase.role, `phases.${pendingRun.phaseId}.role`);
  const role = state.workflow.roles[roleId];
  if (!role) {
    return null;
  }

  const agentNameTemplate = optionalTrimmedString(role.agentNameTemplate);
  if (!agentNameTemplate) {
    return null;
  }

  return renderAgentName(agentNameTemplate, state, roleId);
}

function withArtifactRewriteRequest(
  state: WorkflowRunState,
  pendingRun: PendingAgentRunState,
  reason: string,
  requestedAt: string,
): WorkflowRunState {
  return {
    ...state,
    updatedAt: requestedAt,
    context: {
      ...state.context,
      lastArtifactRewriteRequest: {
        runId: pendingRun.runId,
        phaseId: pendingRun.phaseId,
        roleId: pendingRun.roleId,
        reason,
        requestedAt,
      },
    },
  };
}

function renderAgentPhasePrompt(
  cwd: string,
  state: WorkflowRunState,
  phaseId: string,
  roleId: string,
  pendingRun: PendingAgentRunState,
): string {
  const phase = state.workflow.phases[phaseId];
  if (!phase || phase.type !== 'agent') {
    throw new Error(`phase ${phaseId} is not an agent phase`);
  }

  const promptTemplate = requireString(phase.promptTemplate, `phases.${phaseId}.promptTemplate`);
  const templateBody = renderTemplate(readPromptTemplate(cwd, state.workflowPath, promptTemplate), {
    completionUtility: buildCompletionUtilityCommand(),
    completionRole: pendingRun.completionRole,
    notifyTarget: pendingRun.notifyTarget,
    optionalCapture: 'optional capture value if needed',
    phaseId,
    requiredOutcome: Object.keys(phase.on).join(', ') || 'complete',
    resultPath: pendingRun.resultPath,
    roleId,
    runId: pendingRun.runId,
  });

  return [
    'Agent run metadata:',
    `- Run id: ${pendingRun.runId}`,
    `- Phase id: ${phaseId}`,
    `- Role id: ${roleId}`,
    `- Completion role: ${pendingRun.completionRole}`,
    `- Result path: ${pendingRun.resultPath}`,
    `- Notify target: ${pendingRun.notifyTarget}`,
    `- Required outcome: ${Object.keys(phase.on).join(', ') || 'complete'}`,
    '- Optional capture: optional capture value if needed',
    '',
    'When complete, write the result artifact and invoke:',
    '',
    '```bash',
    `${buildCompletionUtilityCommand()} --run-id ${pendingRun.runId} --role ${pendingRun.completionRole} --phase ${phaseId} --result ${pendingRun.resultPath} --notify-target ${pendingRun.notifyTarget}`,
    '```',
    '',
    templateBody,
  ].join('\n');
}

function launchRoleAgent(
  adapter: HerdrAdapter,
  state: WorkflowRunState,
  handleState: DaemonHandleState,
  phaseId: string,
  roleId: string,
  agentName: string,
  now: () => Date,
): { handleState: DaemonHandleState; roleAgent: RoleAgentState } {
  const phase = state.workflow.phases[phaseId];
  if (!phase || phase.type !== 'agent') {
    throw new Error(`phase ${phaseId} is not an agent phase`);
  }

  const role = state.workflow.roles[roleId];
  if (!role) {
    throw new Error(`phase ${phaseId} references unknown role: ${roleId}`);
  }

  const startedAt = nowIso(now);
  const launched = adapter.launchRoleAgent(
    state.worktreePath,
    state.workspaceId,
    role,
    requireString(role.label, `roles.${roleId}.label`),
    agentName,
  );

  if (!launched.paneId) {
    throw new Error(`herdr agent start for ${agentName} did not include a pane id`);
  }

  const roleAgent: RoleAgentState = {
    roleId,
    roleLabel: requireString(role.label, `roles.${roleId}.label`),
    agentName,
    tabId: launched.tabId,
    paneId: launched.paneId,
    terminalId: launched.terminalId,
    createdAt: startedAt,
    updatedAt: startedAt,
  };

  return {
    handleState: saveRoleAgent(handleState, roleAgent),
    roleAgent,
  };
}

function rewritePendingArtifact(
  adapter: HerdrAdapter,
  state: WorkflowRunState,
  handleState: DaemonHandleState,
  pendingRun: PendingAgentRunState,
  phase: NormalizedPhase,
  reason: string,
  now: () => Date,
): { handleState: DaemonHandleState; state: WorkflowRunState; result: DaemonStepResult } {
  // Rewrite requests are best-effort: if we cannot target the same agent, we
  // still persist the failure context and stop cleanly.
  const agentName = agentTargetForPendingRun(state, handleState, pendingRun);
  if (!agentName) {
    const updatedAt = nowIso(now);
    const refreshed = withArtifactRewriteRequest(
      state,
      pendingRun,
      `unable to resolve agent target for rewrite: ${reason}`,
      updatedAt,
    );

    return {
      handleState,
      state: refreshed,
      result: {
        status: 'stop',
        currentPhase: pendingRun.phaseId,
        reason: `unable to resolve agent target for rewrite: ${reason}`,
      },
    };
  }

  const prompt = [
    `The result artifact at ${pendingRun.resultPath} is invalid.`,
    `Reason: ${reason}`,
    `Run id: ${pendingRun.runId}`,
    `Phase id: ${pendingRun.phaseId}`,
    `Role id: ${pendingRun.roleId}`,
    `Completion role: ${pendingRun.completionRole}`,
    `Expected outcome must be one of: ${Object.keys(phase.on).join(', ') || 'complete'}`,
    'Rewrite the JSON result artifact at the recorded path and then rerun the completion utility.',
  ].join('\n');

  try {
    adapter.sendPrompt(agentName, prompt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const updatedAt = nowIso(now);
    const refreshed = withArtifactRewriteRequest(
      state,
      pendingRun,
      `${reason}; rewrite request could not be delivered`,
      updatedAt,
    );

    return {
      handleState,
      state: refreshed,
      result: {
        status: 'stop',
        currentPhase: pendingRun.phaseId,
        reason: `unable to deliver artifact rewrite request for ${pendingRun.runId}: ${message}`,
      },
    };
  }

  const roleAgent = loadRoleAgent(handleState, pendingRun.roleId);
  if (roleAgent?.paneId) {
    try {
      adapter.submitPrompt(roleAgent.paneId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const updatedAt = nowIso(now);
      const refreshed = withArtifactRewriteRequest(
        state,
        pendingRun,
        `${reason}; rewrite completion delivery could not be delivered`,
        updatedAt,
      );

      return {
        handleState,
        state: refreshed,
        result: {
          status: 'stop',
          currentPhase: pendingRun.phaseId,
          reason: `unable to deliver rewrite completion to ${agentName}: ${message}`,
        },
      };
    }
  }

  const updatedAt = nowIso(now);
  const refreshed = withArtifactRewriteRequest(state, pendingRun, reason, updatedAt);

  return {
    handleState,
    state: refreshed,
    result: {
      status: 'sleep',
      currentPhase: pendingRun.phaseId,
      reason: `requested artifact rewrite for ${pendingRun.runId}`,
    },
  };
}

function processPendingAgentRun(
  adapter: HerdrAdapter,
  state: WorkflowRunState,
  handleState: DaemonHandleState,
  now: () => Date,
): { state: WorkflowRunState; result: DaemonStepResult } {
  const pendingRun = state.pendingAgentRun;
  if (!pendingRun) {
    return {
      state,
      result: {
        status: 'sleep',
        currentPhase: state.currentPhase,
        reason: `waiting on ${state.currentPhase}`,
      },
    };
  }

  const phase = state.workflow.phases[pendingRun.phaseId];
  if (!phase || phase.type !== 'agent') {
    throw new Error(`phase ${pendingRun.phaseId} is not an agent phase`);
  }

  // A pending run that already landed in acceptedAgentRuns is a duplicate
  // notification for a visit we have already recorded; keep routing stable.
  if (state.acceptedAgentRuns[pendingRun.runId]) {
    const updatedAt = nowIso(now);
    const acceptedRun = state.acceptedAgentRuns[pendingRun.runId];
    const refreshed = {
      ...state,
      currentPhase: resolveNextPhase(state.workflow, acceptedRun.phaseId, acceptedRun.outcome) ?? state.currentPhase,
      pendingAgentRun: null,
      updatedAt,
    };

    return {
      state: refreshed,
      result: {
        status: 'sleep',
        currentPhase: pendingRun.phaseId,
        nextPhase: refreshed.currentPhase,
        reason: `duplicate completion ignored for ${pendingRun.runId}`,
      },
    };
  }

  const evaluated = evaluateResultArtifact({
    resultPath: pendingRun.resultPath,
    pendingRun,
    phase,
  });

  if (evaluated.kind === 'accepted') {
    const acceptedAt = nowIso(now);
    const updatedState = applyAcceptedResultArtifact(state, pendingRun, evaluated.artifact, acceptedAt);

    return {
      state: updatedState,
      result: {
        status: 'continue',
        currentPhase: pendingRun.phaseId,
        nextPhase: updatedState.currentPhase,
        reason: createAcceptedResultArtifactSummary(evaluated.artifact, pendingRun),
      },
    };
  }

  if (evaluated.kind === 'stale') {
    const updatedAt = nowIso(now);
    const refreshed = {
      ...state,
      updatedAt,
      context: {
        ...state.context,
        lastRejectedAgentResult: {
          runId: evaluated.artifact.runId,
          expectedRunId: pendingRun.runId,
          phaseId: pendingRun.phaseId,
          roleId: pendingRun.roleId,
          reason: evaluated.reason,
          rejectedAt: updatedAt,
        },
      },
    };

    return rewritePendingArtifact(adapter, refreshed, handleState, pendingRun, phase, evaluated.reason, now);
  }

  if (evaluated.kind === 'invalid') {
    return rewritePendingArtifact(adapter, state, handleState, pendingRun, phase, evaluated.reason, now);
  }

  const agentName = agentTargetForPendingRun(state, handleState, pendingRun);
  if (!agentName) {
    const updatedAt = nowIso(now);
    const refreshed = {
      ...state,
      updatedAt,
      context: {
        ...state.context,
        missingAgentRecovery: {
          runId: pendingRun.runId,
          phaseId: pendingRun.phaseId,
          roleId: pendingRun.roleId,
          recoveredAt: updatedAt,
          reason: 'unable to resolve agent target',
        },
      },
    };
    const blockedPhase = resolveNextPhase(state.workflow, pendingRun.phaseId, 'blocked');
    if (blockedPhase) {
      return {
        state: {
          ...refreshed,
          currentPhase: blockedPhase,
          pendingAgentRun: null,
        },
        result: {
          status: 'continue',
          currentPhase: pendingRun.phaseId,
          nextPhase: blockedPhase,
          reason: `missing agent target for ${pendingRun.runId}`,
        },
      };
    }

    return {
      state: refreshed,
      result: {
        status: 'stop',
        currentPhase: pendingRun.phaseId,
        reason: `missing agent target for ${pendingRun.runId}`,
      },
    };
  }

  const agentInfo = adapter.getAgentStatus(agentName);
  const updatedAt = nowIso(now);

  if (agentInfo.status === 'working') {
    return {
      state: {
        ...state,
        updatedAt,
      },
      result: {
        status: 'sleep',
        currentPhase: pendingRun.phaseId,
        reason: `waiting on agent run ${pendingRun.runId}`,
      },
    };
  }

  if (agentInfo.status === 'blocked') {
    const blockedPhase = resolveNextPhase(state.workflow, pendingRun.phaseId, 'blocked');
    const refreshed = {
      ...state,
      updatedAt,
      context: {
        ...state.context,
        blockedAgentObservation: {
          runId: pendingRun.runId,
          phaseId: pendingRun.phaseId,
          roleId: pendingRun.roleId,
          agentName,
          observedAt: updatedAt,
        },
      },
      pendingAgentRun: null,
      currentPhase: blockedPhase ?? state.currentPhase,
    };
    if (blockedPhase) {
      return {
        state: refreshed,
        result: {
          status: 'continue',
          currentPhase: pendingRun.phaseId,
          nextPhase: blockedPhase,
          reason: `agent ${agentName} reported blocked`,
        },
      };
    }

    return {
      state: refreshed,
      result: {
        status: 'stop',
        currentPhase: pendingRun.phaseId,
        reason: `agent ${agentName} reported blocked`,
      },
    };
  }

  if (agentInfo.status === 'missing') {
    const blockedPhase = resolveNextPhase(state.workflow, pendingRun.phaseId, 'blocked');
    const refreshed = {
      ...state,
      updatedAt,
      context: {
        ...state.context,
        missingAgentRecovery: {
          runId: pendingRun.runId,
          phaseId: pendingRun.phaseId,
          roleId: pendingRun.roleId,
          agentName,
          recoveredAt: updatedAt,
          reason: 'agent target missing after handle recovery',
        },
      },
      pendingAgentRun: blockedPhase ? null : state.pendingAgentRun,
      currentPhase: blockedPhase ?? state.currentPhase,
    };
    return {
      state: refreshed,
      result: {
        status: blockedPhase ? 'continue' : 'stop',
        currentPhase: pendingRun.phaseId,
        nextPhase: blockedPhase ?? undefined,
        reason: `agent target missing for ${pendingRun.runId}`,
      },
    };
  }

  if (agentInfo.status === 'idle' || agentInfo.status === 'unknown') {
    const existingIdleRecovery = isRecord(state.context.idleAgentRecovery) ? state.context.idleAgentRecovery : null;
    if (optionalTrimmedString(existingIdleRecovery?.runId) === pendingRun.runId) {
      const blockedPhase = resolveNextPhase(state.workflow, pendingRun.phaseId, 'blocked');
      const refreshed = {
        ...state,
        updatedAt,
        pendingAgentRun: blockedPhase ? null : state.pendingAgentRun,
        currentPhase: blockedPhase ?? state.currentPhase,
      };
      return {
        state: refreshed,
        result: {
          status: blockedPhase ? 'continue' : 'stop',
          currentPhase: pendingRun.phaseId,
          nextPhase: blockedPhase ?? undefined,
          reason: `agent ${agentName} remained ${agentInfo.status} without a valid result artifact`,
        },
      };
    }

    const transcript = adapter.readAgentTranscript(agentName);
    const refreshed = {
      ...state,
      updatedAt,
      context: {
        ...state.context,
        idleAgentRecovery: {
          runId: pendingRun.runId,
          phaseId: pendingRun.phaseId,
          roleId: pendingRun.roleId,
          agentName,
          status: agentInfo.status,
          observedAt: updatedAt,
          transcript: transcript ?? null,
        },
      },
    };

    return rewritePendingArtifact(adapter, refreshed, handleState, pendingRun, phase, 'agent is idle without a valid result artifact', now);
  }

  return {
    state: {
      ...state,
      updatedAt,
    },
    result: {
      status: 'sleep',
      currentPhase: pendingRun.phaseId,
      reason: `waiting on agent run ${pendingRun.runId}`,
    },
  };
}

function dispatchAgentPhase(
  adapter: HerdrAdapter,
  cwd: string,
  state: WorkflowRunState,
  handleState: DaemonHandleState,
  now: () => Date,
): { state: WorkflowRunState; handleState: DaemonHandleState; result: DaemonStepResult } {
  const phaseId = state.currentPhase;
  const phase = state.workflow.phases[phaseId];
  if (!phase || phase.type !== 'agent') {
    throw new Error(`phase ${phaseId} is not an agent phase`);
  }

  const roleId = requireString(phase.role, `phases.${phaseId}.role`);
  const role = state.workflow.roles[roleId];
  if (!role) {
    throw new Error(`phase ${phaseId} references unknown role: ${roleId}`);
  }

  const reuseRole = optionalBoolean(role.reuse) ?? true;
  const attemptNumber = nextAgentAttemptNumber(state, phaseId, roleId);
  const startedAt = nowIso(now);
  const baseAgentName = renderAgentName(requireString(role.agentNameTemplate, `roles.${roleId}.agentNameTemplate`), state, roleId);
  // Each loop through the same phase/role gets a distinct run id so a later
  // revisit can be distinguished from any earlier accepted completion.
  const runId = buildAgentRunId(state, `${phaseId}-${roleId}`, attemptNumber);
  const agentName = reuseRole ? baseAgentName : `${baseAgentName}-${runId}`;
  const pendingRun = createPendingAgentRun(
    state,
    runId,
    phaseId,
    roleId,
    completionRoleFor(roleId),
    requireString(role.label, `roles.${roleId}.label`),
    agentName,
    optionalTrimmedString(phase.resultSchema),
    attemptNumber,
    startedAt,
  );
  const reusedRole = reuseRole ? loadRoleAgent(handleState, roleId) : null;
  let nextHandleState = handleState;
  let roleAgent = reusedRole;
  if (!roleAgent) {
    const launched = launchRoleAgent(adapter, state, nextHandleState, phaseId, roleId, agentName, now);
    nextHandleState = launched.handleState;
    roleAgent = launched.roleAgent;
  }

  if (!roleAgent?.agentName || !roleAgent.paneId) {
    throw new Error(`role ${roleId} is missing Herdr agent handles`);
  }

  const prompt = renderAgentPhasePrompt(cwd, state, phaseId, roleId, pendingRun);

  adapter.sendPrompt(roleAgent.agentName, prompt);
  adapter.submitPrompt(roleAgent.paneId);

  const updatedRunState: WorkflowRunState = {
    ...state,
    updatedAt: startedAt,
    pendingAgentRun: {
      ...pendingRun,
      status: 'pending',
    },
  };
  const updatedRoleAgent: RoleAgentState = {
    ...roleAgent,
    updatedAt: startedAt,
  };
  nextHandleState = reuseRole ? saveRoleAgent(nextHandleState, updatedRoleAgent) : nextHandleState;

  return {
    state: updatedRunState,
    handleState: nextHandleState,
    result: {
      status: 'sleep',
      currentPhase: phaseId,
      reason: `waiting for agent run ${pendingRun.runId}`,
    },
  };
}

function resolveNextPhase(workflow: NormalizedWorkflow, phaseName: string, outcome: string): string | null {
  const phase = workflow.phases[phaseName];
  if (!phase) {
    return null;
  }

  return phase.on[outcome] ?? null;
}

export function advanceAgentWorkOnce(options: AgentLifecycleOptions): AgentLifecycleResult {
  if (options.state.pendingAgentRun) {
    const processed = processPendingAgentRun(options.adapter, options.state, options.handleState, options.now);
    return {
      state: processed.state,
      handleState: options.handleState,
      result: processed.result,
    };
  }

  const phase = options.state.workflow.phases[options.state.currentPhase];
  if (phase?.type === 'agent') {
    return dispatchAgentPhase(options.adapter, options.cwd, options.state, options.handleState, options.now);
  }

  return {
    state: options.state,
    handleState: options.handleState,
    result: {
      status: 'sleep',
      currentPhase: options.state.currentPhase,
      reason: `waiting on ${options.state.currentPhase}`,
    },
  };
}
