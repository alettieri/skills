import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { loadWorkflow } from './workflow.ts';
import { createHerdrAdapter, type HerdrAdapter } from './herdr-adapter.ts';
import { mergeCaptureIntoContext } from './capture.ts';
import { isTerminalPhase, resolveNextPhase } from './workflow-transition.ts';
import { executeScriptPhase, recoverCompletedScriptPhase } from './script-phase.ts';
import { advancePollWorkOnce } from './poll-phase.ts';
import { advanceAgentWorkOnce } from './agent-lifecycle.ts';
import { optionalTrimmedString } from './validation.ts';
import {
  DAEMON_HANDLE_STATE_PATH,
  WORKFLOW_RUN_STATE_PATH,
  readDaemonHandleState,
  readWorkflowRunState,
  workflowStatePathsFor,
  writeDaemonHandleState,
  writeWorkflowRunState,
  type AcceptedAgentRunState,
  type DaemonHandleState,
  type IssueReference,
  type PendingAgentRunState,
  type RepositoryInfo,
  type RoleAgentState,
  type WorkflowRunState,
} from './workflow-state-store.ts';

export const RUN_STATE_PATH = WORKFLOW_RUN_STATE_PATH;
export const HANDLE_STATE_PATH = DAEMON_HANDLE_STATE_PATH;
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

export type WorktreeInfo = {
  workspaceId: string;
  worktreePath: string;
  branchName: string;
};

export type { AcceptedAgentRunState, DaemonHandleState, IssueReference, PendingAgentRunState, RepositoryInfo, RoleAgentState, WorkflowRunState } from './workflow-state-store.ts';

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
    remoteUrl = optionalTrimmedString(runGit(['remote', 'get-url', 'origin'], rootPath));
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
  const { runStatePath, handleStatePath } = workflowStatePathsFor(worktree.worktreePath);
  const existingRunState = readWorkflowRunState(runStatePath);
  const existingHandleState = readDaemonHandleState(handleStatePath);

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

    writeDaemonHandleState(handleStatePath, handleState);

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
    writeWorkflowRunState(runStatePath, updatedRunState);

    const updatedHandleState: DaemonHandleState = {
      ...handleState,
      daemonTabId: tabId,
      daemonPaneId: paneId,
      daemonCommand,
      updatedAt: startedAt,
    };
    writeDaemonHandleState(handleStatePath, updatedHandleState);

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
    pollRuns: {},
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

  writeWorkflowRunState(runStatePath, runState);

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

  writeDaemonHandleState(handleStatePath, handleState);

  const { tabId, paneId } = createDaemonPane(adapter, worktree.workspaceId, worktree.worktreePath, daemonCommand);
  const startedAt = nowIso(options.now);
  runState.updatedAt = startedAt;
  runState.daemon = {
    tabId,
    paneId,
    command: daemonCommand,
    startedAt,
  };
  writeWorkflowRunState(runStatePath, runState);

  handleState.daemonTabId = tabId;
  handleState.daemonPaneId = paneId;
  handleState.updatedAt = startedAt;
  writeDaemonHandleState(handleStatePath, handleState);

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
  const state = readWorkflowRunState(statePath);
  const handleState = readDaemonHandleState(handleStatePath);

  if (!state) {
    throw new Error(`workflow run state does not exist: ${statePath}`);
  }

  if (!handleState) {
    throw new Error(`daemon handle state does not exist: ${handleStatePath}`);
  }

  if (isTerminalPhase(state.workflow, state.currentPhase)) {
    const updatedAt = nowIso(now);
    writeWorkflowRunState(statePath, { ...state, updatedAt });
    return {
      status: 'stop',
      currentPhase: state.currentPhase,
      reason: 'terminal phase reached',
    };
  }

  const advanced = advanceInitialPhase(state);
  if (advanced !== state) {
    writeWorkflowRunState(statePath, advanced);
    return {
      status: 'continue',
      currentPhase: state.currentPhase,
      nextPhase: advanced.currentPhase,
      reason: `advanced from ${state.currentPhase} to ${advanced.currentPhase}`,
    };
  }

  const recoveredScriptState = recoverCompletedScriptPhase(advanced);
  if (recoveredScriptState) {
    writeWorkflowRunState(statePath, recoveredScriptState.state);
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
    // Agent dispatch/recovery lives in the lifecycle module; runtime only
    // hands off the current state and persists the returned snapshot.
    const advancedAgent = advanceAgentWorkOnce({
      cwd,
      state: advanced,
      handleState,
      adapter,
      now,
    });
    writeWorkflowRunState(statePath, advancedAgent.state);
    writeDaemonHandleState(handleStatePath, advancedAgent.handleState);
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
    writeWorkflowRunState(statePath, updatedState);
    return {
      status: executed.nextPhase ? 'continue' : 'stop',
      currentPhase,
      nextPhase: executed.nextPhase ?? undefined,
      reason: `script phase ${currentPhase} completed with ${executed.record.outcome}`,
    };
  }

  if (phase?.type === 'poll') {
    const advancedPoll = advancePollWorkOnce({
      cwd,
      state: advanced,
      phaseId: currentPhase,
      phase,
      now,
    });
    writeWorkflowRunState(statePath, advancedPoll.state);
    return advancedPoll.result;
  }

  const refreshed = {
    ...advanced,
    updatedAt: nowIso(now),
  };
  writeWorkflowRunState(statePath, refreshed);

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

export { readDaemonHandleState, readWorkflowRunState, writeDaemonHandleState, writeWorkflowRunState };
