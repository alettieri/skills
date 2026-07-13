import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
import { statusCommandForWorktree } from './status.ts';
import { optionalTrimmedString } from './validation.ts';
import {
  DAEMON_HANDLE_STATE_PATH,
  WORKFLOW_RUN_STATE_PATH,
  readDaemonHandleState,
  readWorkflowRunState,
  workflowStatePathsFor,
  validateWorkflowStateCompatibility,
  writeDaemonHandleState,
  writeWorkflowRunState,
  slugifyIssueCanonical,
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
const DAEMON_EXIT_SENTINEL = 'HERDR_IMPLEMENT_DAEMON_EXIT';
const POST_WORKTREE_SETUP_HOOK_PATH = '.agent/herdr-post-worktree-setup';
const POST_WORKTREE_SETUP_LOG_PATH = '.agent/post-worktree-setup.log';
const POST_WORKTREE_SETUP_TIMEOUT_MS = 10 * 60 * 1000;

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
  waitForHealthyDaemonMs?: number;
  pollIntervalMs?: number;
};

export type BootstrapMode = 'new-run' | 'recovery';
export type BootstrapHealth = 'healthy' | 'timed-out' | 'pane-exited';

export type BootstrapResult = {
  issue: IssueReference;
  slug: string;
  mode: BootstrapMode;
  health: BootstrapHealth;
  currentPhase: string;
  nextInspectionCommand: string;
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

export type BootstrapDiagnostics = {
  issue: IssueReference;
  slug: string;
  mode: BootstrapMode;
  health: BootstrapHealth;
  currentPhase: string;
  worktreePath: string | null;
  workspaceId: string | null;
  branchName: string;
  daemonTabId: string | null;
  daemonPaneId: string | null;
  runStatePath: string | null;
  handleStatePath: string | null;
  reason: string;
};

export class BootstrapError extends Error {
  diagnostics: BootstrapDiagnostics | null;

  constructor(message: string, diagnostics: BootstrapDiagnostics | null = null) {
    super(message);
    this.name = 'BootstrapError';
    this.diagnostics = diagnostics;
  }
}

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

function detectRepositoryInfo(cwd: string, options: { allowMissingOriginHead: boolean }): RepositoryInfo {
  const rootPath = runGit(['rev-parse', '--show-toplevel'], cwd);
  const currentBranch = runGit(['branch', '--show-current'], rootPath) || 'main';

  let baseBranch: string;
  try {
    const symbolic = runGit(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], rootPath);
    baseBranch = symbolic.includes('/') ? symbolic.split('/').pop() ?? 'main' : symbolic;
  } catch {
    if (!options.allowMissingOriginHead) {
      throw new Error('unable to resolve origin/HEAD; fetch/pull latest and retry');
    }
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

function gitStatusPorcelain(rootPath: string): string {
  return runGit(['status', '--porcelain', '--untracked-files=normal'], rootPath);
}

function gitRevParse(rootPath: string, ref: string): string {
  return runGit(['rev-parse', '--verify', ref], rootPath);
}

function assertNewRunPreflight(repository: RepositoryInfo): void {
  const status = gitStatusPorcelain(repository.rootPath);
  if (status.trim()) {
    throw new Error('source checkout must be clean before creating a new worktree');
  }

  if (repository.currentBranch !== repository.baseBranch) {
    throw new Error(`current branch must match base branch before creating a new worktree: ${repository.currentBranch} != ${repository.baseBranch}`);
  }

  let localBase: string;
  let remoteBase: string;
  try {
    localBase = gitRevParse(repository.rootPath, repository.baseBranch);
    remoteBase = gitRevParse(repository.rootPath, `origin/${repository.baseBranch}`);
  } catch {
    throw new Error(`fetch/pull latest and retry: unable to resolve origin/${repository.baseBranch}`);
  }
  if (localBase !== remoteBase) {
    throw new Error(`fetch/pull latest and retry: local ${repository.baseBranch} does not match origin/${repository.baseBranch}`);
  }
}

function canonicalFromIdentifier(identifier: string): string {
  return /^\d+$/.test(identifier) ? `#${Number(identifier)}` : identifier;
}

function issueSegmentFromUrl(value: string): { url: string; segment: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (!parsed.protocol.startsWith('http')) {
    return null;
  }

  const segments = parsed.pathname
    .split('/')
    .map((segment) => decodeURIComponent(segment).trim())
    .filter(Boolean);
  if (segments.length === 0) {
    return null;
  }

  const issueMarkerIndex = segments.findIndex((segment) => /^(issues?|tickets?)$/i.test(segment));
  const segment = issueMarkerIndex >= 0 ? segments[issueMarkerIndex + 1] : segments[segments.length - 1];

  return segment ? { url: value, segment } : null;
}

export function normalizeIssueReference(input: string): IssueReference {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('issue reference must be a non-empty string');
  }

  const ticketMatch = trimmed.match(/\b([A-Z]+-\d+)\b/);
  if (ticketMatch) {
    const canonical = ticketMatch[1];
    return {
      input,
      url: issueSegmentFromUrl(trimmed)?.url ?? null,
      canonical,
      slug: slugifyIssueCanonical(canonical),
    };
  }

  const numberMatch = trimmed.match(/^#?(\d+)$/);
  if (numberMatch) {
    const canonical = canonicalFromIdentifier(numberMatch[1]);
    return {
      input,
      url: null,
      canonical,
      slug: slugifyIssueCanonical(canonical),
    };
  }

  const urlReference = issueSegmentFromUrl(trimmed);
  if (urlReference) {
    const ticketSegmentMatch = urlReference.segment.match(/\b([A-Z]+-\d+)\b/);
    const segment = ticketSegmentMatch?.[1] ?? urlReference.segment;
    const canonical = canonicalFromIdentifier(segment);
    return {
      input,
      url: urlReference.url,
      canonical,
      slug: slugifyIssueCanonical(canonical),
    };
  }

  return {
    input,
    url: null,
    canonical: trimmed,
    slug: slugifyIssueCanonical(trimmed),
  };
}

function ensureDaemonCommand(worktreePath: string): string {
  return `node skills/herdr-implement/bin/daemon.ts --worktree ${JSON.stringify(worktreePath)} --state ${RUN_STATE_PATH} --handles ${HANDLE_STATE_PATH}`;
}

function daemonPaneCommand(daemonCommand: string): string {
  return `${daemonCommand}; printf '\\n${DAEMON_EXIT_SENTINEL}:%s\\n' "$?"`;
}

function paneTranscriptShowsDaemonExit(transcript: string): boolean {
  return transcript.includes(`${DAEMON_EXIT_SENTINEL}:`) || /(?:^|\n)exit:\d+\s+\$/.test(transcript);
}

function createDaemonPane(
  adapter: HerdrAdapter,
  workspaceId: string,
  worktreePath: string,
): { tabId: string | null; paneId: string | null } {
  const { tabId, paneId } = adapter.createDaemonPane(workspaceId, worktreePath);
  if (!paneId) {
    throw new Error('herdr createDaemonPane did not include a pane id');
  }

  return { tabId, paneId };
}

function recoverDaemonPaneIfHealthy(
  adapter: HerdrAdapter,
  existingRunState: WorkflowRunState,
  existingHandleState: DaemonHandleState,
): { tabId: string | null; paneId: string | null; healthy: boolean } {
  if (!existingHandleState.daemonPaneId || !existingHandleState.daemonTabId) {
    return { tabId: null, paneId: null, healthy: false };
  }

  const paneInfo = adapter.getPaneInfo(existingHandleState.daemonPaneId);
  if (!paneInfo || paneInfo.paneId !== existingHandleState.daemonPaneId) {
    return { tabId: null, paneId: null, healthy: false };
  }
  const transcript = adapter.readPaneTranscript(existingHandleState.daemonPaneId);
  if (paneTranscriptShowsDaemonExit(transcript)) {
    return { tabId: null, paneId: null, healthy: false };
  }

  return {
    tabId: existingHandleState.daemonTabId,
    paneId: existingHandleState.daemonPaneId,
    healthy: true,
  };
}

function isRuntimeOwnedAgentPath(path: string): boolean {
  return (
    path === '.agent/herdr-workflow-run.json' ||
    path === '.agent/herdr-implement.json' ||
    path === POST_WORKTREE_SETUP_LOG_PATH ||
    path.startsWith('.agent/runs/')
  );
}

function untrackedPathFromStatusLine(line: string): string {
  return line.slice(3).trim();
}

function filteredDirtyStatus(worktreePath: string): string {
  return gitStatusPorcelain(worktreePath)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => !isRuntimeOwnedAgentPath(untrackedPathFromStatusLine(line)))
    .join('\n');
}

function writePostWorktreeSetupLog(worktreePath: string, stdout: string, stderr: string, footer?: string): void {
  const logPath = join(worktreePath, POST_WORKTREE_SETUP_LOG_PATH);
  mkdirSync(join(worktreePath, '.agent'), { recursive: true });
  const parts = [`[stdout]\n${stdout}`, `[stderr]\n${stderr}`];
  if (footer) {
    parts.push(`[post-worktree-setup]\n${footer}`);
  }
  writeFileSync(logPath, `${parts.join('\n')}\n`, 'utf8');
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function runPostWorktreeSetupBeforeDaemon(worktreePath: string): void {
  const hookPath = join(worktreePath, POST_WORKTREE_SETUP_HOOK_PATH);
  if (!existsSync(hookPath)) {
    return;
  }
  if (!isExecutable(hookPath)) {
    throw new Error(`post-worktree setup hook exists but is not executable: ${hookPath}`);
  }

  const result = spawnSync(hookPath, [], {
    cwd: worktreePath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: POST_WORKTREE_SETUP_TIMEOUT_MS,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';

  if (result.error) {
    writePostWorktreeSetupLog(worktreePath, stdout, stderr, `Startup error: ${result.error.message}`);
    throw new Error(`post-worktree setup hook could not start: ${result.error.message}`);
  }
  if (result.signal) {
    writePostWorktreeSetupLog(worktreePath, stdout, stderr, `Blocked: setup terminated by ${result.signal}.`);
    throw new Error(`post-worktree setup hook terminated by ${result.signal}`);
  }
  if (result.status !== 0) {
    writePostWorktreeSetupLog(worktreePath, stdout, stderr, `Blocked: hook exited ${result.status}.`);
    throw new Error(`post-worktree setup hook exited with status ${result.status}`);
  }

  const dirtyStatus = filteredDirtyStatus(worktreePath);
  if (dirtyStatus) {
    writePostWorktreeSetupLog(worktreePath, stdout, stderr, `Blocked: hook left worktree dirty.\n${dirtyStatus}`);
    throw new Error(`post-worktree setup hook left worktree dirty:\n${dirtyStatus}`);
  }

  writePostWorktreeSetupLog(worktreePath, stdout, stderr);
}

type BootstrapLaunchSnapshot = {
  issue: IssueReference;
  workflowPath: string;
  workflow: ReturnType<typeof loadWorkflow>['workflow'];
  mode: BootstrapMode;
  repository: RepositoryInfo;
  branchName: string;
  worktreePath: string;
  workspaceId: string;
  runStatePath: string;
  handleStatePath: string;
  daemonCommand: string;
  daemonTabId: string | null;
  daemonPaneId: string | null;
  createdRunState: boolean;
  createdHandleState: boolean;
  baselineStateWriteAt: string;
};

function bootstrapDiagnosticsFromSnapshot(
  snapshot: BootstrapLaunchSnapshot,
  health: BootstrapHealth,
  currentPhase: string,
  reason: string,
): BootstrapDiagnostics {
  return {
    issue: snapshot.issue,
    slug: snapshot.issue.slug,
    mode: snapshot.mode,
    health,
    currentPhase,
    worktreePath: snapshot.worktreePath,
    workspaceId: snapshot.workspaceId,
    branchName: snapshot.branchName,
    daemonTabId: snapshot.daemonTabId,
    daemonPaneId: snapshot.daemonPaneId,
    runStatePath: snapshot.runStatePath,
    handleStatePath: snapshot.handleStatePath,
    reason,
  };
}

function bootstrapResultFromSnapshot(
  snapshot: BootstrapLaunchSnapshot,
  health: BootstrapHealth,
  currentPhase: string,
): BootstrapResult {
  return {
    issue: snapshot.issue,
    slug: snapshot.issue.slug,
    mode: snapshot.mode,
    health,
    currentPhase,
    nextInspectionCommand: statusCommandForWorktree(snapshot.worktreePath),
    workflowPath: snapshot.workflowPath,
    workspaceId: snapshot.workspaceId,
    worktreePath: snapshot.worktreePath,
    branchName: snapshot.branchName,
    runStatePath: snapshot.runStatePath,
    handleStatePath: snapshot.handleStatePath,
    daemonCommand: snapshot.daemonCommand,
    daemonTabId: snapshot.daemonTabId,
    daemonPaneId: snapshot.daemonPaneId,
    createdRunState: snapshot.createdRunState,
    createdHandleState: snapshot.createdHandleState,
  };
}

function latestIsoTimestamp(values: Array<string | null | undefined>): string {
  let latest = '';
  for (const value of values) {
    if (value && value > latest) {
      latest = value;
    }
  }
  return latest;
}

function createBootstrapLaunchSnapshot(
  options: BootstrapOptions,
  issue: IssueReference,
  workflowSource: ReturnType<typeof loadWorkflow>,
  repository: RepositoryInfo,
  worktree: WorktreeInfo,
  mode: BootstrapMode,
  createdRunState: boolean,
  createdHandleState: boolean,
  daemonTabId: string | null,
  daemonPaneId: string | null,
  daemonCommand: string,
  baselineStateWriteAt: string,
): BootstrapLaunchSnapshot {
  const { runStatePath, handleStatePath } = workflowStatePathsFor(worktree.worktreePath);
  return {
    issue,
    workflowPath: workflowSource.path,
    workflow: workflowSource.workflow,
    mode,
    repository,
    branchName: worktree.branchName,
    worktreePath: worktree.worktreePath,
    workspaceId: worktree.workspaceId,
    runStatePath,
    handleStatePath,
    daemonCommand,
    daemonTabId,
    daemonPaneId,
    createdRunState,
    createdHandleState,
    baselineStateWriteAt,
  };
}

function bootstrapLaunchFailure(
  snapshot: BootstrapLaunchSnapshot,
  currentPhase: string,
  error: unknown,
): BootstrapError {
  const reason = error instanceof Error ? error.message : String(error);
  return new BootstrapError(`failed to launch daemon pane: ${reason}`, bootstrapDiagnosticsFromSnapshot(snapshot, 'pane-exited', currentPhase, reason));
}

function updateRunStateForDaemon(
  state: WorkflowRunState,
  tabId: string | null,
  paneId: string | null,
  daemonCommand: string,
  startedAt: string,
): WorkflowRunState {
  return {
    ...state,
    updatedAt: startedAt,
    daemon: {
      tabId,
      paneId,
      command: daemonCommand,
      startedAt,
    },
  };
}

function updateHandleStateForDaemon(
  state: DaemonHandleState,
  tabId: string | null,
  paneId: string | null,
  daemonCommand: string,
  updatedAt: string,
): DaemonHandleState {
  return {
    ...state,
    daemonTabId: tabId,
    daemonPaneId: paneId,
    daemonCommand,
    updatedAt,
  };
}

function createNewRunState(
  issue: IssueReference,
  workflowSource: ReturnType<typeof loadWorkflow>,
  repository: RepositoryInfo,
  worktree: WorktreeInfo,
  createdAt: string,
  daemonCommand: string,
): WorkflowRunState {
  return {
    schemaVersion: 1,
    issue,
    workflowPath: workflowSource.path,
    workflow: workflowSource.workflow,
    sourceRepo: repository,
    branchName: worktree.branchName,
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
    daemonHandlePath: workflowStatePathsFor(worktree.worktreePath).handleStatePath,
    daemon: {
      tabId: null,
      paneId: null,
      command: null,
      startedAt: null,
    },
  };
}

function createBootstrapHandleState(
  worktree: WorktreeInfo,
  runStatePath: string,
  createdAt: string,
  daemonCommand: string,
): DaemonHandleState {
  return {
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
}

async function waitForHealthyDaemon(
  adapter: HerdrAdapter,
  snapshot: BootstrapLaunchSnapshot,
  startPhase: string,
  baselineStateWriteAt: string,
  options: BootstrapOptions,
): Promise<{ health: BootstrapHealth; currentPhase: string; reason: string }> {
  const waitForHealthyDaemonMs = options.waitForHealthyDaemonMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const deadline = Date.now() + waitForHealthyDaemonMs;
  let currentPhase = startPhase;

  while (true) {
    const handleState = readDaemonHandleState(snapshot.handleStatePath);
    const paneId = handleState?.daemonPaneId ?? snapshot.daemonPaneId;
    if (!paneId) {
      return { health: 'pane-exited', currentPhase, reason: 'pane exited before daemon handle recorded a pane id' };
    }

    const paneInfo = adapter.getPaneInfo(paneId);
    if (!paneInfo || paneInfo.paneId !== paneId) {
      return { health: 'pane-exited', currentPhase, reason: 'pane exited' };
    }

    const runState = readWorkflowRunState(snapshot.runStatePath);
    if (!runState) {
      return { health: 'pane-exited', currentPhase, reason: 'workflow run state missing' };
    }

    currentPhase = runState.currentPhase;
    const progressed =
      runState.updatedAt > baselineStateWriteAt ||
      runState.currentPhase !== startPhase ||
      isTerminalPhase(runState.workflow, runState.currentPhase);
    if (progressed) {
      return { health: 'healthy', currentPhase, reason: 'daemon state progressed' };
    }

    if (Date.now() >= deadline) {
      const transcript = adapter.readPaneTranscript(paneId);
      if (paneTranscriptShowsDaemonExit(transcript)) {
        return { health: 'pane-exited', currentPhase, reason: 'daemon command exited without state progress' };
      }
      return { health: 'timed-out', currentPhase, reason: 'no state progress in 30s' };
    }

    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }
}

export async function bootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  const adapter = resolveHerdrAdapter(options);
  const cwd = resolve(options.cwd ?? process.cwd());
  const issue = normalizeIssueReference(options.issue);
  const workflowSource = loadWorkflow(cwd);
  const repositoryForLookup = detectRepositoryInfo(cwd, { allowMissingOriginHead: true });
  const branchName = `issue-${issue.slug}-herdr-implement`;
  const worktree = adapter.findWorktreeByBranch(repositoryForLookup, branchName);

  if (worktree) {
    const { runStatePath, handleStatePath } = workflowStatePathsFor(worktree.worktreePath);
    const existingRunState = readWorkflowRunState(runStatePath);
    if (!existingRunState) {
      throw new BootstrapError(
        `worktree found at ${worktree.worktreePath} but no matching run state exists`,
        {
          issue,
          slug: issue.slug,
          mode: 'recovery',
          health: 'timed-out',
          currentPhase: workflowSource.workflow.start,
          worktreePath: worktree.worktreePath,
          workspaceId: worktree.workspaceId,
          branchName,
          daemonTabId: null,
          daemonPaneId: null,
          runStatePath,
          handleStatePath,
          reason: 'missing workflow run state',
        },
      );
    }

    if (existingRunState.issue.slug !== issue.slug) {
      throw new BootstrapError(`existing run state belongs to ${existingRunState.issue.canonical}, not ${issue.canonical}`, {
        issue,
        slug: issue.slug,
        mode: 'recovery',
        health: 'timed-out',
        currentPhase: existingRunState.currentPhase,
        worktreePath: existingRunState.worktreePath,
        workspaceId: existingRunState.workspaceId,
        branchName: existingRunState.branchName,
        daemonTabId: existingRunState.daemon.tabId,
        daemonPaneId: existingRunState.daemon.paneId,
        runStatePath,
        handleStatePath,
        reason: 'existing run state issue mismatch',
      });
    }

    if (existingRunState.branchName !== branchName) {
      throw new BootstrapError(`existing run state branch mismatch: expected ${branchName}, found ${existingRunState.branchName}`, {
        issue,
        slug: issue.slug,
        mode: 'recovery',
        health: 'timed-out',
        currentPhase: existingRunState.currentPhase,
        worktreePath: existingRunState.worktreePath,
        workspaceId: existingRunState.workspaceId,
        branchName: existingRunState.branchName,
        daemonTabId: existingRunState.daemon.tabId,
        daemonPaneId: existingRunState.daemon.paneId,
        runStatePath,
        handleStatePath,
        reason: 'existing run state branch mismatch',
      });
    }

    const existingHandleState = readDaemonHandleState(handleStatePath);
    let daemonCommand = existingRunState.daemon.command ?? ensureDaemonCommand(existingRunState.worktreePath);
    let daemonTabId = existingRunState.daemon.tabId ?? existingHandleState?.daemonTabId ?? null;
    let daemonPaneId = existingRunState.daemon.paneId ?? existingHandleState?.daemonPaneId ?? null;
    let createdHandleState = false;
    let baselineStateWriteAt = latestIsoTimestamp([existingRunState.updatedAt, existingHandleState?.updatedAt]);

    if (!existingHandleState) {
      const createdAt = nowIso(options.now);
      const handleState = createBootstrapHandleState(
        {
          workspaceId: existingRunState.workspaceId,
          worktreePath: existingRunState.worktreePath,
          branchName: existingRunState.branchName,
        },
        runStatePath,
        createdAt,
        daemonCommand,
      );
      writeDaemonHandleState(handleStatePath, handleState);
      createdHandleState = true;
      baselineStateWriteAt = createdAt;
    }

    const recovered = existingHandleState ? recoverDaemonPaneIfHealthy(adapter, existingRunState, existingHandleState) : null;
    const snapshot = createBootstrapLaunchSnapshot(
      options,
      issue,
      workflowSource,
      repositoryForLookup,
      {
        workspaceId: existingRunState.workspaceId,
        worktreePath: existingRunState.worktreePath,
        branchName: existingRunState.branchName,
      },
      'recovery',
      false,
      createdHandleState,
      daemonTabId,
      daemonPaneId,
      daemonCommand,
      baselineStateWriteAt,
    );

    if (!recovered?.healthy) {
      try {
        runPostWorktreeSetupBeforeDaemon(existingRunState.worktreePath);
        const daemonPane = createDaemonPane(adapter, existingRunState.workspaceId, existingRunState.worktreePath);
        const startedAt = nowIso(options.now);
        const updatedRunState = updateRunStateForDaemon(existingRunState, daemonPane.tabId, daemonPane.paneId, daemonCommand, startedAt);
        writeWorkflowRunState(runStatePath, updatedRunState);
        const handleState = existingHandleState ?? createBootstrapHandleState(
          {
            workspaceId: existingRunState.workspaceId,
            worktreePath: existingRunState.worktreePath,
            branchName: existingRunState.branchName,
          },
          runStatePath,
          startedAt,
          daemonCommand,
        );
        const updatedHandleState = updateHandleStateForDaemon(handleState, daemonPane.tabId, daemonPane.paneId, daemonCommand, startedAt);
        writeDaemonHandleState(handleStatePath, updatedHandleState);
        daemonTabId = daemonPane.tabId;
        daemonPaneId = daemonPane.paneId;
        baselineStateWriteAt = startedAt;
        snapshot.daemonTabId = daemonTabId;
        snapshot.daemonPaneId = daemonPaneId;
        snapshot.createdHandleState = createdHandleState;
        snapshot.baselineStateWriteAt = baselineStateWriteAt;
        adapter.runPaneCommand(daemonPane.paneId!, daemonPaneCommand(daemonCommand));
      } catch (error) {
        throw bootstrapLaunchFailure(snapshot, existingRunState.currentPhase, error);
      }
    }

    const health = await waitForHealthyDaemon(adapter, snapshot, existingRunState.currentPhase, baselineStateWriteAt, options);
    return bootstrapResultFromSnapshot(snapshot, health.health, health.currentPhase);
  }

  const repository = detectRepositoryInfo(cwd, { allowMissingOriginHead: false });
  assertNewRunPreflight(repository);
  const createdWorktree = adapter.createWorktree(repository, branchName, `issue-${issue.slug}`);
  runPostWorktreeSetupBeforeDaemon(createdWorktree.worktreePath);
  const daemonCommand = ensureDaemonCommand(createdWorktree.worktreePath);
  const createdAt = nowIso(options.now);
  const { runStatePath, handleStatePath } = workflowStatePathsFor(createdWorktree.worktreePath);
  const runState = createNewRunState(issue, workflowSource, repository, createdWorktree, createdAt, daemonCommand);
  writeWorkflowRunState(runStatePath, runState);
  const handleState = createBootstrapHandleState(createdWorktree, runStatePath, createdAt, daemonCommand);
  writeDaemonHandleState(handleStatePath, handleState);

  const snapshot = createBootstrapLaunchSnapshot(
    options,
    issue,
    workflowSource,
    repository,
    createdWorktree,
    'new-run',
    true,
    true,
    null,
    null,
    daemonCommand,
    createdAt,
  );

  try {
    const daemonPane = createDaemonPane(adapter, createdWorktree.workspaceId, createdWorktree.worktreePath);
    const startedAt = nowIso(options.now);
    writeWorkflowRunState(runStatePath, updateRunStateForDaemon(runState, daemonPane.tabId, daemonPane.paneId, daemonCommand, startedAt));
    writeDaemonHandleState(handleStatePath, updateHandleStateForDaemon(handleState, daemonPane.tabId, daemonPane.paneId, daemonCommand, startedAt));
    snapshot.daemonTabId = daemonPane.tabId;
    snapshot.daemonPaneId = daemonPane.paneId;
    snapshot.baselineStateWriteAt = startedAt;
    adapter.runPaneCommand(daemonPane.paneId!, daemonPaneCommand(daemonCommand));
    const health = await waitForHealthyDaemon(adapter, snapshot, workflowSource.workflow.start, startedAt, options);
    return bootstrapResultFromSnapshot(snapshot, health.health, health.currentPhase);
  } catch (error) {
    throw bootstrapLaunchFailure(snapshot, workflowSource.workflow.start, error);
  }
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

  validateWorkflowStateCompatibility(statePath, state, handleStatePath, handleState);

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
      slug: result.slug,
      mode: result.mode,
      health: result.health,
      currentPhase: result.currentPhase,
      nextInspectionCommand: result.nextInspectionCommand,
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
