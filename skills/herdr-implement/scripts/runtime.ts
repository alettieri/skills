import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { loadWorkflow } from './workflow.ts';
import type { NormalizedPhase, NormalizedWorkflow } from './workflow.ts';

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
  workspace_id?: string;
  worktreePath?: string;
  path?: string;
  cwd?: string;
  branch?: string;
  base?: string;
};

type WorktreeListOutput = {
  worktrees?: unknown[];
  items?: unknown[];
};

type SafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; issues: string[] };

type HerdrPaneReference = {
  id: string | null;
};

type HerdrPaneInfo = {
  paneId: string | null;
  tabId: string | null;
  terminalId: string | null;
};

type AgentStatus = 'working' | 'blocked' | 'idle' | 'missing' | 'unknown';

type HerdrAgentInfo = {
  agentName: string | null;
  paneId: string | null;
  tabId: string | null;
  terminalId: string | null;
  status: AgentStatus;
  rawStatus: string | null;
};

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

  try {
    return JSON.parse(stdout) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`herdr ${args.join(' ')} returned invalid JSON: ${message}`);
  }
}

function formatValidationError(label: string, issues: string[]): Error {
  return new Error(`${label} validation failed: ${issues.join('; ')}`);
}

function safeParseWorktreeRecord(value: unknown, path: string): SafeParseResult<HerdrWorktreeRecord> {
  if (!isRecord(value)) {
    return { success: false, issues: [`${path} must be an object`] };
  }

  const issues: string[] = [];
  for (const field of ['workspaceId', 'workspace_id', 'worktreePath', 'path', 'cwd', 'branch', 'base'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'string') {
      issues.push(`${path}.${field} must be a string when present`);
    }
  }

  if (issues.length > 0) {
    return { success: false, issues };
  }

  return { success: true, data: value as HerdrWorktreeRecord };
}

function safeParseWorktreeRecords(records: unknown[], path: string): SafeParseResult<HerdrWorktreeRecord[]> {
  const parsed: HerdrWorktreeRecord[] = [];
  const issues: string[] = [];

  records.forEach((record, index) => {
    const result = safeParseWorktreeRecord(record, `${path}[${index}]`);
    if (result.success) {
      parsed.push(result.data);
    } else {
      issues.push(...result.issues);
    }
  });

  if (issues.length > 0) {
    return { success: false, issues };
  }

  return { success: true, data: parsed };
}

function safeParseWorktreeList(value: unknown): SafeParseResult<HerdrWorktreeRecord[]> {
  if (Array.isArray(value)) {
    return safeParseWorktreeRecords(value, 'worktree list');
  }

  if (isRecord(value)) {
    const output = value as WorktreeListOutput;
    if (output.worktrees !== undefined && !Array.isArray(output.worktrees)) {
      return { success: false, issues: ['worktree list.worktrees must be an array when present'] };
    }
    if (output.items !== undefined && !Array.isArray(output.items)) {
      return { success: false, issues: ['worktree list.items must be an array when present'] };
    }

    const records = output.worktrees ?? output.items;
    if (Array.isArray(records)) {
      return safeParseWorktreeRecords(records, output.worktrees !== undefined ? 'worktree list.worktrees' : 'worktree list.items');
    }
  }

  return { success: false, issues: ['worktree list output must be an array or an object with worktrees/items'] };
}

function parseWorktreeListOutput(value: unknown): HerdrWorktreeRecord[] {
  const parsed = safeParseWorktreeList(value);
  if (!parsed.success) {
    throw formatValidationError('herdr worktree list output', parsed.issues);
  }
  return parsed.data;
}

function safeParseWorktreeCreate(value: unknown): SafeParseResult<HerdrWorktreeRecord> {
  return safeParseWorktreeRecord(value, 'worktree create');
}

function parseWorktreeCreateOutput(value: unknown): HerdrWorktreeRecord {
  const parsed = safeParseWorktreeCreate(value);
  if (!parsed.success) {
    throw formatValidationError('herdr worktree create output', parsed.issues);
  }
  return parsed.data;
}

