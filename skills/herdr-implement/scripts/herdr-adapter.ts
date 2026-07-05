import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export type HerdrCommandResult = {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: Error;
};

export type HerdrCommandRunner = {
  run(args: readonly string[]): HerdrCommandResult;
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

export type HerdrCommandFailure = {
  kind: 'command-failed';
  command: string;
  exitCode: number | null;
  stderr: string;
};

export type HerdrPaneInfo = {
  paneId: string | null;
  tabId: string | null;
  terminalId: string | null;
};

export type HerdrAgentStatus = 'working' | 'blocked' | 'idle' | 'missing' | 'unknown';

export type HerdrAgentInfo = {
  agentName: string | null;
  paneId: string | null;
  tabId: string | null;
  terminalId: string | null;
  status: HerdrAgentStatus;
  rawStatus: string | null;
  failure: HerdrCommandFailure | null;
};

export type HerdrAdapter = {
  ensureWorktree(repository: RepositoryInfo, branchName: string, issueLabel: string): WorktreeInfo;
  createDaemonPane(workspaceId: string, worktreePath: string): HerdrPaneInfo;
  runPaneCommand(paneId: string, command: string): void;
  launchRoleAgent(
    worktreePath: string,
    workspaceId: string,
    role: Record<string, unknown>,
    roleLabel: string,
    agentName: string,
  ): HerdrPaneInfo;
  sendPrompt(agentName: string, prompt: string): void;
  submitPrompt(paneId: string): void;
  getAgentStatus(agentName: string): HerdrAgentInfo;
  readAgentTranscript(agentName: string): string;
};

// Raw Herdr worktree payloads stay loose at the boundary because Herdr may
// emit either camelCase or snake_case keys, and fields can be omitted until we
// normalize them below.
type RawHerdrWorktreeRecord = {
  readonly workspaceId?: string;
  readonly path?: string;
  readonly cwd?: string;
  readonly worktreePath?: string;
  readonly branch?: string;
  readonly base?: string;
};

type NormalizedHerdrWorktreeRecord = {
  workspaceId: string;
  worktreePath: string;
  branch: string;
  base: string | null;
};

// Herdr has used both `worktrees` and `items` for list envelopes. The array
// elements stay `unknown` so each record is validated at the parser boundary.
type WorktreeListOutput = {
  readonly worktrees?: readonly unknown[];
  readonly items?: readonly unknown[];
};

type HerdrWorktreeListArgs = readonly ['worktree', 'list', '--cwd', string, '--json'];
type HerdrWorktreeCreateArgs = readonly [
  'worktree',
  'create',
  '--cwd',
  string,
  '--branch',
  string,
  '--base',
  string,
  '--label',
  string,
  '--focus',
  '--json',
];
type HerdrAgentStartArgs = readonly [
  'agent',
  'start',
  string,
  '--cwd',
  string,
  '--workspace',
  string,
  '--focus',
  '--',
  'codex',
  '-a',
  string,
  '-m',
  string,
  '-s',
  string,
];
type HerdrAgentMoveArgs = readonly ['pane', 'move', string, '--new-tab', '--workspace', string, '--label', string, '--focus'];
type HerdrAgentSendArgs = readonly ['agent', 'send', string, string];
type HerdrAgentSendEnterArgs = readonly ['pane', 'send-keys', string, 'Return'];
type HerdrAgentGetArgs = readonly ['agent', 'get', string];
type HerdrAgentReadArgs = readonly ['agent', 'read', string];

type SafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; issues: string[] };

type HerdrPaneReference = {
  id: string | null;
};

type HerdrAgentLaunchResult = {
  paneId: string | null;
  tabId: string | null;
  terminalId: string | null;
  agentName: string | null;
};

