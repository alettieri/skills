import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { loadWorkflow } from './workflow.ts';
import type { NormalizedPhase, NormalizedWorkflow } from './workflow.ts';
import { createHerdrAdapter, type HerdrAdapter } from './herdr-adapter.ts';
import {
  executeScriptPhase,
  normalizeScriptRunMap,
  recoverCompletedScriptPhase,
  type ScriptRunState,
} from './script-phase.ts';
import { advanceAgentWorkOnce } from './agent-lifecycle.ts';

export const RUN_STATE_PATH = '.agent/herdr-workflow-run.json';
export const HANDLE_STATE_PATH = '.agent/herdr-implement.json';
export const DEFAULT_DAEMON_LABEL = 'herdr-implement-daemon';

export type HerdrCommandResult = {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: Error;
};

export type HerdrCommandRunner = {
  run(args: string[]): HerdrCommandResult;
};

export type IssueReference = {
  input: string;
  number: number | null;
  url: string | null;
  canonical: string;
};

export type RepositoryInfo = {
  rootPath: string;
  remoteUrl: string | null;
  currentBranch: string;
  baseBranch: string;
};

export type WorktreeInfo = {
  workspaceId: string;
  worktreePath: string;
  branchName: string;
};

export type PendingAgentRunState = {
  runId: string;
  phaseId: string;
  roleId: string;
  completionRole: 'implementer' | 'reviewer';
  roleLabel: string | null;
  agentName: string | null;
  resultSchema: string | null;
  resultPath: string;
  notifyTarget: string;
  attemptNumber: number;
  startedAt: string;
  status: 'pending';
};

export type AcceptedAgentRunState = {
  runId: string;
  phaseId: string;
  roleId: string;
  roleLabel: string | null;
  agentName: string | null;
  resultSchema: string | null;
  resultPath: string;
  acceptedAt: string;
  status: 'complete' | 'blocked' | 'failed';
  outcome: string;
  summary: string | null;
  capture: Record<string, unknown> | null;
};

export type RoleAgentState = {
  roleId: string;
  roleLabel: string;
  agentName: string;
  tabId: string | null;
  paneId: string | null;
  terminalId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DaemonHandleState = {
  schemaVersion: 1;
  runStatePath: string;
  workspaceId: string;
  worktreePath: string;
  daemonTabId: string | null;
  daemonPaneId: string | null;
  daemonCommand: string | null;
  roleAgents: Record<string, RoleAgentState>;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowRunState = {
  schemaVersion: 1;
  issue: IssueReference;
  workflowPath: string;
  workflow: NormalizedWorkflow;
  sourceRepo: RepositoryInfo;
  branchName: string;
  worktreePath: string;
  workspaceId: string;
  currentPhase: string;
  context: Record<string, unknown>;
  pendingAgentRun: PendingAgentRunState | null;
  acceptedAgentRuns: Record<string, AcceptedAgentRunState>;
  scriptRuns: Record<string, ScriptRunState>;
  createdAt: string;
  updatedAt: string;
  daemonHandlePath: string;
  daemon: {
    tabId: string | null;
    paneId: string | null;
    command: string | null;
    startedAt: string | null;
  };
};

export type BootstrapOptions = {
  cwd?: string;
  issue: string;
  runner?: HerdrCommandRunner;
  adapter?: HerdrAdapter;
  now?: () => Date;
};

export type BootstrapResult = {
  issue: IssueReference;
  workflowPath: string;
  workspaceId: string;
  worktreePath: string;
  branchName: string;
  runStatePath: string;
  handleStatePath: string;
  daemonCommand: string;
  daemonTabId: string | null;
  daemonPaneId: string | null;
  createdRunState: boolean;
  createdHandleState: boolean;
};

export type DaemonStepResult = {
  status: 'continue' | 'sleep' | 'stop';
  currentPhase: string;
  nextPhase?: string;
  reason?: string;
};

export type DaemonOptions = {
  cwd?: string;
  statePath?: string;
  handleStatePath?: string;
  runner?: HerdrCommandRunner;
  adapter?: HerdrAdapter;
  now?: () => Date;
  sleepMs?: number;
};

function resolveHerdrAdapter(options: { runner?: HerdrCommandRunner; adapter?: HerdrAdapter }): HerdrAdapter {
  return options.adapter ?? createHerdrAdapter(options.runner);
}

type ResultArtifact = {
  schemaVersion: number;
  runId: string;
  role: string;
  phase: string;
  status: 'complete' | 'blocked' | 'failed';
  outcome: string;
  capture: Record<string, unknown> | null;
  summary: string | null;
  payload: Record<string, unknown> | null;
  resultSchema: string | null;
};

function nowIso(now?: () => Date): string {
  return (now?.() ?? new Date()).toISOString();
}

function ensureDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function readJsonFile(path: string): unknown | null {
  if (!existsSync(path)) {
    return null;
  }

  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function writeJsonFile(path: string, value: unknown): void {
  ensureDir(path);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') {
    return value.trim();
  }
  return null;
}

function requireString(value: unknown, field: string): string {
  const stringValue = optionalString(value);
  if (!stringValue) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return stringValue;
}

function optionalBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value;
  }
  return null;
}

