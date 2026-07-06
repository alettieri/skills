import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { NormalizedPhase, NormalizedWorkflow } from './workflow.ts';
import { normalizeCapture } from './capture.ts';
import {
  isRecord,
  optionalBoolean,
  optionalFiniteNumber,
  optionalTrimmedString,
} from './validation.ts';

export type IssueReference = {
  input: string;
  number: number | null;
  url: string | null;
  canonical: string;
};

export type ScriptRunStatus = 'complete' | 'blocked' | 'failed' | 'timeout';

export type ScriptRunPaths = {
  stdoutPath: string;
  stderrPath: string;
  rawOutputPath: string;
};

export type ScriptRunCore = {
  phaseId: string;
  runId: string;
  command: string;
  resolvedCommandPath: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutSeconds: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  timedOut: boolean;
  exitCode: number | null;
  signal: string | null;
  status: ScriptRunStatus;
  outcome: string;
  capture: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
  retryable: boolean;
};

export type ScriptRunState = ScriptRunCore & ScriptRunPaths;

type ScriptRunLogInput = {
  command: string;
  resolvedCommandPath: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutSeconds: number;
  startedAt: string;
  finishedAt: string;
  stdout: string;
  stderr: string;
};

export type ScriptFailureInput = Omit<ScriptRunCore, 'capture' | 'timedOut'> & {
  paths: ScriptRunPaths;
  message: string;
  timedOut?: boolean;
  status?: ScriptRunStatus;
};

type ScriptExecutionResult = {
  outcome: string;
  capture: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  status: ScriptRunStatus;
};

export type ScriptPhaseWorkflowState = {
  issue: IssueReference;
  workflowPath: string;
  workflow: NormalizedWorkflow;
  branchName: string;
  worktreePath: string;
  workspaceId: string;
  currentPhase: string;
  updatedAt: string;
  context: Record<string, unknown>;
  scriptRuns: Record<string, ScriptRunState>;
};

function ensureDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function requireString(value: unknown, field: string): string {
  const stringValue = optionalTrimmedString(value);
  if (!stringValue) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return stringValue;
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

export function normalizeScriptRun(value: unknown): ScriptRunState | null {
  if (!isRecord(value)) {
    return null;
  }

  const phaseId = optionalTrimmedString(value.phaseId);
  const runId = optionalTrimmedString(value.runId);
  const command = optionalTrimmedString(value.command);
  const resolvedCommandPath = optionalTrimmedString(value.resolvedCommandPath);
  const args = Array.isArray(value.args) && value.args.every((item) => typeof item === 'string') ? value.args : null;
  const cwd = optionalTrimmedString(value.cwd);
  const env = normalizeStringRecord(value.env);
  const timeoutSeconds = optionalFiniteNumber(value.timeoutSeconds);
  const startedAt = optionalTrimmedString(value.startedAt);
  const finishedAt = optionalTrimmedString(value.finishedAt);
  const durationMs = optionalFiniteNumber(value.durationMs);
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
    value.status === 'complete' || value.status === 'blocked' || value.status === 'failed' || value.status === 'timeout'
      ? value.status
      : null;
  const outcome = optionalTrimmedString(value.outcome);
  const capture = value.capture === undefined ? null : normalizeCapture(value.capture);
  const stdout = typeof value.stdout === 'string' ? value.stdout : null;
  const stderr = typeof value.stderr === 'string' ? value.stderr : null;
  const stdoutPath = optionalTrimmedString(value.stdoutPath);
  const stderrPath = optionalTrimmedString(value.stderrPath);
  const rawOutputPath = optionalTrimmedString(value.rawOutputPath);
  const retryable = optionalBoolean(value.retryable);

  if (
    !phaseId ||
    !runId ||
    !command ||
    !resolvedCommandPath ||
    !args ||
    !cwd ||
    !env ||
    timeoutSeconds === null ||
    !startedAt ||
    !finishedAt ||
    durationMs === null ||
    timedOut === null ||
    exitCode === undefined ||
    !status ||
    !outcome ||
    stdout === null ||
    stderr === null ||
    !stdoutPath ||
    !stderrPath ||
    !rawOutputPath ||
    retryable === null
  ) {
    return null;
  }

  return buildScriptRunState({
    phaseId,
    runId,
    command,
    resolvedCommandPath,
    args,
    cwd,
    env,
    timeoutSeconds,
    startedAt,
    finishedAt,
    durationMs,
    timedOut,
    exitCode: exitCode ?? null,
    signal,
    status,
    outcome,
    capture,
    stdout,
    stderr,
    retryable,
    paths: {
      stdoutPath,
      stderrPath,
      rawOutputPath,
    },
  });
}

export function normalizeScriptRunMap(value: unknown): Record<string, ScriptRunState> {
  if (!isRecord(value)) {
    return {};
  }

  const result: Record<string, ScriptRunState> = {};
  for (const [phaseId, record] of Object.entries(value)) {
    const normalized = normalizeScriptRun(record);
    if (normalized) {
      result[phaseId] = normalized;
    }
  }

  return result;
}

export function buildScriptRunId(issue: IssueReference, phaseId: string): string {
  return `${issue.number === null ? 'issue-bootstrap' : `issue-${issue.number}`}-${phaseId}-script`;
}

function scriptRunPathsFor(worktreePath: string, runId: string): ScriptRunPaths {
  const basePath = join(worktreePath, '.agent', 'runs', runId);
  return {
    stdoutPath: join(basePath, 'stdout.log'),
    stderrPath: join(basePath, 'stderr.log'),
    rawOutputPath: join(basePath, 'raw.log'),
  };
}

function scriptPhaseRunnerPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), 'script-phase-runner.ts');
}