const DEFAULT_DAEMON_LABEL = 'herdr-implement-daemon';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function buildDefaultRunner(): HerdrCommandRunner {
  return {
    run(args: readonly string[]): HerdrCommandResult {
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
}

function createCommandError(command: string, result: HerdrCommandResult): HerdrCommandFailure {
  return {
    kind: 'command-failed',
    command,
    exitCode: result.status,
    stderr: result.stderr.trim(),
  };
}

function parseLiteralOrJsonOutput(stdout: string, label: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${label} returned invalid JSON: ${message}`);
    }
  }

  return trimmed;
}

function parseStrictJsonOutput(stdout: string, label: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} returned invalid JSON: ${message}`);
  }
}

function unwrapHerdrResult(value: unknown): unknown {
  if (isRecord(value) && Object.hasOwn(value, 'result')) {
    return value.result;
  }
  return value;
}

function formatValidationError(label: string, issues: string[]): Error {
  return new Error(`${label} validation failed: ${issues.join('; ')}`);
}

function safeParseRawWorktreeRecord(value: unknown, path: string): SafeParseResult<RawHerdrWorktreeRecord> {
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

  return { success: true, data: value as RawHerdrWorktreeRecord };
}

function safeParseWorktreeRecords(records: readonly unknown[], path: string): SafeParseResult<readonly RawHerdrWorktreeRecord[]> {
  const parsed: RawHerdrWorktreeRecord[] = [];
  const issues: string[] = [];

  records.forEach((record, index) => {
    const result = safeParseRawWorktreeRecord(record, `${path}[${index}]`);
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

function safeParseWorktreeList(value: unknown): SafeParseResult<readonly RawHerdrWorktreeRecord[]> {
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

function parseWorktreeListOutput(value: unknown): readonly RawHerdrWorktreeRecord[] {
  const parsed = safeParseWorktreeList(value);
  if (!parsed.success) {
    throw formatValidationError('herdr worktree list output', parsed.issues);
  }
  return parsed.data;
}

function safeParseWorktreeCreate(value: unknown): SafeParseResult<RawHerdrWorktreeRecord> {
  return safeParseRawWorktreeRecord(value, 'worktree create');
}

function parseWorktreeCreateOutput(value: unknown): RawHerdrWorktreeRecord {
  const parsed = safeParseWorktreeCreate(value);
  if (!parsed.success) {
    throw formatValidationError('herdr worktree create output', parsed.issues);
  }
  return parsed.data;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = optionalString(record[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

function safeParsePaneReference(value: unknown, label: string): SafeParseResult<HerdrPaneReference> {
  if (typeof value === 'string') {
    return { success: true, data: { id: optionalString(value) } };
  }

  if (!isRecord(value)) {
    return { success: false, issues: [`${label} output must be a string id or object`] };
  }

  for (const field of ['tabId', 'tab_id', 'paneId', 'pane_id', 'id', 'terminalId', 'terminal_id'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'string') {
      return { success: false, issues: [`${label}.${field} must be a string when present`] };
    }
  }

  return {
    success: true,
    data: {
      id:
        optionalString(value.tabId) ??
        optionalString(value.tab_id) ??
        optionalString(value.paneId) ??
        optionalString(value.pane_id) ??
        optionalString(value.id) ??
        optionalString(value.terminalId) ??
        optionalString(value.terminal_id),
    },
  };
}

function parsePaneReference(value: unknown, label: string, required: boolean): HerdrPaneReference {
  const parsed = safeParsePaneReference(unwrapHerdrResult(value), label);
  if (!parsed.success) {
    throw formatValidationError(`herdr ${label} output`, parsed.issues);
  }
  if (required && !parsed.data.id) {
    throw formatValidationError(`herdr ${label} output`, [`${label} did not include an id`]);
  }
  return parsed.data;
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

function requirePaneInfo(value: unknown, label: string): HerdrPaneInfo {
  const paneInfo = normalizePaneInfo(value);
  const issues: string[] = [];

  if (!paneInfo.paneId) {
    issues.push(`${label} did not include a pane id`);
  }
  if (!paneInfo.tabId) {
    issues.push(`${label} did not include a tab id`);
  }
  if (!paneInfo.terminalId) {
    issues.push(`${label} did not include a terminal id`);
  }

  if (issues.length > 0) {
    throw formatValidationError(label, issues);
  }

  return paneInfo;
}

function safeRunHerdrJson(runner: HerdrCommandRunner, args: readonly string[]): unknown {
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

function safeRunHerdrCommand(runner: HerdrCommandRunner, args: readonly string[]): void {
  const result = runner.run(args);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const operation = args.slice(0, 2).join(' ');
    throw new Error(`herdr ${operation} failed with exit ${result.status}: ${result.stderr.trim()}. Command: herdr ${args.join(' ')}`);
  }
}

function buildAgentStartArgs(
  agentName: string,
  worktreePath: string,
  workspaceId: string,
  role: Record<string, unknown>,
): HerdrAgentStartArgs {
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

function buildAgentMoveArgs(paneId: string, workspaceId: string, roleLabel: string): HerdrAgentMoveArgs {
  return ['pane', 'move', paneId, '--new-tab', '--workspace', workspaceId, '--label', roleLabel, '--focus'];
}

function buildAgentSendArgs(agentName: string, prompt: string): HerdrAgentSendArgs {
  return ['agent', 'send', agentName, prompt];
}

function buildAgentSendEnterArgs(paneId: string): HerdrAgentSendEnterArgs {
  return ['pane', 'send-keys', paneId, 'Return'];
}

function buildAgentGetArgs(agentName: string): HerdrAgentGetArgs {
  return ['agent', 'get', agentName];
}

function buildAgentReadArgs(agentName: string): HerdrAgentReadArgs {
  return ['agent', 'read', agentName];
}

function buildWorktreeListArgs(rootPath: string): HerdrWorktreeListArgs {
  return ['worktree', 'list', '--cwd', rootPath, '--json'];
}

function buildWorktreeCreateArgs(repository: RepositoryInfo, branchName: string, issueLabel: string): HerdrWorktreeCreateArgs {
  return [
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
  ];
}

function workspaceIdFromRaw(record: RawHerdrWorktreeRecord): string | null {
  const raw = record as Record<string, unknown>;
  return optionalString(raw.workspaceId) ?? optionalString(raw.workspace_id);
}

function worktreePathFromRaw(record: RawHerdrWorktreeRecord): string | null {
  return optionalString(record.worktreePath) ?? optionalString(record.path) ?? optionalString(record.cwd);
}

function normalizeWorktreeRecord(record: RawHerdrWorktreeRecord, label: string): NormalizedHerdrWorktreeRecord {
  const workspaceId = workspaceIdFromRaw(record);
  const worktreePath = worktreePathFromRaw(record);
  const branch = optionalString(record.branch);
  const issues: string[] = [];

  if (!workspaceId) {
    issues.push(`${label} did not include a workspace id`);
  }
  if (!worktreePath) {
    issues.push(`${label} did not include a worktree path`);
  }
  if (!branch) {
    issues.push(`${label} did not include a branch`);
  }

  if (issues.length > 0) {
    throw formatValidationError(label, issues);
  }

  return {
    workspaceId: workspaceId!,
    worktreePath: worktreePath!,
    branch: branch!,
    base: optionalString(record.base),
  };
}

function chooseWorktreeRecord(
  records: readonly RawHerdrWorktreeRecord[],
  branchName: string,
  label: string,
): NormalizedHerdrWorktreeRecord | null {
  const record = records.find((entry) => optionalString(entry.branch) === branchName) ?? null;
  if (!record) {
    return null;
  }

  return normalizeWorktreeRecord(record, label);
}

function createWorktreeIfNeeded(
  runner: HerdrCommandRunner,
  repository: RepositoryInfo,
  branchName: string,
  issueLabel: string,
): WorktreeInfo {
  const worktreeList = parseWorktreeListOutput(unwrapHerdrResult(safeRunHerdrJson(runner, buildWorktreeListArgs(repository.rootPath))));
  const existing = chooseWorktreeRecord(worktreeList, branchName, 'worktree list');
  if (existing) {
    return {
      workspaceId: existing.workspaceId,
      worktreePath: existing.worktreePath,
      branchName: existing.branch,
    };
  }

  const created = unwrapHerdrResult(safeRunHerdrJson(runner, buildWorktreeCreateArgs(repository, branchName, issueLabel)));
  const createdRecord = normalizeWorktreeRecord(parseWorktreeCreateOutput(created), 'worktree create');

  return {
    workspaceId: createdRecord.workspaceId,
    worktreePath: createdRecord.worktreePath,
    branchName: createdRecord.branch,
  };
}

function createDaemonPane(
  runner: HerdrCommandRunner,
  workspaceId: string,
  worktreePath: string,
): HerdrPaneInfo {
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

  const tabOutput = parseLiteralOrJsonOutput(tabCreate.stdout, 'herdr tab create output');
  const tabId = parsePaneReference(tabOutput, 'tab create', false).id;

  const paneCurrent = runner.run(['pane', 'current', '--current']);
  if (paneCurrent.error) {
    throw paneCurrent.error;
  }
  if (paneCurrent.status !== 0) {
    throw new Error(`herdr pane current failed with exit ${paneCurrent.status}: ${paneCurrent.stderr.trim()}`);
  }

  const paneOutput = parseLiteralOrJsonOutput(paneCurrent.stdout, 'herdr pane current output');
  const paneId = parsePaneReference(paneOutput, 'pane current', true).id;
  if (!paneId) {
    throw formatValidationError('herdr pane current output', ['pane current did not include an id']);
  }

  return {
    tabId,
    paneId,
    terminalId: null,
  };
}

function runPaneCommand(runner: HerdrCommandRunner, paneId: string, command: string): void {
  safeRunHerdrCommand(runner, ['pane', 'run', paneId, command]);
}

function launchRoleAgent(
  runner: HerdrCommandRunner,
  worktreePath: string,
  workspaceId: string,
  role: Record<string, unknown>,
  roleLabel: string,
  agentName: string,
): HerdrPaneInfo {
  const start = runner.run(buildAgentStartArgs(agentName, worktreePath, workspaceId, role));
  if (start.error) {
    throw start.error;
  }
  if (start.status !== 0) {
    throw new Error(`herdr agent start failed with exit ${start.status}: ${start.stderr.trim()}`);
  }

  const startResult = normalizeAgentLaunchResult(parseLiteralOrJsonOutput(start.stdout, `herdr agent start ${agentName} output`));
  if (!startResult.paneId) {
    throw new Error(`herdr agent start for ${agentName} did not include a pane id`);
  }
  const move = runner.run(buildAgentMoveArgs(startResult.paneId, workspaceId, roleLabel));
  if (move.error) {
    throw move.error;
  }
  if (move.status !== 0) {
    throw new Error(`herdr pane move failed with exit ${move.status}: ${move.stderr.trim()}`);
  }
  const movedResult = requirePaneInfo(parseLiteralOrJsonOutput(move.stdout, `herdr pane move ${startResult.paneId} output`), `herdr pane move ${startResult.paneId} output`);

  return {
    tabId: movedResult.tabId,
    paneId: movedResult.paneId,
    terminalId: movedResult.terminalId,
  };
}

function sendPrompt(runner: HerdrCommandRunner, agentName: string, prompt: string): void {
  safeRunHerdrCommand(runner, buildAgentSendArgs(agentName, prompt));
}

function submitPrompt(runner: HerdrCommandRunner, paneId: string): void {
  safeRunHerdrCommand(runner, buildAgentSendEnterArgs(paneId));
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
      failure: null,
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
    failure: null,
  };
}

function requireAgentStatus(value: unknown, label: string): HerdrAgentInfo {
  if (!isRecord(value)) {
    throw formatValidationError(label, [`${label} must be an object`]);
  }

  const result = isRecord(value.result) ? value.result : value;
  const agent = isRecord(result.agent) ? result.agent : null;
  if (!agent) {
    throw formatValidationError(label, [`${label} did not include an agent object`]);
  }

  const agentInfo = parseAgentStatus(agent);
  const issues: string[] = [];
  if (!agentInfo.agentName) {
    issues.push(`${label} did not include an agent name`);
  }
  if (!agentInfo.rawStatus) {
    issues.push(`${label} did not include an agent status`);
  }
  if (issues.length > 0) {
    throw formatValidationError(label, issues);
  }

  return agentInfo;
}

function getAgentStatus(runner: HerdrCommandRunner, agentName: string): HerdrAgentInfo {
  let result: HerdrCommandResult;
  try {
    result = runner.run(buildAgentGetArgs(agentName));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      agentName,
      paneId: null,
      tabId: null,
      terminalId: null,
      status: 'missing',
      rawStatus: null,
      failure: {
        kind: 'command-failed',
        command: `agent get ${agentName}`,
        exitCode: null,
        stderr: message,
      },
    };
  }

  if (result.error) {
    return {
      agentName,
      paneId: null,
      tabId: null,
      terminalId: null,
      status: 'missing',
      rawStatus: null,
      failure: createCommandError(`agent get ${agentName}`, result),
    };
  }
  if (result.status !== 0) {
    return {
      agentName,
      paneId: null,
      tabId: null,
      terminalId: null,
      status: 'missing',
      rawStatus: null,
      failure: createCommandError(`agent get ${agentName}`, result),
    };
  }

  const parsed = parseStrictJsonOutput(result.stdout, `herdr agent get ${agentName}`);
  const agentInfo = requireAgentStatus(parsed, `herdr agent get ${agentName}`);
  return {
    ...agentInfo,
    agentName: agentInfo.agentName ?? agentName,
  };
}

function readAgentTranscript(runner: HerdrCommandRunner, agentName: string): string {
  const result = runner.run(buildAgentReadArgs(agentName));
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`herdr agent read failed with exit ${result.status}: ${result.stderr.trim()}`);
  }

  return result.stdout.trim();
}

export function createHerdrAdapter(runner: HerdrCommandRunner = buildDefaultRunner()): HerdrAdapter {
  return {
    ensureWorktree(repository: RepositoryInfo, branchName: string, issueLabel: string): WorktreeInfo {
      return createWorktreeIfNeeded(runner, repository, branchName, issueLabel);
    },
    createDaemonPane(workspaceId: string, worktreePath: string): HerdrPaneInfo {
      return createDaemonPane(runner, workspaceId, worktreePath);
    },
    runPaneCommand(paneId: string, command: string): void {
      runPaneCommand(runner, paneId, command);
    },
    launchRoleAgent(
      worktreePath: string,
      workspaceId: string,
      role: Record<string, unknown>,
      roleLabel: string,
      agentName: string,
    ): HerdrPaneInfo {
      return launchRoleAgent(runner, worktreePath, workspaceId, role, roleLabel, agentName);
    },
    sendPrompt(agentName: string, prompt: string): void {
      sendPrompt(runner, agentName, prompt);
    },
    submitPrompt(paneId: string): void {
      submitPrompt(runner, paneId);
    },
    getAgentStatus(agentName: string): HerdrAgentInfo {
      return getAgentStatus(runner, agentName);
    },
    readAgentTranscript(agentName: string): string {
      return readAgentTranscript(runner, agentName);
    },
  };
}

export function createFakeRunner(responses: Array<{ args: readonly string[]; result: HerdrCommandResult }>): HerdrCommandRunner {
  let index = 0;
  return {
    run(args: readonly string[]): HerdrCommandResult {
      assert.equal(index < responses.length, true, `unexpected herdr command: ${args.join(' ')}`);
      const expected = responses[index];
      index += 1;
      assert.deepEqual(args, expected.args);
      return expected.result;
    },
  };
}
