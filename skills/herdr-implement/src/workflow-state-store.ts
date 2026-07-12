import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { normalizeCapture } from './capture.ts';
import { normalizeScriptRunMap, type ScriptRunState } from './script-phase.ts';
import type { NormalizedWorkflow } from './workflow.ts';
import {
  isRecord,
  optionalBoolean,
  optionalFiniteNumber,
  optionalTrimmedString,
} from './validation.ts';

export const WORKFLOW_RUN_STATE_PATH = '.agent/herdr-workflow-run.json';
export const DAEMON_HANDLE_STATE_PATH = '.agent/herdr-implement.json';

export type IssueReference = {
  input: string;
  url: string | null;
  canonical: string;
  slug: string;
};

export type RepositoryInfo = {
  rootPath: string;
  remoteUrl: string | null;
  currentBranch: string;
  baseBranch: string;
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

export type PollRunStatus = 'waiting' | 'complete' | 'blocked' | 'failed' | 'timeout';

export type PollRunState = {
  runId: string;
  phaseId: string;
  command: string;
  resolvedCommandPath: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  intervalSeconds: number;
  timeoutSeconds: number;
  createdAt: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  nextWakeAt: string;
  tickCount: number;
  timedOut: boolean;
  exitCode: number | null;
  signal: string | null;
  status: PollRunStatus;
  outcome: string;
  capture: Record<string, unknown> | null;
  observation: Record<string, unknown> | null;
  fingerprint: string;
  stdout: string;
  stderr: string;
  stdoutPath: string;
  stderrPath: string;
  rawOutputPath: string;
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
  pollRuns?: Record<string, PollRunState>;
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
  const tempPath = join(dirname(path), `${basename(path)}.${process.pid}.tmp`);

  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(tempPath, path);
  } finally {
    if (existsSync(tempPath)) {
      unlinkSync(tempPath);
    }
  }
}

function completionRoleFor(roleId: string): 'implementer' | 'reviewer' {
  return roleId === 'reviewer' ? 'reviewer' : 'implementer';
}

function normalizeStringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) {
    return null;
  }

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof key !== 'string' || typeof entry !== 'string') {
      return null;
    }
    result[key] = entry;
  }

  return result;
}

export function workflowStatePathsFor(worktreePath: string): { runStatePath: string; handleStatePath: string } {
  return {
    runStatePath: join(worktreePath, WORKFLOW_RUN_STATE_PATH),
    handleStatePath: join(worktreePath, DAEMON_HANDLE_STATE_PATH),
  };
}

export function validateWorkflowStateCompatibility(
  runStatePath: string,
  runState: WorkflowRunState,
  handleStatePath: string,
  handleState: DaemonHandleState,
): void {
  const issues: string[] = [];

  if (handleState.runStatePath !== runStatePath) {
    issues.push(`runStatePath mismatch: expected ${runStatePath}, found ${handleState.runStatePath}`);
  }
  if (runState.daemonHandlePath !== handleStatePath) {
    issues.push(`handleStatePath mismatch: expected ${handleStatePath}, found ${runState.daemonHandlePath}`);
  }
  if (handleState.workspaceId !== runState.workspaceId) {
    issues.push(`workspaceId mismatch: expected ${runState.workspaceId}, found ${handleState.workspaceId}`);
  }
  if (handleState.worktreePath !== runState.worktreePath) {
    issues.push(`worktreePath mismatch: expected ${runState.worktreePath}, found ${handleState.worktreePath}`);
  }

  if (issues.length > 0) {
    throw new Error(`workflow state compatibility check failed: ${issues.join('; ')}`);
  }
}