function completionRoleFor(roleId: string): 'implementer' | 'reviewer' {
  return roleId === 'reviewer' ? 'reviewer' : 'implementer';
}

function normalizeCapture(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }

  const capture: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof key !== 'string') {
      return null;
    }
    capture[key] = entry;
  }
  return capture;
}

function mergeCaptureIntoContext(
  context: Record<string, unknown>,
  capture: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!capture) {
    return context;
  }

  return {
    ...context,
    ...capture,
  };
}

function runGit(args: string[], cwd: string): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed with exit ${result.status}: ${result.stderr.trim()}`);
  }

  return result.stdout.trim();
}

function detectRepositoryInfo(cwd: string): RepositoryInfo {
  const rootPath = runGit(['rev-parse', '--show-toplevel'], cwd);
  const currentBranch = runGit(['branch', '--show-current'], rootPath) || 'main';

  let baseBranch = 'main';
  try {
    const symbolic = runGit(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], rootPath);
    baseBranch = symbolic.includes('/') ? symbolic.split('/').pop() ?? 'main' : symbolic;
  } catch {
    baseBranch = 'main';
  }

  let remoteUrl: string | null = null;
  try {
    remoteUrl = optionalString(runGit(['remote', 'get-url', 'origin'], rootPath));
  } catch {
    remoteUrl = null;
  }

  return {
    rootPath,
    remoteUrl,
    currentBranch,
    baseBranch,
  };
}

function normalizeIssueReference(input: string): IssueReference {
  const trimmed = input.trim();
  const numberMatch = trimmed.match(/^#?(\d+)$/);
  if (numberMatch) {
    const number = Number(numberMatch[1]);
    return {
      input,
      number,
      url: null,
      canonical: `#${number}`,
    };
  }

  const urlMatch = trimmed.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)$/);
  if (urlMatch) {
    const number = Number(urlMatch[3]);
    return {
      input,
      number,
      url: trimmed,
      canonical: trimmed,
    };
  }

  throw new Error('issue must be an issue number, #number, or GitHub issue URL');
}

function ensureDaemonCommand(worktreePath: string): string {
  return `node skills/herdr-implement/scripts/daemon.ts --worktree ${JSON.stringify(worktreePath)} --state ${RUN_STATE_PATH} --handles ${HANDLE_STATE_PATH}`;
}

function statePathsFor(worktreePath: string): { runStatePath: string; handleStatePath: string } {
  return {
    runStatePath: join(worktreePath, RUN_STATE_PATH),
    handleStatePath: join(worktreePath, HANDLE_STATE_PATH),
  };
}

function loadRunState(path: string): WorkflowRunState | null {
  const value = readJsonFile(path);
  if (!value) {
    return null;
  }
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error(`invalid workflow run state at ${path}`);
  }
  return normalizeWorkflowRunState(value as Record<string, unknown>);
}

function loadHandleState(path: string): DaemonHandleState | null {
  const value = readJsonFile(path);
  if (!value) {
    return null;
  }
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error(`invalid daemon handle state at ${path}`);
  }
  return {
    ...(value as DaemonHandleState),
    roleAgents: normalizeRoleAgentMap(value.roleAgents),
  };
}

function saveRunState(path: string, state: WorkflowRunState): void {
  writeJsonFile(path, state);
}

function saveHandleState(path: string, state: DaemonHandleState): void {
  writeJsonFile(path, state);
}