function safeParsePaneReference(value: unknown, label: string): SafeParseResult<HerdrPaneReference> {
  if (typeof value === 'string') {
    return { success: true, data: { id: optionalString(value) } };
  }

  if (!isRecord(value)) {
    return { success: false, issues: [`${label} output must be a string id or object`] };
  }

  for (const field of ['tabId', 'paneId', 'id'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'string') {
      return { success: false, issues: [`${label}.${field} must be a string when present`] };
    }
  }

  return {
    success: true,
    data: {
      id: optionalString(value.tabId) ?? optionalString(value.paneId) ?? optionalString(value.id),
    },
  };
}

function parsePaneReference(value: unknown, label: string, required: boolean): HerdrPaneReference {
  const parsed = safeParsePaneReference(value, label);
  if (!parsed.success) {
    throw formatValidationError(`herdr ${label} output`, parsed.issues);
  }
  if (required && !parsed.data.id) {
    throw formatValidationError(`herdr ${label} output`, [`${label} did not include an id`]);
  }
  return parsed.data;
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

  return record.workspaceId ?? record.workspace_id ?? null;
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

function unwrapHerdrResult(value: unknown): unknown {
  if (isRecord(value) && Object.hasOwn(value, 'result')) {
    return value.result;
  }
  return value;
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

type HerdrAgentLaunchResult = {
  paneId: string | null;
  tabId: string | null;
  terminalId: string | null;
  agentName: string | null;
};

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = optionalString(record[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

function normalizeAgentLaunchResult(value: unknown): HerdrAgentLaunchResult {
  const payload = unwrapHerdrResult(value);
  if (typeof value === 'string') {
    return {
      paneId: optionalString(value),
      tabId: null,
      terminalId: null,
      agentName: null,
    };
  }

  if (!isRecord(payload)) {
    return {
      paneId: null,
      tabId: null,
      terminalId: null,
      agentName: null,
    };
  }

  const agent = isRecord(payload.agent) ? payload.agent : payload;
  return {
    paneId: firstString(agent, ['paneId', 'pane_id', 'id']),
    tabId: firstString(agent, ['tabId', 'tab_id']),
    terminalId: firstString(agent, ['terminalId', 'terminal_id']),
    agentName: firstString(agent, ['agentName', 'agent_name', 'name']),
  };
}

function normalizePaneInfo(value: unknown): HerdrPaneInfo {
  const payload = unwrapHerdrResult(value);
  if (typeof payload === 'string') {
    return { paneId: optionalString(payload), tabId: null, terminalId: null };
  }

  if (!isRecord(payload)) {
    return { paneId: null, tabId: null, terminalId: null };
  }

  const moveResult = isRecord(payload.move_result) ? payload.move_result : null;
  const pane = moveResult && isRecord(moveResult.pane) ? moveResult.pane : payload;
  const createdTab = moveResult && isRecord(moveResult.created_tab) ? moveResult.created_tab : null;

  return {
    paneId: firstString(pane, ['paneId', 'pane_id', 'id']),
    tabId: (createdTab ? firstString(createdTab, ['tabId', 'tab_id', 'id']) : null) ?? firstString(pane, ['tabId', 'tab_id']),
    terminalId: firstString(pane, ['terminalId', 'terminal_id']),
  };
}

function resolvePromptTemplatePath(cwd: string, workflowPath: string, templateName: string): string {
  const projectPath = join(dirname(resolve(workflowPath)), 'prompts', templateName);
  if (existsSync(projectPath)) {
    return projectPath;
  }

  const skillPath = resolve(cwd, 'skills/herdr-implement/prompts', templateName);
  if (existsSync(skillPath)) {
    return skillPath;
  }

  throw new Error(`prompt template does not exist: ${templateName}`);
}

function readPromptTemplate(cwd: string, workflowPath: string, templateName: string): string {
  const templatePath = resolvePromptTemplatePath(cwd, workflowPath, templateName);
  return readFileSync(templatePath, 'utf8');
}

function renderTemplate(source: string, values: Record<string, string>): string {
  return source.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key: string) => values[key] ?? '');
}

function agentRunPrefix(issue: IssueReference): string {
  return issue.number === null ? 'issue-bootstrap' : `issue-${issue.number}`;
}

function buildAgentRunId(issue: IssueReference, roleId: string, attemptNumber: number): string {
  return `${agentRunPrefix(issue)}-${roleId}-${attemptNumber}`;
}

function buildNotifyTarget(issue: IssueReference): string {
  return `${agentRunPrefix(issue)}-orchestrator`;
}

function buildCompletionUtilityCommand(): string {
  return 'node skills/herdr-worktree-flow/scripts/agent-run-complete.ts';
}

function renderAgentName(template: string, state: WorkflowRunState, roleId: string): string {
  return renderTemplate(template, {
    'issue.canonical': state.issue.canonical,
    'issue.input': state.issue.input,
    'issue.number': String(state.issue.number ?? ''),
    roleId,
  });
}

function completionRoleFor(roleId: string): 'implementer' | 'reviewer' {
  return roleId === 'reviewer' ? 'reviewer' : 'implementer';
}

function buildAgentStartArgs(
  agentName: string,
  worktreePath: string,
  workspaceId: string,
  role: Record<string, unknown>,
): string[] {
  const approval = requireString(role.approval, 'roles.approval');
  const sandbox = requireString(role.sandbox, 'roles.sandbox');
  const model = requireString(role.model, 'roles.model');

  return [
    'agent',
    'start',
    agentName,
    '--cwd',
    worktreePath,
    '--workspace',
    workspaceId,
    '--focus',
    '--',
    'codex',
    '-a',
    approval,
    '-m',
    model,
    '-s',
    sandbox,
  ];
}

function buildAgentMoveArgs(paneId: string, workspaceId: string, roleLabel: string): string[] {
  return ['pane', 'move', paneId, '--new-tab', '--workspace', workspaceId, '--label', roleLabel, '--focus'];
}

function buildAgentSendArgs(agentName: string, prompt: string): string[] {
  return ['agent', 'send', agentName, prompt];
}

function buildAgentSendEnterArgs(paneId: string): string[] {
  return ['pane', 'send-keys', paneId, 'Return'];
}

function buildAgentGetArgs(agentName: string): string[] {
  return ['agent', 'get', agentName];
}

function buildAgentReadArgs(agentName: string): string[] {
  return ['agent', 'read', agentName];
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
    notifyTarget: buildNotifyTarget(state.issue),
    attemptNumber,
    startedAt,
    status: 'pending',
  };
}

function completePendingAgentRun(run: PendingAgentRunState, startedAt: string): PendingAgentRunState {
  return {
    ...run,
    startedAt,
    status: 'pending',
  };
}

function hasAcceptedRun(state: WorkflowRunState, runId: string): boolean {
  return Object.hasOwn(state.acceptedAgentRuns, runId);
}

function parseAgentStatus(value: unknown): HerdrAgentInfo {
  if (!isRecord(value)) {
    return {
      agentName: null,
      paneId: null,
      tabId: null,
      terminalId: null,
      status: 'missing',
      rawStatus: null,
    };
  }

  const result = isRecord(value.result) ? value.result : value;
  const agent = isRecord(result.agent) ? result.agent : result;
  const agentName = firstString(agent, ['agentName', 'agent_name', 'name']);
  const paneId = firstString(agent, ['paneId', 'pane_id', 'id']);
  const tabId = firstString(agent, ['tabId', 'tab_id']);
  const terminalId = firstString(agent, ['terminalId', 'terminal_id']);
  const rawStatus = firstString(agent, ['agent_status', 'status', 'state', 'mode']);
  const status = rawStatus === 'working' || rawStatus === 'blocked' || rawStatus === 'idle' ? rawStatus : 'unknown';

  return {
    agentName,
    paneId,
    tabId,
    terminalId,
    status: status === 'unknown' && !paneId && !agentName ? 'missing' : status,
    rawStatus,
  };
}

function queryHerdrAgentStatus(runner: HerdrCommandRunner, agentName: string): HerdrAgentInfo {
  try {
    const result = runner.run(buildAgentGetArgs(agentName));
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      return {
        agentName,
        paneId: null,
        tabId: null,
        terminalId: null,
        status: 'missing',
        rawStatus: null,
      };
    }

    const parsed = parseMaybeJson(result.stdout);
    const agentInfo = parseAgentStatus(parsed);
    return {
      ...agentInfo,
      agentName: agentInfo.agentName ?? agentName,
    };
  } catch {
    return {
      agentName,
      paneId: null,
      tabId: null,
      terminalId: null,
      status: 'missing',
      rawStatus: null,
    };
  }
}