export function normalizePendingAgentRun(value: unknown): PendingAgentRunState | null {
  if (!isRecord(value)) {
    return null;
  }

  const runId = optionalTrimmedString(value.runId);
  const phaseId = optionalTrimmedString(value.phaseId);
  const roleId = optionalTrimmedString(value.roleId);
  const completionRole =
    value.completionRole === 'implementer' || value.completionRole === 'reviewer'
      ? value.completionRole
      : roleId
        ? completionRoleFor(roleId)
        : null;
  const roleLabel = optionalTrimmedString(value.roleLabel);
  const agentName = optionalTrimmedString(value.agentName);
  const resultSchema = optionalTrimmedString(value.resultSchema);
  const resultPath = optionalTrimmedString(value.resultPath);
  const notifyTarget = optionalTrimmedString(value.notifyTarget);
  const status = value.status === 'pending' ? value.status : null;
  const attemptNumber = optionalFiniteNumber(value.attemptNumber);
  const startedAt = optionalTrimmedString(value.startedAt);

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

export function normalizeAcceptedAgentRun(value: unknown): AcceptedAgentRunState | null {
  if (!isRecord(value)) {
    return null;
  }

  const runId = optionalTrimmedString(value.runId);
  const phaseId = optionalTrimmedString(value.phaseId);
  const roleId = optionalTrimmedString(value.roleId);
  const resultPath = optionalTrimmedString(value.resultPath);
  const acceptedAt = optionalTrimmedString(value.acceptedAt);
  const status =
    value.status === 'complete' || value.status === 'blocked' || value.status === 'failed' ? value.status : null;
  const outcome = optionalTrimmedString(value.outcome);
  const summary = optionalTrimmedString(value.summary);
  const roleLabel = optionalTrimmedString(value.roleLabel);
  const agentName = optionalTrimmedString(value.agentName);
  const resultSchema = optionalTrimmedString(value.resultSchema);
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

export function normalizeAcceptedAgentRunMap(value: unknown): Record<string, AcceptedAgentRunState> {
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

export function normalizePollRun(value: unknown): PollRunState | null {
  if (!isRecord(value)) {
    return null;
  }

  const runId = optionalTrimmedString(value.runId);
  const phaseId = optionalTrimmedString(value.phaseId);
  const command = optionalTrimmedString(value.command);
  const resolvedCommandPath = optionalTrimmedString(value.resolvedCommandPath);
  const args = Array.isArray(value.args) && value.args.every((item) => typeof item === 'string') ? value.args : null;
  const cwd = optionalTrimmedString(value.cwd);
  const env = normalizeStringRecord(value.env);
  const intervalSeconds = optionalFiniteNumber(value.intervalSeconds);
  const timeoutSeconds = optionalFiniteNumber(value.timeoutSeconds);
  const createdAt = optionalTrimmedString(value.createdAt);
  const startedAt = optionalTrimmedString(value.startedAt);
  const finishedAt = optionalTrimmedString(value.finishedAt);
  const durationMs = optionalFiniteNumber(value.durationMs);
  const nextWakeAt = optionalTrimmedString(value.nextWakeAt);
  const tickCount = optionalFiniteNumber(value.tickCount);
  const timedOut = optionalBoolean(value.timedOut);
  const exitCode =
    value.exitCode === undefined
      ? undefined
      : value.exitCode === null
        ? null
        : typeof value.exitCode === 'number' && Number.isFinite(value.exitCode)
          ? value.exitCode
          : undefined;
  const signal = value.signal === null ? null : optionalTrimmedString(value.signal);
  const status =
    value.status === 'waiting' ||
    value.status === 'complete' ||
    value.status === 'blocked' ||
    value.status === 'failed' ||
    value.status === 'timeout'
      ? value.status
      : null;
  const outcome = optionalTrimmedString(value.outcome);
  const capture = value.capture === undefined ? null : normalizeCapture(value.capture);
  const observation = value.observation === undefined ? null : normalizeCapture(value.observation);
  const fingerprint = optionalTrimmedString(value.fingerprint);
  const stdout = typeof value.stdout === 'string' ? value.stdout : null;
  const stderr = typeof value.stderr === 'string' ? value.stderr : null;
  const stdoutPath = optionalTrimmedString(value.stdoutPath);
  const stderrPath = optionalTrimmedString(value.stderrPath);
  const rawOutputPath = optionalTrimmedString(value.rawOutputPath);

  if (
    !runId ||
    !phaseId ||
    !command ||
    !resolvedCommandPath ||
    !args ||
    !cwd ||
    !env ||
    intervalSeconds === null ||
    timeoutSeconds === null ||
    !createdAt ||
    !startedAt ||
    !finishedAt ||
    durationMs === null ||
    !nextWakeAt ||
    tickCount === null ||
    timedOut === null ||
    exitCode === undefined ||
    !status ||
    !outcome ||
    stdout === null ||
    stderr === null ||
    !stdoutPath ||
    !stderrPath ||
    !rawOutputPath ||
    !fingerprint
  ) {
    return null;
  }

  return {
    runId,
    phaseId,
    command,
    resolvedCommandPath,
    args,
    cwd,
    env,
    intervalSeconds,
    timeoutSeconds,
    createdAt,
    startedAt,
    finishedAt,
    durationMs,
    nextWakeAt,
    tickCount,
    timedOut,
    exitCode: exitCode ?? null,
    signal,
    status,
    outcome,
    capture,
    observation,
    fingerprint,
    stdout,
    stderr,
    stdoutPath,
    stderrPath,
    rawOutputPath,
  };
}

export function normalizePollRunMap(value: unknown): Record<string, PollRunState> {
  if (!isRecord(value)) {
    return {};
  }

  const result: Record<string, PollRunState> = {};
  for (const [phaseId, record] of Object.entries(value)) {
    const normalized = normalizePollRun(record);
    if (normalized) {
      result[phaseId] = normalized;
    }
  }

  return result;
}

export function normalizeRoleAgentMap(value: unknown): Record<string, RoleAgentState> {
  if (!isRecord(value)) {
    return {};
  }

  const result: Record<string, RoleAgentState> = {};
  for (const [roleId, roleValue] of Object.entries(value)) {
    if (!isRecord(roleValue)) {
      continue;
    }

    const roleLabel = optionalTrimmedString(roleValue.roleLabel);
    const agentName = optionalTrimmedString(roleValue.agentName);
    const tabId = optionalTrimmedString(roleValue.tabId);
    const paneId = optionalTrimmedString(roleValue.paneId);
    const terminalId = optionalTrimmedString(roleValue.terminalId);
    const createdAt = optionalTrimmedString(roleValue.createdAt);
    const updatedAt = optionalTrimmedString(roleValue.updatedAt);

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

export function normalizeWorkflowRunState(value: Record<string, unknown>): WorkflowRunState {
  const context = isRecord(value.context) ? { ...value.context } : {};
  return {
    ...(value as WorkflowRunState),
    issue: normalizeIssueReference(value.issue),
    pendingAgentRun: normalizePendingAgentRun(value.pendingAgentRun),
    acceptedAgentRuns: normalizeAcceptedAgentRunMap(value.acceptedAgentRuns),
    scriptRuns: normalizeScriptRunMap(value.scriptRuns),
    pollRuns: normalizePollRunMap(value.pollRuns),
    context,
  };
}

export function slugifyIssueCanonical(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!slug) {
    throw new Error('issue reference must contain at least one letter or number so a stable slug can be derived');
  }

  if (slug.length <= 50) {
    return slug;
  }

  const capped = slug.slice(0, 50);
  const boundary = capped.lastIndexOf('-');
  return boundary > 0 ? capped.slice(0, boundary) : capped;
}

export function normalizeIssueReference(value: unknown): IssueReference {
  if (!isRecord(value)) {
    throw new Error('workflow run state issue must be an object');
  }

  const input = optionalTrimmedString(value.input);
  const canonical = optionalTrimmedString(value.canonical);
  const url = value.url === null ? null : optionalTrimmedString(value.url);
  const slug = optionalTrimmedString(value.slug) ?? (canonical ? slugifyIssueCanonical(canonical) : null);

  if (!input || !canonical || !slug) {
    throw new Error('workflow run state issue must include input, canonical, and slug');
  }

  return {
    input,
    url,
    canonical,
    slug,
  };
}

export function normalizeDaemonHandleState(value: Record<string, unknown>): DaemonHandleState {
  return {
    ...(value as DaemonHandleState),
    roleAgents: normalizeRoleAgentMap(value.roleAgents),
  };
}

export function readWorkflowRunState(path: string): WorkflowRunState | null {
  const value = readJsonFile(path);
  if (!value) {
    return null;
  }
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error(`invalid workflow run state at ${path}`);
  }
  return normalizeWorkflowRunState(value as Record<string, unknown>);
}

export function writeWorkflowRunState(path: string, state: WorkflowRunState): void {
  writeJsonFile(path, state);
}

export function readDaemonHandleState(path: string): DaemonHandleState | null {
  const value = readJsonFile(path);
  if (!value) {
    return null;
  }
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error(`invalid daemon handle state at ${path}`);
  }
  return normalizeDaemonHandleState(value as Record<string, unknown>);
}

export function writeDaemonHandleState(path: string, state: DaemonHandleState): void {
  writeJsonFile(path, state);
}