function normalizePendingAgentRun(value: unknown): PendingAgentRunState | null {
  if (!isRecord(value)) {
    return null;
  }

  const runId = optionalString(value.runId);
  const phaseId = optionalString(value.phaseId);
  const roleId = optionalString(value.roleId);
  const completionRole =
    value.completionRole === 'implementer' || value.completionRole === 'reviewer'
      ? value.completionRole
      : roleId
        ? completionRoleFor(roleId)
        : null;
  const roleLabel = optionalString(value.roleLabel);
  const agentName = optionalString(value.agentName);
  const resultSchema = optionalString(value.resultSchema);
  const resultPath = optionalString(value.resultPath);
  const notifyTarget = optionalString(value.notifyTarget);
  const status = value.status === 'pending' ? value.status : null;
  const attemptNumber = typeof value.attemptNumber === 'number' && Number.isFinite(value.attemptNumber) ? value.attemptNumber : null;
  const startedAt = optionalString(value.startedAt);

  if (
    !runId ||
    !phaseId ||
    !roleId ||
    !completionRole ||
    !resultPath ||
    !notifyTarget ||
    !status ||
    attemptNumber === null ||
    !startedAt
  ) {
    return null;
  }

  return {
    runId,
    phaseId,
    roleId,
    completionRole,
    roleLabel,
    agentName,
    resultSchema,
    resultPath,
    notifyTarget,
    attemptNumber,
    startedAt,
    status,
  };
}

function normalizeAcceptedAgentRun(value: unknown): AcceptedAgentRunState | null {
  if (!isRecord(value)) {
    return null;
  }

  const runId = optionalString(value.runId);
  const phaseId = optionalString(value.phaseId);
  const roleId = optionalString(value.roleId);
  const resultPath = optionalString(value.resultPath);
  const acceptedAt = optionalString(value.acceptedAt);
  const status =
    value.status === 'complete' || value.status === 'blocked' || value.status === 'failed' ? value.status : null;
  const outcome = optionalString(value.outcome);
  const summary = optionalString(value.summary);
  const roleLabel = optionalString(value.roleLabel);
  const agentName = optionalString(value.agentName);
  const resultSchema = optionalString(value.resultSchema);
  const capture = value.capture === undefined ? null : normalizeCapture(value.capture);

  if (!runId || !phaseId || !roleId || !resultPath || !acceptedAt || !status || !outcome) {
    return null;
  }

  return {
    runId,
    phaseId,
    roleId,
    roleLabel,
    agentName,
    resultSchema,
    resultPath,
    acceptedAt,
    status,
    outcome,
    summary,
    capture,
  };
}

function normalizeAcceptedAgentRunMap(value: unknown): Record<string, AcceptedAgentRunState> {
  if (!isRecord(value)) {
    return {};
  }

  const result: Record<string, AcceptedAgentRunState> = {};
  for (const [runId, runValue] of Object.entries(value)) {
    const normalized = normalizeAcceptedAgentRun(runValue);
    if (normalized) {
      result[runId] = normalized;
    }
  }

  return result;
}

function normalizeWorkflowRunState(value: Record<string, unknown>): WorkflowRunState {
  const context = isRecord(value.context) ? { ...value.context } : {};
  return {
    ...(value as WorkflowRunState),
    pendingAgentRun: normalizePendingAgentRun(value.pendingAgentRun),
    acceptedAgentRuns: normalizeAcceptedAgentRunMap(value.acceptedAgentRuns),
    scriptRuns: normalizeScriptRunMap(value.scriptRuns),
    context,
  };
}

function normalizeRoleAgentMap(value: unknown): Record<string, RoleAgentState> {
  if (!isRecord(value)) {
    return {};
  }

  const result: Record<string, RoleAgentState> = {};
  for (const [roleId, roleValue] of Object.entries(value)) {
    if (!isRecord(roleValue)) {
      continue;
    }

    const roleLabel = optionalString(roleValue.roleLabel);
    const agentName = optionalString(roleValue.agentName);
    const tabId = optionalString(roleValue.tabId);
    const paneId = optionalString(roleValue.paneId);
    const terminalId = optionalString(roleValue.terminalId);
    const createdAt = optionalString(roleValue.createdAt);
    const updatedAt = optionalString(roleValue.updatedAt);

    if (!roleLabel || !agentName || !createdAt || !updatedAt) {
      continue;
    }

    result[roleId] = {
      roleId,
      roleLabel,
      agentName,
      tabId,
      paneId,
      terminalId,
      createdAt,
      updatedAt,
    };
  }

  return result;
}