function readHerdrAgentTranscript(runner: HerdrCommandRunner, agentName: string): string {
  const result = runner.run(buildAgentReadArgs(agentName));
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`herdr agent read failed with exit ${result.status}: ${result.stderr.trim()}`);
  }

  return result.stdout.trim();
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

  const agentNameTemplate = optionalString(role.agentNameTemplate);
  if (!agentNameTemplate) {
    return null;
  }

  return renderAgentName(agentNameTemplate, state, roleId);
}

function rewritePendingArtifact(
  runner: HerdrCommandRunner,
  statePath: string,
  state: WorkflowRunState,
  handleState: DaemonHandleState,
  pendingRun: PendingAgentRunState,
  phase: NormalizedPhase,
  reason: string,
  now: () => Date,
): { handleState: DaemonHandleState; state: WorkflowRunState; result: DaemonStepResult } {
  const agentName = agentTargetForPendingRun(state, handleState, pendingRun);
  if (!agentName) {
    return {
      handleState,
      state,
      result: {
        status: 'stop',
        currentPhase: pendingRun.phaseId,
        reason: `unable to resolve agent target for rewrite: ${reason}`,
      },
    };
  }

  const roleAgent = loadRoleAgent(handleState, pendingRun.roleId);
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

  const sendResult = runner.run(buildAgentSendArgs(agentName, prompt));
  if (sendResult.error) {
    const updatedAt = nowIso(now);
    const refreshed = {
      ...state,
      updatedAt,
      context: {
        ...state.context,
        lastArtifactRewriteRequest: {
          runId: pendingRun.runId,
          phaseId: pendingRun.phaseId,
          roleId: pendingRun.roleId,
          reason: `${reason}; rewrite request could not be delivered`,
          requestedAt: updatedAt,
        },
      },
    };
    saveRunState(statePath, refreshed);
    return {
      handleState,
      state: refreshed,
      result: {
        status: 'stop',
        currentPhase: pendingRun.phaseId,
        reason: `unable to deliver artifact rewrite request for ${pendingRun.runId}: ${sendResult.error.message}`,
      },
    };
  }
  if (sendResult.status !== 0) {
    const updatedAt = nowIso(now);
    const refreshed = {
      ...state,
      updatedAt,
      context: {
        ...state.context,
        lastArtifactRewriteRequest: {
          runId: pendingRun.runId,
          phaseId: pendingRun.phaseId,
          roleId: pendingRun.roleId,
          reason: `${reason}; rewrite request could not be delivered`,
          requestedAt: updatedAt,
        },
      },
    };
    saveRunState(statePath, refreshed);
    return {
      handleState,
      state: refreshed,
      result: {
        status: 'stop',
        currentPhase: pendingRun.phaseId,
        reason: `unable to deliver artifact rewrite request for ${pendingRun.runId}: ${sendResult.stderr.trim()}`,
      },
    };
  }

  if (roleAgent?.paneId) {
    const enterResult = runner.run(buildAgentSendEnterArgs(roleAgent.paneId));
    if (enterResult.error) {
      const updatedAt = nowIso(now);
      const refreshed = {
        ...state,
        updatedAt,
        context: {
          ...state.context,
          lastArtifactRewriteRequest: {
            runId: pendingRun.runId,
            phaseId: pendingRun.phaseId,
            roleId: pendingRun.roleId,
            reason: `${reason}; rewrite request could not be delivered`,
            requestedAt: updatedAt,
          },
        },
      };
      saveRunState(statePath, refreshed);
      return {
        handleState,
        state: refreshed,
        result: {
          status: 'stop',
          currentPhase: pendingRun.phaseId,
          reason: `unable to deliver rewrite completion to ${agentName}: ${enterResult.error.message}`,
        },
      };
    }
    if (enterResult.status !== 0) {
      const updatedAt = nowIso(now);
      const refreshed = {
        ...state,
        updatedAt,
        context: {
          ...state.context,
          lastArtifactRewriteRequest: {
            runId: pendingRun.runId,
            phaseId: pendingRun.phaseId,
            roleId: pendingRun.roleId,
            reason: `${reason}; rewrite request could not be delivered`,
            requestedAt: updatedAt,
          },
        },
      };
      saveRunState(statePath, refreshed);
      return {
        handleState,
        state: refreshed,
        result: {
          status: 'stop',
          currentPhase: pendingRun.phaseId,
          reason: `unable to deliver rewrite completion to ${agentName}: ${enterResult.stderr.trim()}`,
        },
      };
    }
  }

  const updatedAt = nowIso(now);
  const refreshed = {
    ...state,
    context: {
      ...state.context,
      lastArtifactRewriteRequest: {
        runId: pendingRun.runId,
        phaseId: pendingRun.phaseId,
        roleId: pendingRun.roleId,
        reason,
        requestedAt: updatedAt,
      },
    },
    updatedAt,
  };
  saveRunState(statePath, refreshed);

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

function readResultArtifact(resultPath: string): ResultArtifact | null {
  if (!existsSync(resultPath)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resultPath, 'utf8')) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`result artifact is not valid JSON: ${message}`);
  }

  if (!isRecord(parsed)) {
    throw new Error('result artifact must be a JSON object');
  }

  const schemaVersion = parsed.schemaVersion;
  if (schemaVersion !== 1) {
    throw new Error('result artifact schemaVersion must be 1');
  }

  const runId = optionalString(parsed.runId);
  const role = optionalString(parsed.role);
  const phase = optionalString(parsed.phase);
  const status =
    parsed.status === 'complete' || parsed.status === 'blocked' || parsed.status === 'failed' ? parsed.status : null;
  const outcome = optionalString(parsed.outcome);
  const summary = optionalString(parsed.summary);
  const capture = parsed.capture === undefined ? null : normalizeCapture(parsed.capture);
  const payload = parsed.payload === undefined ? null : normalizeCapture(parsed.payload);
  const resultSchema = optionalString(parsed.resultSchema);

  if (!runId || !role || !phase || !status || !outcome) {
    throw new Error('result artifact is missing required completion fields');
  }

  if (parsed.capture !== undefined && capture === null) {
    throw new Error('result artifact capture must be an object with string keys');
  }

  if (parsed.payload !== undefined && payload === null) {
    throw new Error('result artifact payload must be an object with string keys');
  }

  return {
    schemaVersion,
    runId,
    role,
    phase,
    status,
    outcome,
    capture,
    summary,
    payload,
    resultSchema,
  };
}