function resolveScriptCommandPath(cwd: string, workflowPath: string, command: string): string {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new Error('script command must be a non-empty string');
  }

  if (resolve(trimmed) === trimmed && existsSync(trimmed)) {
    return trimmed;
  }

  const workflowDir = dirname(resolve(workflowPath));
  const workflowRoot = dirname(workflowDir);
  const scriptRoot = resolve(cwd, 'skills/herdr-implement');
  const searchRoots = [workflowDir, workflowRoot, cwd, scriptRoot];

  for (const root of searchRoots) {
    const candidate = resolve(root, trimmed);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`script command does not exist: ${command}`);
}

function flattenContextValues(context: Record<string, unknown>, prefix = 'context'): Record<string, string> {
  const values: Record<string, string> = {};

  for (const [key, value] of Object.entries(context)) {
    const renderedKey = `${prefix}.${key}`;
    if (typeof value === 'string') {
      values[renderedKey] = value;
      continue;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      values[renderedKey] = String(value);
      continue;
    }

    if (isRecord(value)) {
      Object.assign(values, flattenContextValues(value, renderedKey));
    }
  }

  return values;
}

function renderTemplate(source: string, values: Record<string, string>): string {
  return source.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key: string) => values[key] ?? '');
}

function renderScriptTemplate(source: string, state: ScriptPhaseWorkflowState, phaseId: string): string {
  const phase = state.workflow.phases[phaseId];
  return renderTemplate(source, {
    ...flattenContextValues(state.context),
    'issue.canonical': state.issue.canonical,
    'issue.input': state.issue.input,
    'issue.number': String(state.issue.number ?? ''),
    'phase.id': phaseId,
    'phase.type': phase?.type ?? '',
    'run.id': buildScriptRunId(state.issue, phaseId),
    'workflow.branchName': state.branchName,
    'workflow.currentPhase': state.currentPhase,
    'workflow.path': state.workflowPath,
    'workflow.workspaceId': state.workspaceId,
    worktreePath: state.worktreePath,
    workspaceId: state.workspaceId,
  });
}

function renderScriptArgs(state: ScriptPhaseWorkflowState, phaseId: string, args: unknown): string[] {
  if (args === undefined) {
    return [];
  }

  if (!Array.isArray(args) || !args.every((value) => typeof value === 'string')) {
    throw new Error(`phases.${phaseId}.args must be an array of strings`);
  }

  return args.map((arg) => renderScriptTemplate(arg, state, phaseId));
}

function requireScriptRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }

  return value as Record<string, unknown>;
}