function createWorktreeIfNeeded(
  adapter: HerdrAdapter,
  repository: RepositoryInfo,
  branchName: string,
  issueLabel: string,
): WorktreeInfo {
  return adapter.ensureWorktree(repository, branchName, issueLabel);
}

function createDaemonPane(
  adapter: HerdrAdapter,
  workspaceId: string,
  worktreePath: string,
  daemonCommand: string,
): { tabId: string | null; paneId: string | null } {
  const { tabId, paneId } = adapter.createDaemonPane(workspaceId, worktreePath);
  if (!paneId) {
    throw new Error('herdr createDaemonPane did not include a pane id');
  }
  adapter.runPaneCommand(paneId, daemonCommand);

  return { tabId, paneId };
}

export function bootstrap(options: BootstrapOptions): BootstrapResult {
  const adapter = resolveHerdrAdapter(options);

  const cwd = resolve(options.cwd ?? process.cwd());
  const issue = normalizeIssueReference(options.issue);
  const repository = detectRepositoryInfo(cwd);
  const workflowSource = loadWorkflow(cwd);
  const branchName = issue.number === null ? 'issue-bootstrap' : `issue-${issue.number}-herdr-implement`;
  const worktree = createWorktreeIfNeeded(adapter, repository, branchName, `issue-${issue.number ?? 'bootstrap'}`);
  const { runStatePath, handleStatePath } = statePathsFor(worktree.worktreePath);
  const existingRunState = loadRunState(runStatePath);
  const existingHandleState = loadHandleState(handleStatePath);

  if (existingRunState && existingRunState.issue.canonical !== issue.canonical) {
    throw new Error(
      `existing run state belongs to ${existingRunState.issue.canonical}, not ${issue.canonical}`,
    );
  }

  if (existingRunState && existingRunState.branchName !== branchName) {
    throw new Error(`existing run state branch mismatch: expected ${branchName}, found ${existingRunState.branchName}`);
  }

  if (existingRunState && existingHandleState?.daemonTabId && existingHandleState.daemonPaneId) {
    return {
      issue,
      workflowPath: workflowSource.path,
      workspaceId: existingRunState.workspaceId,
      worktreePath: existingRunState.worktreePath,
      branchName: existingRunState.branchName,
      runStatePath,
      handleStatePath,
      daemonCommand: existingRunState.daemon.command ?? ensureDaemonCommand(existingRunState.worktreePath),
      daemonTabId: existingHandleState.daemonTabId,
      daemonPaneId: existingHandleState.daemonPaneId,
      createdRunState: false,
      createdHandleState: false,
    };
  }

  if (existingRunState) {
    const daemonCommand = existingRunState.daemon.command ?? ensureDaemonCommand(existingRunState.worktreePath);
    const handleState: DaemonHandleState = existingHandleState ?? {
      schemaVersion: 1,
      runStatePath,
      workspaceId: existingRunState.workspaceId,
      worktreePath: existingRunState.worktreePath,
      daemonTabId: null,
      daemonPaneId: null,
      daemonCommand,
      roleAgents: {},
      createdAt: existingRunState.createdAt,
      updatedAt: existingRunState.updatedAt,
    };

    saveHandleState(handleStatePath, handleState);

    const { tabId, paneId } = createDaemonPane(
      adapter,
      existingRunState.workspaceId,
      existingRunState.worktreePath,
      daemonCommand,
    );
    const startedAt = nowIso(options.now);
    const updatedRunState: WorkflowRunState = {
      ...existingRunState,
      updatedAt: startedAt,
      daemon: {
        tabId,
        paneId,
        command: daemonCommand,
        startedAt,
      },
    };
    saveRunState(runStatePath, updatedRunState);

    const updatedHandleState: DaemonHandleState = {
      ...handleState,
      daemonTabId: tabId,
      daemonPaneId: paneId,
      daemonCommand,
      updatedAt: startedAt,
    };
    saveHandleState(handleStatePath, updatedHandleState);

    return {
      issue,
      workflowPath: workflowSource.path,
      workspaceId: existingRunState.workspaceId,
      worktreePath: existingRunState.worktreePath,
      branchName: existingRunState.branchName,
      runStatePath,
      handleStatePath,
      daemonCommand,
      daemonTabId: tabId,
      daemonPaneId: paneId,
      createdRunState: false,
      createdHandleState: existingHandleState === null,
    };
  }

  const daemonCommand = ensureDaemonCommand(worktree.worktreePath);
  const createdAt = nowIso(options.now);
  const runState: WorkflowRunState = {
    schemaVersion: 1,
    issue,
    workflowPath: workflowSource.path,
    workflow: workflowSource.workflow,
    sourceRepo: repository,
    branchName,
    worktreePath: worktree.worktreePath,
    workspaceId: worktree.workspaceId,
    currentPhase: workflowSource.workflow.start,
    context: {
      bootstrap: {
        createdAt,
        sourceRepoPath: repository.rootPath,
        worktreePath: worktree.worktreePath,
      },
    },
    pendingAgentRun: null,
    acceptedAgentRuns: {},
    scriptRuns: {},
    createdAt,
    updatedAt: createdAt,
    daemonHandlePath: handleStatePath,
    daemon: {
      tabId: null,
      paneId: null,
      command: null,
      startedAt: null,
    },
  };

  saveRunState(runStatePath, runState);

  const handleState: DaemonHandleState = {
    schemaVersion: 1,
    runStatePath,
    workspaceId: worktree.workspaceId,
    worktreePath: worktree.worktreePath,
    daemonTabId: null,
    daemonPaneId: null,
    daemonCommand,
    roleAgents: {},
    createdAt,
    updatedAt: createdAt,
  };

  saveHandleState(handleStatePath, handleState);

  const { tabId, paneId } = createDaemonPane(adapter, worktree.workspaceId, worktree.worktreePath, daemonCommand);
  const startedAt = nowIso(options.now);
  runState.updatedAt = startedAt;
  runState.daemon = {
    tabId,
    paneId,
    command: daemonCommand,
    startedAt,
  };
  saveRunState(runStatePath, runState);

  handleState.daemonTabId = tabId;
  handleState.daemonPaneId = paneId;
  handleState.updatedAt = startedAt;
  saveHandleState(handleStatePath, handleState);

  return {
    issue,
    workflowPath: workflowSource.path,
    workspaceId: worktree.workspaceId,
    worktreePath: worktree.worktreePath,
    branchName,
    runStatePath,
    handleStatePath,
    daemonCommand,
    daemonTabId: tabId,
    daemonPaneId: paneId,
    createdRunState: true,
    createdHandleState: true,
  };
}