function resultArtifactMatchesSchema(
  artifact: ResultArtifact,
  expectedResultSchema: string | null,
): boolean {
  if (!expectedResultSchema) {
    return true;
  }

  return artifact.resultSchema === expectedResultSchema;
}

function validateResultArtifact(
  artifact: ResultArtifact,
  pendingRun: PendingAgentRunState,
  phase: NormalizedPhase,
): void {
  if (artifact.runId !== pendingRun.runId) {
    throw new Error(`result artifact runId mismatch: expected ${pendingRun.runId}, found ${artifact.runId}`);
  }
  if (artifact.phase !== pendingRun.phaseId) {
    throw new Error(`result artifact phase mismatch: expected ${pendingRun.phaseId}, found ${artifact.phase}`);
  }
  if (artifact.role !== pendingRun.completionRole) {
    throw new Error(`result artifact role mismatch: expected ${pendingRun.completionRole}, found ${artifact.role}`);
  }
  if (!resultArtifactMatchesSchema(artifact, pendingRun.resultSchema ?? optionalString(phase.resultSchema))) {
    throw new Error(
      `result artifact schema mismatch: expected ${pendingRun.resultSchema ?? optionalString(phase.resultSchema) ?? 'any'}, found ${artifact.resultSchema ?? 'missing'}`,
    );
  }
  if (!Object.hasOwn(phase.on, artifact.outcome)) {
    throw new Error(`result artifact outcome ${artifact.outcome} is not declared by phase ${pendingRun.phaseId}`);
  }
  if (artifact.capture !== null && !isRecord(artifact.capture)) {
    throw new Error('result artifact capture must be an object with string keys');
  }
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

function recordAcceptedAgentRun(
  state: WorkflowRunState,
  pendingRun: PendingAgentRunState,
  artifact: ResultArtifact,
  acceptedAt: string,
): WorkflowRunState {
  const acceptedRun: AcceptedAgentRunState = {
    runId: pendingRun.runId,
    phaseId: pendingRun.phaseId,
    roleId: pendingRun.roleId,
    roleLabel: pendingRun.roleLabel,
    agentName: pendingRun.agentName,
    resultSchema: pendingRun.resultSchema ?? artifact.resultSchema,
    resultPath: pendingRun.resultPath,
    acceptedAt,
    status: artifact.status,
    outcome: artifact.outcome,
    summary: artifact.summary,
    capture: artifact.capture,
  };

  return {
    ...state,
    currentPhase: resolveNextPhase(state.workflow, pendingRun.phaseId, artifact.outcome) ?? state.currentPhase,
    context: mergeCaptureIntoContext(state.context, artifact.capture),
    pendingAgentRun: null,
    acceptedAgentRuns: {
      ...state.acceptedAgentRuns,
      [pendingRun.runId]: acceptedRun,
    },
    updatedAt: acceptedAt,
  };
}

function createAcceptedAgentRunSummary(artifact: ResultArtifact, pendingRun: PendingAgentRunState): string {
  return [
    `accepted result artifact for ${pendingRun.runId}`,
    `outcome=${artifact.outcome}`,
    `status=${artifact.status}`,
    artifact.summary ? `summary=${artifact.summary}` : 'summary=(none)',
  ].join('; ');
}

function hasPendingAgentRun(state: WorkflowRunState): boolean {
  return state.pendingAgentRun !== null;
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

function launchRoleAgent(
  runner: HerdrCommandRunner,
  cwd: string,
  state: WorkflowRunState,
  handleState: DaemonHandleState,
  phaseId: string,
  roleId: string,
  agentName: string,
): { handleState: DaemonHandleState; roleAgent: RoleAgentState } {
  const phase = state.workflow.phases[phaseId];
  if (!phase || phase.type !== 'agent') {
    throw new Error(`phase ${phaseId} is not an agent phase`);
  }

  const role = state.workflow.roles[roleId];
  if (!role) {
    throw new Error(`phase ${phaseId} references unknown role: ${roleId}`);
  }

  const now = nowIso();
  const startResult = normalizeAgentLaunchResult(
    runHerdrJson(
      runner,
      buildAgentStartArgs(agentName, state.worktreePath, state.workspaceId, role),
    ),
  );
  if (!startResult.paneId) {
    throw new Error(`herdr agent start for ${agentName} did not include a pane id`);
  }
  const movedResult = normalizePaneInfo(
    runHerdrJson(runner, buildAgentMoveArgs(startResult.paneId, state.workspaceId, requireString(role.label, `roles.${roleId}.label`))),
  );

  const roleAgent: RoleAgentState = {
    roleId,
    roleLabel: requireString(role.label, `roles.${roleId}.label`),
    agentName,
    tabId: movedResult.tabId ?? startResult.tabId,
    paneId: movedResult.paneId ?? startResult.paneId,
    terminalId: movedResult.terminalId ?? startResult.terminalId,
    createdAt: now,
    updatedAt: now,
  };

  return {
    handleState: saveRoleAgent(handleState, roleAgent),
    roleAgent,
  };
}

function renderAgentPhasePrompt(
  cwd: string,
  state: WorkflowRunState,
  phaseId: string,
  roleId: string,
  pendingRun: PendingAgentRunState,
): { prompt: string; pendingRun: PendingAgentRunState } {
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
  const prompt = [
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

  return {
    prompt,
    pendingRun,
  };
}

function dispatchAgentPhase(
  runner: HerdrCommandRunner,
  cwd: string,
  statePath: string,
  handleStatePath: string,
  state: WorkflowRunState,
  handleState: DaemonHandleState,
  phaseId: string,
  now: () => Date,
): { state: WorkflowRunState; handleState: DaemonHandleState; result: DaemonStepResult } {
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
  const attemptNumber = 1;
  const startedAt = nowIso(now);
  const baseAgentName = renderAgentName(requireString(role.agentNameTemplate, `roles.${roleId}.agentNameTemplate`), state, roleId);
  const runId = buildAgentRunId(state.issue, `${phaseId}-${roleId}`, attemptNumber);
  const agentName = reuseRole ? baseAgentName : `${baseAgentName}-${runId}`;
  const pendingRun = createPendingAgentRun(
    state,
    runId,
    phaseId,
    roleId,
    completionRoleFor(roleId),
    requireString(role.label, `roles.${roleId}.label`),
    agentName,
    optionalString(phase.resultSchema),
    attemptNumber,
    startedAt,
  );
  const reusedRole = reuseRole ? loadRoleAgent(handleState, roleId) : null;
  let nextHandleState = handleState;
  let roleAgent = reusedRole;
  if (!roleAgent) {
    const launched = launchRoleAgent(runner, cwd, state, nextHandleState, phaseId, roleId, agentName);
    nextHandleState = launched.handleState;
    roleAgent = launched.roleAgent;
  }

  if (!roleAgent?.agentName || !roleAgent.paneId) {
    throw new Error(`role ${roleId} is missing Herdr agent handles`);
  }

  const prompt = renderAgentPhasePrompt(cwd, state, phaseId, roleId, pendingRun).prompt;

  const sendResult = runner.run(buildAgentSendArgs(roleAgent.agentName, prompt));
  if (sendResult.error) {
    throw sendResult.error;
  }
  if (sendResult.status !== 0) {
    throw new Error(`herdr agent send failed with exit ${sendResult.status}: ${sendResult.stderr.trim()}`);
  }

  const enterResult = runner.run(buildAgentSendEnterArgs(roleAgent.paneId));
  if (enterResult.error) {
    throw enterResult.error;
  }
  if (enterResult.status !== 0) {
    throw new Error(`herdr pane send-keys failed with exit ${enterResult.status}: ${enterResult.stderr.trim()}`);
  }

  const updatedRunState: WorkflowRunState = {
    ...state,
    updatedAt: startedAt,
    pendingAgentRun: completePendingAgentRun(pendingRun, startedAt),
  };
  const updatedRoleAgent: RoleAgentState = {
    ...roleAgent,
    updatedAt: startedAt,
  };
  nextHandleState = reuseRole ? saveRoleAgent(nextHandleState, updatedRoleAgent) : nextHandleState;
  saveRunState(statePath, updatedRunState);
  saveHandleState(handleStatePath, nextHandleState);

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

function createWorktreeIfNeeded(
  runner: HerdrCommandRunner,
  repository: RepositoryInfo,
  branchName: string,
  issueLabel: string,
): WorktreeInfo {
  const worktreeList = parseWorktreeListOutput(
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

  const createdRecord = parseWorktreeCreateOutput(created);
  const workspaceId = optionalString(createdRecord.workspaceId) ?? optionalString(createdRecord.workspace_id);
  const worktreePath =
    optionalString(createdRecord.worktreePath) ?? optionalString(createdRecord.path) ?? optionalString(createdRecord.cwd);

  const resolvedList = parseWorktreeListOutput(
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
  const tabId = parsePaneReference(tabOutput, 'tab create', false).id;

  const paneCurrent = runner.run(['pane', 'current', '--current']);
  if (paneCurrent.error) {
    throw paneCurrent.error;
  }
  if (paneCurrent.status !== 0) {
    throw new Error(`herdr pane current failed with exit ${paneCurrent.status}: ${paneCurrent.stderr.trim()}`);
  }

  const paneOutput = parseMaybeJson(paneCurrent.stdout);
  const paneId = parsePaneReference(paneOutput, 'pane current', true).id;
  if (!paneId) {
    throw formatValidationError('herdr pane current output', ['pane current did not include an id']);
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
      roleAgents: {},
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
    pendingAgentRun: null,
    acceptedAgentRuns: {},
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

function processPendingAgentRun(
  runner: HerdrCommandRunner,
  state: WorkflowRunState,
  handleState: DaemonHandleState,
  statePath: string,
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

  if (hasAcceptedRun(state, pendingRun.runId)) {
    const updatedAt = nowIso(now);
    const acceptedRun = state.acceptedAgentRuns[pendingRun.runId];
    const nextPhase = resolveNextPhase(state.workflow, acceptedRun.phaseId, acceptedRun.outcome);
    const refreshed = {
      ...state,
      currentPhase: nextPhase ?? state.currentPhase,
      pendingAgentRun: null,
      updatedAt,
    };
    saveRunState(statePath, refreshed);
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

  let artifact: ResultArtifact | null;
  try {
    artifact = readResultArtifact(pendingRun.resultPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return rewritePendingArtifact(runner, statePath, state, handleState, pendingRun, phase, message, now);
  }
  if (artifact) {
    try {
      validateResultArtifact(artifact, pendingRun, phase);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isStale = /runId mismatch|phase mismatch|role mismatch/.test(message);
      if (isStale) {
        const updatedAt = nowIso(now);
        const refreshed = {
          ...state,
          updatedAt,
          context: {
            ...state.context,
            lastRejectedAgentResult: {
              runId: artifact.runId,
              expectedRunId: pendingRun.runId,
              phaseId: pendingRun.phaseId,
              roleId: pendingRun.roleId,
              reason: message,
              rejectedAt: updatedAt,
            },
          },
        };
        saveRunState(statePath, refreshed);
        return rewritePendingArtifact(runner, statePath, refreshed, handleState, pendingRun, phase, message, now);
      }

      return rewritePendingArtifact(runner, statePath, state, handleState, pendingRun, phase, message, now);
    }

    const acceptedAt = nowIso(now);
    const updatedState = recordAcceptedAgentRun(state, pendingRun, artifact, acceptedAt);
    saveRunState(statePath, updatedState);
    return {
      state: updatedState,
      result: {
        status: 'continue',
        currentPhase: pendingRun.phaseId,
        nextPhase: updatedState.currentPhase,
        reason: createAcceptedAgentRunSummary(artifact, pendingRun),
      },
    };
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
      const routed = {
        ...refreshed,
        currentPhase: blockedPhase,
        pendingAgentRun: null,
      };
      saveRunState(statePath, routed);
      return {
        state: routed,
        result: {
          status: 'continue',
          currentPhase: pendingRun.phaseId,
          nextPhase: blockedPhase,
          reason: `missing agent target for ${pendingRun.runId}`,
        },
      };
    }

    saveRunState(statePath, refreshed);
    return {
      state: refreshed,
      result: {
        status: 'stop',
        currentPhase: pendingRun.phaseId,
        reason: `missing agent target for ${pendingRun.runId}`,
      },
    };
  }

  const agentInfo = queryHerdrAgentStatus(runner, agentName);
  const updatedAt = nowIso(now);

  if (agentInfo.status === 'working') {
    const refreshed = {
      ...state,
      updatedAt,
    };
    saveRunState(statePath, refreshed);
    return {
      state: refreshed,
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
    saveRunState(statePath, refreshed);
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
    saveRunState(statePath, refreshed);
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
    if (optionalString(existingIdleRecovery?.runId) === pendingRun.runId) {
      const blockedPhase = resolveNextPhase(state.workflow, pendingRun.phaseId, 'blocked');
      const refreshed = {
        ...state,
        updatedAt,
        pendingAgentRun: blockedPhase ? null : state.pendingAgentRun,
        currentPhase: blockedPhase ?? state.currentPhase,
      };
      saveRunState(statePath, refreshed);
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

    const transcript = readHerdrAgentTranscript(runner, agentName);
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
    saveRunState(statePath, refreshed);
    return rewritePendingArtifact(
      runner,
      statePath,
      refreshed,
      handleState,
      pendingRun,
      phase,
      'agent is idle without a valid result artifact',
      now,
    );
  }

  const refreshed = {
    ...state,
    updatedAt,
  };
  saveRunState(statePath, refreshed);
  return {
    state: refreshed,
    result: {
      status: 'sleep',
      currentPhase: pendingRun.phaseId,
      reason: `waiting on agent run ${pendingRun.runId}`,
    },
  };
}

export function daemonStep(options: DaemonOptions): DaemonStepResult {
  const cwd = resolve(options.cwd ?? process.cwd());
  const statePath = options.statePath ? resolve(cwd, options.statePath) : join(cwd, RUN_STATE_PATH);
  const handleStatePath = options.handleStatePath ? resolve(cwd, options.handleStatePath) : join(cwd, HANDLE_STATE_PATH);
  const now = options.now ?? (() => new Date());
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

  if (hasPendingAgentRun(advanced)) {
    const processed = processPendingAgentRun(runner, advanced, handleState, statePath, now);
    return processed.result;
  }

  const currentPhase = advanced.currentPhase;
  const phase = advanced.workflow.phases[currentPhase];
  if (phase?.type === 'agent') {
    const dispatched = dispatchAgentPhase(runner, cwd, statePath, handleStatePath, advanced, handleState, currentPhase, now);
    return dispatched.result;
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
