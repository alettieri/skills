import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { normalizeCapture } from './capture.ts';
import { normalizeScriptRunMap, type ScriptRunState } from './script-phase.ts';
import type { NormalizedWorkflow } from './workflow.ts';

export const WORKFLOW_RUN_STATE_PATH = '.agent/herdr-workflow-run.json';
export const DAEMON_HANDLE_STATE_PATH = '.agent/herdr-implement.json';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function optionalString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') {
    return value.trim();
  }
  return null;
}

function completionRoleFor(roleId: string): 'implementer' | 'reviewer' {
  return roleId === 'reviewer' ? 'reviewer' : 'implementer';
}

export function workflowStatePathsFor(worktreePath: string): { runStatePath: string; handleStatePath: string } {
  return {
    runStatePath: join(worktreePath, WORKFLOW_RUN_STATE_PATH),
    handleStatePath: join(worktreePath, DAEMON_HANDLE_STATE_PATH),
  };
}

export function normalizePendingAgentRun(value: unknown): PendingAgentRunState | null {
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

export function normalizeAcceptedAgentRun(value: unknown): AcceptedAgentRunState | null {
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

export function normalizeRoleAgentMap(value: unknown): Record<string, RoleAgentState> {
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

export function normalizeWorkflowRunState(value: Record<string, unknown>): WorkflowRunState {
  const context = isRecord(value.context) ? { ...value.context } : {};
  return {
    ...(value as WorkflowRunState),
    pendingAgentRun: normalizePendingAgentRun(value.pendingAgentRun),
    acceptedAgentRuns: normalizeAcceptedAgentRunMap(value.acceptedAgentRuns),
    scriptRuns: normalizeScriptRunMap(value.scriptRuns),
    context,
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
