import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { loadWorkflow } from './workflow.ts';
import type { NormalizedWorkflow } from './workflow.ts';

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

export type DaemonHandleState = {
  schemaVersion: 1;
  runStatePath: string;
  workspaceId: string;
  worktreePath: string;
  daemonTabId: string | null;
  daemonPaneId: string | null;
  daemonCommand: string | null;
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
  now?: () => Date;
  sleepMs?: number;
};

type HerdrWorktreeRecord = {
  workspaceId?: string;
  worktreePath?: string;
  path?: string;
  branch?: string;
  base?: string;
};

type WorktreeListOutput = {
  worktrees?: unknown[];
  items?: unknown[];
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

function runHerdrJson(runner: HerdrCommandRunner, args: string[]): unknown {
  const result = runner.run(args);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`herdr ${args.join(' ')} failed with exit ${result.status}: ${result.stderr.trim()}`);
  }

  const stdout = result.stdout.trim();
  if (!stdout) {
    return null;
  }

  return JSON.parse(stdout) as unknown;
}

function normalizeWorktreeList(value: unknown): HerdrWorktreeRecord[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord).map((entry) => entry as HerdrWorktreeRecord);
  }

  if (isRecord(value)) {
    const output = value as WorktreeListOutput;
    const records = output.worktrees ?? output.items;
    if (Array.isArray(records)) {
      return records.filter(isRecord).map((entry) => entry as HerdrWorktreeRecord);
    }
  }

  return [];
}

function chooseWorktreeRecord(records: HerdrWorktreeRecord[], branchName: string): HerdrWorktreeRecord | null {
  return records.find((record) => record.branch === branchName) ?? null;
}

function resolveWorktreePath(record: HerdrWorktreeRecord | null, fallbackBranch: string): string {
  if (!record) {
    return fallbackBranch;
  }

  return record.worktreePath ?? record.path ?? fallbackBranch;
}

function resolveWorkspaceId(record: HerdrWorktreeRecord | null): string | null {
  if (!record) {
    return null;
  }

  return record.workspaceId ?? null;
}

function requireWorkspaceId(workspaceId: string | null, branchName: string): string {
  if (!workspaceId) {
    throw new Error(`Herdr worktree record for ${branchName} is missing a workspace id`);
  }

  return workspaceId;
}

function requireWorktreePath(path: string | null, branchName: string): string {
  if (!path || path === branchName) {
    throw new Error(`Herdr worktree record for ${branchName} is missing a worktree path`);
  }

  return path;
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

function parseMaybeJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

function loadRunState(path: string): WorkflowRunState | null {
  const value = readJsonFile(path);
  if (!value) {
    return null;
  }
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error(`invalid workflow run state at ${path}`);
  }
  return value as WorkflowRunState;
}

function loadHandleState(path: string): DaemonHandleState | null {
  const value = readJsonFile(path);
  if (!value) {
    return null;
  }
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error(`invalid daemon handle state at ${path}`);
  }
  return value as DaemonHandleState;
}

function saveRunState(path: string, state: WorkflowRunState): void {
  writeJsonFile(path, state);
}

function saveHandleState(path: string, state: DaemonHandleState): void {
  writeJsonFile(path, state);
}

function createWorktreeIfNeeded(
  runner: HerdrCommandRunner,
  repository: RepositoryInfo,
  branchName: string,
  issueLabel: string,
): WorktreeInfo {
  const worktreeList = normalizeWorktreeList(
    runHerdrJson(runner, ['worktree', 'list', '--cwd', repository.rootPath, '--json']),
  );
  const existing = chooseWorktreeRecord(worktreeList, branchName);
  if (existing) {
    const workspaceId = requireWorkspaceId(resolveWorkspaceId(existing), branchName);
    const worktreePath = requireWorktreePath(resolveWorktreePath(existing, branchName), branchName);

    return {
      workspaceId,
      worktreePath,
      branchName,
    };
  }

  const created = runHerdrJson(runner, [
    'worktree',
    'create',
    '--cwd',
    repository.rootPath,
    '--branch',
    branchName,
    '--base',
    repository.baseBranch,
    '--label',
    issueLabel,
    '--focus',
    '--json',
  ]);

  const createdRecord = isRecord(created) ? created : {};
  const workspaceId = optionalString(createdRecord.workspaceId) ?? optionalString(createdRecord.workspace_id);
  const worktreePath =
    optionalString(createdRecord.worktreePath) ?? optionalString(createdRecord.path) ?? optionalString(createdRecord.cwd);

  const resolvedList = normalizeWorktreeList(
    runHerdrJson(runner, ['worktree', 'list', '--cwd', repository.rootPath, '--json']),
  );
  const resolved = chooseWorktreeRecord(resolvedList, branchName);

  return {
    workspaceId: requireWorkspaceId(workspaceId ?? resolveWorkspaceId(resolved), branchName),
    worktreePath: requireWorktreePath(worktreePath ?? resolveWorktreePath(resolved, branchName), branchName),
    branchName,
  };
}