function isTerminalPhase(workflow: NormalizedWorkflow, phaseName: string): boolean {
  const phase = workflow.phases[phaseName];
  return phase?.type === 'terminal';
}

function resolveNextPhase(workflow: NormalizedWorkflow, phaseName: string, outcome: string): string | null {
  const phase = workflow.phases[phaseName];
  if (!phase) {
    return null;
  }

  return phase.on[outcome] ?? null;
}

function advanceInitialPhase(state: WorkflowRunState): WorkflowRunState {
  if (state.currentPhase === state.workflow.start && state.workflow.phases[state.currentPhase]?.type === 'herdr-worktree') {
    const nextPhase = resolveNextPhase(state.workflow, state.currentPhase, 'success');
    if (nextPhase) {
      const updatedAt = new Date().toISOString();
      return {
        ...state,
        currentPhase: nextPhase,
        updatedAt,
      };
    }
  }

  return state;
}

export function daemonStep(options: DaemonOptions): DaemonStepResult {
  const cwd = resolve(options.cwd ?? process.cwd());
  const statePath = options.statePath ? resolve(cwd, options.statePath) : join(cwd, RUN_STATE_PATH);
  const handleStatePath = options.handleStatePath ? resolve(cwd, options.handleStatePath) : join(cwd, HANDLE_STATE_PATH);
  const now = options.now ?? (() => new Date());
  const adapter = resolveHerdrAdapter(options);
  const state = loadRunState(statePath);
  const handleState = loadHandleState(handleStatePath);

  if (!state) {
    throw new Error(`workflow run state does not exist: ${statePath}`);
  }

  if (!handleState) {
    throw new Error(`daemon handle state does not exist: ${handleStatePath}`);
  }

  if (isTerminalPhase(state.workflow, state.currentPhase)) {
    const updatedAt = nowIso(now);
    saveRunState(statePath, { ...state, updatedAt });
    return {
      status: 'stop',
      currentPhase: state.currentPhase,
      reason: 'terminal phase reached',
    };
  }

  const advanced = advanceInitialPhase(state);
  if (advanced !== state) {
    saveRunState(statePath, advanced);
    return {
      status: 'continue',
      currentPhase: state.currentPhase,
      nextPhase: advanced.currentPhase,
      reason: `advanced from ${state.currentPhase} to ${advanced.currentPhase}`,
    };
  }

  const recoveredScriptState = recoverCompletedScriptPhase(advanced);
  if (recoveredScriptState) {
    saveRunState(statePath, recoveredScriptState.state);
    return {
      status: recoveredScriptState.nextPhase ? 'continue' : 'stop',
      currentPhase: advanced.currentPhase,
      nextPhase: recoveredScriptState.nextPhase ?? undefined,
      reason: `recovered completed script phase ${advanced.currentPhase}`,
    };
  }

  const currentPhase = advanced.currentPhase;
  const phase = advanced.workflow.phases[currentPhase];
  if (advanced.pendingAgentRun !== null || phase?.type === 'agent') {
    const advancedAgent = advanceAgentWorkOnce({
      cwd,
      state: advanced,
      handleState,
      adapter,
      now,
    });
    saveRunState(statePath, advancedAgent.state);
    saveHandleState(handleStatePath, advancedAgent.handleState);
    return advancedAgent.result;
  }

  if (phase?.type === 'script') {
    const executed = executeScriptPhase({ state: advanced, phaseId: currentPhase, phase });
    const updatedAt = executed.record.finishedAt;
    const updatedState: WorkflowRunState = {
      ...advanced,
      currentPhase: executed.nextPhase ?? advanced.currentPhase,
      scriptRuns: {
        ...advanced.scriptRuns,
        [currentPhase]: executed.record,
      },
      updatedAt,
      context: mergeCaptureIntoContext(advanced.context, executed.record.capture),
    };
    saveRunState(statePath, updatedState);
    return {
      status: executed.nextPhase ? 'continue' : 'stop',
      currentPhase,
      nextPhase: executed.nextPhase ?? undefined,
      reason: `script phase ${currentPhase} completed with ${executed.record.outcome}`,
    };
  }

  const refreshed = {
    ...advanced,
    updatedAt: nowIso(now),
  };
  saveRunState(statePath, refreshed);

  return {
    status: 'sleep',
    currentPhase,
    reason: `waiting on ${currentPhase}`,
  };
}