function renderScriptEnv(state: ScriptPhaseWorkflowState, phaseId: string, env: unknown): Record<string, string> {
  if (env === undefined) {
    return {};
  }

  const record = requireScriptRecord(env, `phases.${phaseId}.env`);
  const rendered: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    rendered[key] = renderScriptTemplate(requireString(value, `phases.${phaseId}.env.${key}`), state, phaseId);
  }
  return rendered;
}

function scriptPhaseTimeoutSeconds(phase: NormalizedPhase): number {
  const timeoutSeconds = optionalFiniteNumber(phase.timeoutSeconds);
  if (timeoutSeconds !== null && timeoutSeconds > 0) {
    return timeoutSeconds;
  }

  return 30;
}

function scriptPhaseRetryable(phase: NormalizedPhase): boolean {
  return phase.retryable === true;
}

function buildScriptEnvironment(
  state: ScriptPhaseWorkflowState,
  phaseId: string,
  renderedEnv: Record<string, string>,
): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    PWD: state.worktreePath,
    HERDR_ISSUE_CANONICAL: state.issue.canonical,
    HERDR_ISSUE_INPUT: state.issue.input,
    HERDR_ISSUE_NUMBER: String(state.issue.number ?? ''),
    HERDR_PHASE_ID: phaseId,
    HERDR_RUN_ID: buildScriptRunId(state.issue, phaseId),
    HERDR_WORKFLOW_PATH: state.workflowPath,
    HERDR_WORKFLOW_BRANCH: state.branchName,
    HERDR_WORKFLOW_CURRENT_PHASE: state.currentPhase,
    HERDR_WORKSPACE_ID: state.workspaceId,
    HERDR_WORKTREE_PATH: state.worktreePath,
    ...renderedEnv,
  };
}

function scriptLogContents(input: ScriptRunLogInput): string {
  return [
    `command: ${input.command}`,
    `resolvedCommandPath: ${input.resolvedCommandPath}`,
    `cwd: ${input.cwd}`,
    `timeoutSeconds: ${input.timeoutSeconds}`,
    `startedAt: ${input.startedAt}`,
    `finishedAt: ${input.finishedAt}`,
    `args: ${JSON.stringify(input.args)}`,
    `env: ${JSON.stringify(input.env)}`,
    '',
    '--- stdout ---',
    input.stdout,
    '',
    '--- stderr ---',
    input.stderr,
    '',
  ].join('\n');
}

function writeScriptLogFiles(paths: ScriptRunPaths, stdout: string, stderr: string, rawOutput: string): void {
  ensureDir(paths.stdoutPath);
  writeFileSync(paths.stdoutPath, stdout, 'utf8');
  writeFileSync(paths.stderrPath, stderr, 'utf8');
  writeFileSync(paths.rawOutputPath, rawOutput, 'utf8');
}

function buildScriptRunState(input: ScriptRunCore & { paths: ScriptRunPaths }): ScriptRunState {
  const { paths, ...core } = input;
  return {
    ...core,
    ...paths,
  };
}

function createScriptFailureRecord(input: ScriptFailureInput): ScriptRunState {
  const stderr = input.stderr ? `${input.stderr}\n${input.message}` : input.message;
  const rawOutput = scriptLogContents({
    command: input.command,
    resolvedCommandPath: input.resolvedCommandPath,
    args: input.args,
    cwd: input.cwd,
    env: input.env,
    timeoutSeconds: input.timeoutSeconds,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    stdout: input.stdout,
    stderr,
  });
  writeScriptLogFiles(input.paths, input.stdout, stderr, rawOutput);

  return buildScriptRunState({
    phaseId: input.phaseId,
    runId: input.runId,
    command: input.command,
    resolvedCommandPath: input.resolvedCommandPath,
    args: input.args,
    cwd: input.cwd,
    env: input.env,
    timeoutSeconds: input.timeoutSeconds,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: input.durationMs,
    timedOut: input.timedOut ?? false,
    exitCode: input.exitCode ?? null,
    signal: input.signal ?? null,
    status: input.status ?? 'failed',
    outcome: input.outcome ?? 'failure',
    capture: null,
    stdout: input.stdout,
    stderr,
    retryable: input.retryable,
    paths: input.paths,
  });
}