function createDaemonPane(
  runner: HerdrCommandRunner,
  workspaceId: string,
  worktreePath: string,
  daemonCommand: string,
): { tabId: string | null; paneId: string | null } {
  const tabCreate = runner.run([
    'tab',
    'create',
    '--workspace',
    workspaceId,
    '--cwd',
    worktreePath,
    '--label',
    DEFAULT_DAEMON_LABEL,
    '--focus',
  ]);

  if (tabCreate.error) {
    throw tabCreate.error;
  }
  if (tabCreate.status !== 0) {
    throw new Error(`herdr tab create failed with exit ${tabCreate.status}: ${tabCreate.stderr.trim()}`);
  }

  const tabOutput = parseMaybeJson(tabCreate.stdout);
  const tabRecord = isRecord(tabOutput) ? tabOutput : {};
  const tabId = typeof tabOutput === 'string' ? tabOutput : optionalString(tabRecord.tabId) ?? optionalString(tabRecord.id);

  const paneCurrent = runner.run(['pane', 'current', '--current']);
  if (paneCurrent.error) {
    throw paneCurrent.error;
  }
  if (paneCurrent.status !== 0) {
    throw new Error(`herdr pane current failed with exit ${paneCurrent.status}: ${paneCurrent.stderr.trim()}`);
  }

  const paneOutput = parseMaybeJson(paneCurrent.stdout);
  const paneRecord = isRecord(paneOutput) ? paneOutput : {};
  const paneId = typeof paneOutput === 'string' ? paneOutput : optionalString(paneRecord.paneId) ?? optionalString(paneRecord.id);

  if (!paneId) {
    throw new Error('herdr pane current did not return a pane id');
  }

  const paneRun = runner.run(['pane', 'run', paneId, daemonCommand]);
  if (paneRun.error) {
    throw paneRun.error;
  }
  if (paneRun.status !== 0) {
    throw new Error(`herdr pane run failed with exit ${paneRun.status}: ${paneRun.stderr.trim()}`);
  }

  return {
    tabId,
    paneId,
  };
}

export function bootstrap(options: BootstrapOptions): BootstrapResult {
  const runner = options.runner ?? {
    run(args: string[]): HerdrCommandResult {
      const result = spawnSync('herdr', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      if (result.error) {
        throw result.error;
      }

      return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        status: result.status,
      };
    },
  };

  const cwd = resolve(options.cwd ?? process.cwd());
  const issue = normalizeIssueReference(options.issue);
  const repository = detectRepositoryInfo(cwd);
  const workflowSource = loadWorkflow(cwd);
  const branchName = issue.number === null ? 'issue-bootstrap' : `issue-${issue.number}-herdr-implement`;
  const worktree = createWorktreeIfNeeded(runner, repository, branchName, `issue-${issue.number ?? 'bootstrap'}`);
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
      createdAt: existingRunState.createdAt,
      updatedAt: existingRunState.updatedAt,
    };

    saveHandleState(handleStatePath, handleState);

    const { tabId, paneId } = createDaemonPane(
      runner,
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
    createdAt,
    updatedAt: createdAt,
  };

  saveHandleState(handleStatePath, handleState);

  const { tabId, paneId } = createDaemonPane(runner, worktree.workspaceId, worktree.worktreePath, daemonCommand);
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

  const refreshed = {
    ...state,
    updatedAt: nowIso(now),
  };
  saveRunState(statePath, refreshed);

  return {
    status: 'sleep',
    currentPhase: state.currentPhase,
    reason: `waiting on ${state.currentPhase}`,
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