export async function runDaemonLoop(options: DaemonOptions): Promise<void> {
  const sleepMs = options.sleepMs ?? 1000;

  while (true) {
    const result = daemonStep(options);
    if (result.status === 'stop') {
      return;
    }
    if (result.status === 'continue') {
      continue;
    }

    await delay(sleepMs);
  }
}

export function printBootstrapSummary(result: BootstrapResult): string {
  return JSON.stringify(
    {
      issue: result.issue.canonical,
      workflowPath: result.workflowPath,
      workspaceId: result.workspaceId,
      worktreePath: result.worktreePath,
      branchName: result.branchName,
      runStatePath: result.runStatePath,
      handleStatePath: result.handleStatePath,
      daemonTabId: result.daemonTabId,
      daemonPaneId: result.daemonPaneId,
      daemonCommand: result.daemonCommand,
      createdRunState: result.createdRunState,
      createdHandleState: result.createdHandleState,
    },
    null,
    2,
  );
}

export function printDaemonStep(result: DaemonStepResult): string {
  return JSON.stringify(result, null, 2);
}

export function createFakeRunner(responses: Array<{ args: string[]; result: HerdrCommandResult }>): HerdrCommandRunner {
  let index = 0;
  return {
    run(args: string[]): HerdrCommandResult {
      assert.equal(index < responses.length, true, `unexpected herdr command: ${args.join(' ')}`);
      const expected = responses[index];
      index += 1;
      assert.deepEqual(args, expected.args);
      return expected.result;
    },
  };
}

export function writeWorkflowRunState(path: string, state: WorkflowRunState): void {
  saveRunState(path, state);
}

export function writeDaemonHandleState(path: string, state: DaemonHandleState): void {
  saveHandleState(path, state);
}

export function readWorkflowRunState(path: string): WorkflowRunState | null {
  return loadRunState(path);
}

export function readDaemonHandleState(path: string): DaemonHandleState | null {
  return loadHandleState(path);
}