function parseScriptOutcome(stdout: string): { outcome: string; capture: Record<string, unknown> | null } {
  const trimmed = stdout.trim();
  if (trimmed === '') {
    return { outcome: '', capture: null };
  }

  if (trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`script stdout is not valid JSON: ${message}`);
    }

    if (!isRecord(parsed)) {
      throw new Error('script stdout JSON outcome must be an object');
    }

    const outcome = optionalTrimmedString(parsed.outcome);
    if (!outcome) {
      throw new Error('script stdout JSON outcome must include a non-empty outcome');
    }

    const capture = parsed.capture === undefined ? null : normalizeCapture(parsed.capture);
    if (parsed.capture !== undefined && capture === null) {
      throw new Error('script stdout capture must be an object with string keys');
    }

    return { outcome, capture };
  }

  if (/\s/.test(trimmed)) {
    throw new Error('script stdout outcome must be a single token or JSON object');
  }

  return { outcome: trimmed, capture: null };
}

function scriptExecutionStatusFrom(outcome: string, exitCode: number | null, timedOut: boolean): ScriptExecutionResult['status'] {
  if (timedOut) {
    return 'timeout';
  }

  if (outcome === 'blocked') {
    return 'blocked';
  }

  if (outcome === 'success') {
    return 'complete';
  }

  if (exitCode === 0) {
    return 'complete';
  }

  return 'failed';
}

type ScriptPhaseExecutionInput = {
  state: ScriptPhaseWorkflowState;
  phaseId: string;
  phase: NormalizedPhase;
};

export function executeScriptPhase(
  input: ScriptPhaseExecutionInput,
): {
  record: ScriptRunState;
  nextPhase: string | null;
} {
  const { state, phaseId, phase } = input;
  const command = requireString(phase.command, `phases.${phaseId}.command`);
  const timeoutSeconds = scriptPhaseTimeoutSeconds(phase);
  const timeoutMs = Math.max(1, Math.round(timeoutSeconds * 1000));
  const runId = buildScriptRunId(state.issue, phaseId);
  const startedAt = new Date().toISOString();
  const paths = scriptRunPathsFor(state.worktreePath, runId);

  let resolvedCommandPath: string;
  let args: string[];
  let cwd: string;
  let env: Record<string, string>;

  try {
    resolvedCommandPath = resolveScriptCommandPath(state.worktreePath, state.workflowPath, command);
    args = renderScriptArgs(state, phaseId, phase.args);
    cwd = renderScriptTemplate(typeof phase.cwd === 'string' ? phase.cwd : state.worktreePath, state, phaseId);
    env = buildScriptEnvironment(state, phaseId, renderScriptEnv(state, phaseId, phase.env));
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
    const message = error instanceof Error ? error.message : String(error);
    const record = createScriptFailureRecord({
      phaseId,
      runId,
      command,
      resolvedCommandPath: command,
      args: [],
      cwd: state.worktreePath,
      env: buildScriptEnvironment(state, phaseId, {}),
      timeoutSeconds,
      startedAt,
      finishedAt,
      durationMs,
      stdout: '',
      stderr: '',
      paths,
      message,
      exitCode: null,
      signal: null,
      outcome: 'failure',
      retryable: scriptPhaseRetryable(phase),
      status: 'failed',
    });
    return { record, nextPhase: resolveNextPhase(state.workflow, phaseId, 'failure') };
  }

  const runnerPath = scriptPhaseRunnerPath();
  const helperResult = spawnSync(
    process.execPath,
    [
      runnerPath,
      JSON.stringify({
        commandPath: resolvedCommandPath,
        args,
        cwd,
        env,
        timeoutMs,
      }),
    ],
    {
      cwd: state.worktreePath,
      encoding: 'utf8',
      shell: false,
      maxBuffer: 1024 * 1024 * 10,
    },
  );

  const finishedAt = new Date().toISOString();
  const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
  const helperStdout = typeof helperResult.stdout === 'string' ? helperResult.stdout.trim() : '';
  const helperStderr = typeof helperResult.stderr === 'string' ? helperResult.stderr : '';

  if (helperResult.error || helperResult.status !== 0 || !helperStdout) {
    const message =
      helperResult.error?.message ??
      helperStderr.trim() ??
      (helperResult.status !== 0 ? `script phase helper failed with exit ${helperResult.status}` : 'script phase helper returned no output');
    const record = createScriptFailureRecord({
      phaseId,
      runId,
      command,
      resolvedCommandPath,
      args,
      cwd,
      env,
      timeoutSeconds,
      startedAt,
      finishedAt,
      durationMs,
      stdout: '',
      stderr: helperStderr,
      paths,
      message,
      exitCode: null,
      signal: null,
      outcome: 'failure',
      retryable: scriptPhaseRetryable(phase),
      status: 'failed',
    });
    return { record, nextPhase: resolveNextPhase(state.workflow, phaseId, 'failure') };
  }

  let helperParsed: unknown;
  try {
    helperParsed = JSON.parse(helperStdout) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const record = createScriptFailureRecord({
      phaseId,
      runId,
      command,
      resolvedCommandPath,
      args,
      cwd,
      env,
      timeoutSeconds,
      startedAt,
      finishedAt,
      durationMs,
      stdout: helperStdout,
      stderr: helperStderr,
      paths,
      message: `script phase helper returned invalid JSON: ${message}`,
      exitCode: null,
      signal: null,
      outcome: 'failure',
      retryable: scriptPhaseRetryable(phase),
      status: 'failed',
    });
    return { record, nextPhase: resolveNextPhase(state.workflow, phaseId, 'failure') };
  }

  if (!isRecord(helperParsed)) {
    const record = createScriptFailureRecord({
      phaseId,
      runId,
      command,
      resolvedCommandPath,
      args,
      cwd,
      env,
      timeoutSeconds,
      startedAt,
      finishedAt,
      durationMs,
      stdout: helperStdout,
      stderr: helperStderr,
      paths,
      message: 'script phase helper output must be an object',
      exitCode: null,
      signal: null,
      outcome: 'failure',
      retryable: scriptPhaseRetryable(phase),
      status: 'failed',
    });
    return { record, nextPhase: resolveNextPhase(state.workflow, phaseId, 'failure') };
  }

  const helperResultRecord = helperParsed as {
    kind?: unknown;
    startedAt?: unknown;
    finishedAt?: unknown;
    durationMs?: unknown;
    timedOut?: unknown;
    exitCode?: unknown;
    signal?: unknown;
    stdout?: unknown;
    stderr?: unknown;
    errorMessage?: unknown;
  };

  const helperKind = helperResultRecord.kind === 'error' || helperResultRecord.kind === 'result' ? helperResultRecord.kind : null;
  if (!helperKind) {
    const record = createScriptFailureRecord({
      phaseId,
      runId,
      command,
      resolvedCommandPath,
      args,
      cwd,
      env,
      timeoutSeconds,
      startedAt,
      finishedAt,
      durationMs,
      stdout: helperStdout,
      stderr: helperStderr,
      paths,
      message: 'script phase helper output missing kind',
      exitCode: null,
      signal: null,
      outcome: 'failure',
      retryable: scriptPhaseRetryable(phase),
      status: 'failed',
    });
    return { record, nextPhase: resolveNextPhase(state.workflow, phaseId, 'failure') };
  }

  const helperStartedAt = optionalTrimmedString(helperResultRecord.startedAt) ?? startedAt;
  const helperFinishedAt = optionalTrimmedString(helperResultRecord.finishedAt) ?? finishedAt;
  const helperDurationMs = optionalFiniteNumber(helperResultRecord.durationMs) ?? durationMs;
  const stdout = typeof helperResultRecord.stdout === 'string' ? helperResultRecord.stdout : '';
  const stderr = typeof helperResultRecord.stderr === 'string' ? helperResultRecord.stderr : '';
  const exitCode =
    typeof helperResultRecord.exitCode === 'number' && Number.isFinite(helperResultRecord.exitCode)
      ? helperResultRecord.exitCode
      : null;
  const timedOut = helperResultRecord.timedOut === true;
  const signal = optionalTrimmedString(helperResultRecord.signal);

  if (helperKind === 'error') {
    const message = optionalTrimmedString(helperResultRecord.errorMessage) ?? 'script phase helper reported an error';
    const record = createScriptFailureRecord({
      phaseId,
      runId,
      command,
      resolvedCommandPath,
      args,
      cwd,
      env,
      timeoutSeconds,
      startedAt: helperStartedAt,
      finishedAt: helperFinishedAt,
      durationMs: helperDurationMs,
      stdout,
      stderr,
      paths,
      message,
      timedOut,
      exitCode,
      signal,
      outcome: timedOut ? 'timeout' : 'failure',
      retryable: scriptPhaseRetryable(phase),
      status: timedOut ? 'timeout' : 'failed',
    });
    return { record, nextPhase: resolveNextPhase(state.workflow, phaseId, timedOut ? 'timeout' : 'failure') };
  }

  let parsedOutcome: { outcome: string; capture: Record<string, unknown> | null };
  try {
    parsedOutcome = parseScriptOutcome(stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const record = createScriptFailureRecord({
      phaseId,
      runId,
      command,
      resolvedCommandPath,
      args,
      cwd,
      env,
      timeoutSeconds,
      startedAt: helperStartedAt,
      finishedAt: helperFinishedAt,
      durationMs: helperDurationMs,
      stdout,
      stderr,
      paths,
      message,
      timedOut,
      exitCode,
      signal,
      outcome: timedOut ? 'timeout' : 'failure',
      retryable: scriptPhaseRetryable(phase),
      status: timedOut ? 'timeout' : 'failed',
    });
    return { record, nextPhase: resolveNextPhase(state.workflow, phaseId, timedOut ? 'timeout' : 'failure') };
  }

  const outcome = timedOut ? 'timeout' : parsedOutcome.outcome || (exitCode === 0 ? 'success' : 'failure');
  const status = scriptExecutionStatusFrom(outcome, exitCode, timedOut);
  const rawOutput = scriptLogContents({
    command,
    resolvedCommandPath,
    args,
    cwd,
    env,
    timeoutSeconds,
    startedAt: helperStartedAt,
    finishedAt: helperFinishedAt,
    stdout,
    stderr,
  });
  writeScriptLogFiles(paths, stdout, stderr, rawOutput);
  const record = buildScriptRunState({
    phaseId,
    runId,
    command,
    resolvedCommandPath,
    args,
    cwd,
    env,
    timeoutSeconds,
    startedAt: helperStartedAt,
    finishedAt: helperFinishedAt,
    durationMs: helperDurationMs,
    timedOut,
    exitCode,
    signal,
    status,
    outcome,
    capture: parsedOutcome.capture,
    stdout,
    stderr,
    retryable: scriptPhaseRetryable(phase),
    paths,
  });

  return { record, nextPhase: resolveNextPhase(state.workflow, phaseId, outcome) };
}

function isTerminalScriptRun(record: ScriptRunState): boolean {
  return record.status === 'complete' || record.status === 'blocked' || record.status === 'failed' || record.status === 'timeout';
}

export function recoverCompletedScriptPhase<T extends ScriptPhaseWorkflowState>(
  state: T,
): { state: T; nextPhase: string | null } | null {
  const phase = state.workflow.phases[state.currentPhase];
  if (!phase || phase.type !== 'script') {
    return null;
  }

  const record = state.scriptRuns[state.currentPhase];
  if (!record || record.phaseId !== state.currentPhase || !isTerminalScriptRun(record) || record.retryable) {
    return null;
  }

  const nextPhase = resolveNextPhase(state.workflow, state.currentPhase, record.outcome);
  const updatedAt = new Date().toISOString();
  return {
    state: {
      ...state,
      currentPhase: nextPhase ?? state.currentPhase,
      updatedAt,
    } as T,
    nextPhase,
  };
}

function resolveNextPhase(workflow: NormalizedWorkflow, phaseId: string, outcome: string): string | null {
  const phase = workflow.phases[phaseId];
  if (!phase) {
    return null;
  }

  return phase.on[outcome] ?? null;
}
