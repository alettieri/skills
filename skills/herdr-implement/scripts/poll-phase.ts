import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { NormalizedPhase } from './workflow.ts';
import { mergeCaptureIntoContext } from './capture.ts';
import { resolveNextPhase } from './workflow-transition.ts';
import {
  buildScriptEnvironment,
  parseScriptOutcome,
  renderScriptArgs,
  resolveScriptCommandPath,
  scriptLogContents,
  writeScriptLogFiles,
} from './script-phase.ts';
import {
  optionalFiniteNumber,
  optionalTrimmedString,
} from './validation.ts';
import type { DaemonStepResult } from './runtime.ts';
import type { PollRunState, WorkflowRunState } from './workflow-state-store.ts';

export type PollPhaseOptions = {
  cwd: string;
  state: WorkflowRunState;
  phaseId: string;
  phase: NormalizedPhase;
  now: () => Date;
};

export type PollPhaseResult = {
  state: WorkflowRunState;
  result: DaemonStepResult;
};

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function buildPollRunId(issueNumber: number | null, phaseId: string): string {
  return `${issueNumber === null ? 'issue-bootstrap' : `issue-${issueNumber}`}-${phaseId}-poll`;
}

function pollRunPathsFor(worktreePath: string, runId: string): { stdoutPath: string; stderrPath: string; rawOutputPath: string } {
  const basePath = join(worktreePath, '.agent', 'runs', runId);
  return {
    stdoutPath: join(basePath, 'stdout.log'),
    stderrPath: join(basePath, 'stderr.log'),
    rawOutputPath: join(basePath, 'raw.log'),
  };
}

function requireString(value: unknown, field: string): string {
  const stringValue = optionalTrimmedString(value);
  if (!stringValue) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return stringValue;
}

function pollTimeoutSeconds(phase: NormalizedPhase): number {
  const timeoutSeconds = optionalFiniteNumber(phase.timeoutSeconds);
  if (timeoutSeconds !== null && timeoutSeconds > 0) {
    return timeoutSeconds;
  }

  return 30;
}

function pollStatusFrom(outcome: string, timedOut: boolean): PollRunState['status'] {
  if (timedOut) {
    return 'timeout';
  }

  if (outcome === 'waiting') {
    return 'waiting';
  }

  if (outcome === 'blocked') {
    return 'blocked';
  }

  if (outcome === 'failure') {
    return 'failed';
  }

  return 'complete';
}

function observationFingerprint(outcome: string, capture: Record<string, unknown> | null): string {
  return JSON.stringify({
    outcome,
    capture,
  });
}

function buildObservation(outcome: string, capture: Record<string, unknown> | null): Record<string, unknown> {
  return capture === null ? { outcome } : { outcome, capture };
}

function createPollRunState(input: {
  phaseId: string;
  runId: string;
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
  status: PollRunState['status'];
  outcome: string;
  capture: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
  paths: { stdoutPath: string; stderrPath: string; rawOutputPath: string };
}): PollRunState {
  const observation = buildObservation(input.outcome, input.capture);
  return {
    runId: input.runId,
    phaseId: input.phaseId,
    command: input.command,
    resolvedCommandPath: input.resolvedCommandPath,
    args: input.args,
    cwd: input.cwd,
    env: input.env,
    intervalSeconds: input.intervalSeconds,
    timeoutSeconds: input.timeoutSeconds,
    createdAt: input.createdAt,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: input.durationMs,
    nextWakeAt: input.nextWakeAt,
    tickCount: input.tickCount,
    timedOut: input.timedOut,
    exitCode: input.exitCode,
    signal: input.signal,
    status: input.status,
    outcome: input.outcome,
    capture: input.capture,
    observation,
    fingerprint: observationFingerprint(input.outcome, input.capture),
    stdout: input.stdout,
    stderr: input.stderr,
    stdoutPath: input.paths.stdoutPath,
    stderrPath: input.paths.stderrPath,
    rawOutputPath: input.paths.rawOutputPath,
  };
}

function createPollFailureRecord(input: {
  phaseId: string;
  runId: string;
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
  stdout: string;
  stderr: string;
  message: string;
  timedOut?: boolean;
  exitCode?: number | null;
  signal?: string | null;
  status?: PollRunState['status'];
  outcome?: string;
  capture?: Record<string, unknown> | null;
  paths: { stdoutPath: string; stderrPath: string; rawOutputPath: string };
}): PollRunState {
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

  return createPollRunState({
    phaseId: input.phaseId,
    runId: input.runId,
    command: input.command,
    resolvedCommandPath: input.resolvedCommandPath,
    args: input.args,
    cwd: input.cwd,
    env: input.env,
    intervalSeconds: input.intervalSeconds,
    timeoutSeconds: input.timeoutSeconds,
    createdAt: input.createdAt,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: input.durationMs,
    nextWakeAt: input.nextWakeAt,
    tickCount: input.tickCount,
    timedOut: input.timedOut ?? false,
    exitCode: input.exitCode ?? null,
    signal: input.signal ?? null,
    status: input.status ?? 'failed',
    outcome: input.outcome ?? 'failure',
    capture: input.capture ?? null,
    stdout: input.stdout,
    stderr,
    paths: input.paths,
  });
}

function currentPollRun(state: WorkflowRunState, phaseId: string): PollRunState | null {
  return state.pollRuns?.[phaseId] ?? null;
}

export function advancePollWorkOnce(options: PollPhaseOptions): PollPhaseResult {
  const { state, phaseId, phase, now } = options;
  const commandCwd = resolve(options.cwd);
  const command = requireString(phase.command, `phases.${phaseId}.command`);
  const intervalSeconds = requireIntervalSeconds(phase, phaseId);
  const timeoutSeconds = pollTimeoutSeconds(phase);
  const record = currentPollRun(state, phaseId);
  const nowValue = now();
  const nowIsoValue = nowValue.toISOString();

  if (record && Date.parse(record.nextWakeAt) > Date.parse(nowIsoValue)) {
    return {
      state: {
        ...state,
        updatedAt: nowIsoValue,
      },
      result: {
        status: 'sleep',
        currentPhase: phaseId,
        reason: `waiting on ${phaseId}`,
      },
    };
  }

  const runId = record?.runId ?? buildPollRunId(state.issue.number, phaseId);
  const startedAt = nowIsoValue;
  const createdAt = record?.createdAt ?? startedAt;
  const tickCount = (record?.tickCount ?? 0) + 1;
  const paths = pollRunPathsFor(state.worktreePath, runId);

  let resolvedCommandPath: string;
  let args: string[];
  let cwd: string;
  let env: Record<string, string>;

  try {
    resolvedCommandPath = resolveScriptCommandPath(commandCwd, state.workflowPath, command);
    args = renderScriptArgs(
      {
        issue: state.issue,
        workflowPath: state.workflowPath,
        workflow: state.workflow,
        branchName: state.branchName,
        worktreePath: state.worktreePath,
        workspaceId: state.workspaceId,
        currentPhase: state.currentPhase,
        updatedAt: state.updatedAt,
        context: state.context,
        scriptRuns: state.scriptRuns,
      },
      phaseId,
      phase.args,
    );
    cwd = commandCwd;
    env = buildScriptEnvironment(
      {
        issue: state.issue,
        workflowPath: state.workflowPath,
        workflow: state.workflow,
        branchName: state.branchName,
        worktreePath: state.worktreePath,
        workspaceId: state.workspaceId,
        currentPhase: state.currentPhase,
        updatedAt: state.updatedAt,
        context: state.context,
        scriptRuns: state.scriptRuns,
      },
      phaseId,
      {},
    );
  } catch (error) {
    const finishedAt = nowIso(now);
    const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
    const message = error instanceof Error ? error.message : String(error);
    const nextWakeAt = new Date(Date.parse(finishedAt) + intervalSeconds * 1000).toISOString();
    const failedTransition = resolveNextPhase(state.workflow, phaseId, 'failure');
    const run = createPollFailureRecord({
      phaseId,
      runId,
      command,
      resolvedCommandPath: command,
      args: [],
      cwd: state.worktreePath,
      env: buildScriptEnvironment({
        issue: state.issue,
        workflowPath: state.workflowPath,
        workflow: state.workflow,
        branchName: state.branchName,
        worktreePath: state.worktreePath,
        workspaceId: state.workspaceId,
        currentPhase: state.currentPhase,
        updatedAt: state.updatedAt,
        context: state.context,
        scriptRuns: state.scriptRuns,
      }, phaseId, {}),
      intervalSeconds,
      timeoutSeconds,
      createdAt,
      startedAt,
      finishedAt,
      durationMs,
      nextWakeAt,
      tickCount,
      stdout: '',
      stderr: '',
      message,
      paths,
      status: 'failed',
      outcome: 'failure',
    });

    return {
      state: {
        ...state,
        currentPhase: failedTransition ?? state.currentPhase,
        pollRuns: {
          ...(state.pollRuns ?? {}),
          [phaseId]: run,
        },
        updatedAt: finishedAt,
      },
      result: {
        status: failedTransition ? 'continue' : 'stop',
        currentPhase: phaseId,
        nextPhase: failedTransition ?? undefined,
        reason: `poll phase ${phaseId} failed to start`,
      },
    };
  }

  const runnerResult = spawnSync(resolvedCommandPath, args, {
    cwd,
    encoding: 'utf8',
    env,
    shell: false,
    timeout: Math.max(1, Math.round(timeoutSeconds * 1000)),
    maxBuffer: 1024 * 1024 * 10,
  });

  const finishedAt = nowIso(now);
  const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
  const helperStdout = typeof runnerResult.stdout === 'string' ? runnerResult.stdout : '';
  const helperStderr = typeof runnerResult.stderr === 'string' ? runnerResult.stderr : '';
  const timedOut = Boolean(
    runnerResult.error &&
      typeof runnerResult.error === 'object' &&
      'code' in runnerResult.error &&
      (runnerResult.error as NodeJS.ErrnoException).code === 'ETIMEDOUT',
  );
  const exitCode = typeof runnerResult.status === 'number' ? runnerResult.status : null;
  const signal = optionalTrimmedString(runnerResult.signal);
  const nextWakeAt = new Date(Date.parse(finishedAt) + intervalSeconds * 1000).toISOString();

  if (runnerResult.error || exitCode !== 0 || !helperStdout.trim()) {
    const message =
      runnerResult.error?.message ??
      helperStderr.trim() ??
      (exitCode !== 0 ? `poll phase command failed with exit ${exitCode}` : 'poll phase command returned no output');
    const run = createPollFailureRecord({
      phaseId,
      runId,
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
      stdout: helperStdout,
      stderr: helperStderr,
      message,
      timedOut,
      exitCode,
      signal,
      status: timedOut ? 'timeout' : 'failed',
      outcome: timedOut ? 'timeout' : 'failure',
      paths,
    });

    const transition = resolveNextPhase(state.workflow, phaseId, timedOut ? 'timeout' : 'failure');
    return {
      state: {
        ...state,
        currentPhase: transition ?? state.currentPhase,
        pollRuns: {
          ...(state.pollRuns ?? {}),
          [phaseId]: run,
        },
        updatedAt: finishedAt,
      },
      result: {
        status: transition ? 'continue' : 'stop',
        currentPhase: phaseId,
        nextPhase: transition ?? undefined,
        reason: `poll phase ${phaseId} completed with ${run.outcome}`,
      },
    };
  }

  let parsedOutcome: { outcome: string; capture: Record<string, unknown> | null };
  try {
    parsedOutcome = parseScriptOutcome(helperStdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const run = createPollFailureRecord({
      phaseId,
      runId,
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
      stdout: helperStdout,
      stderr: helperStderr,
      message,
      timedOut,
      exitCode,
      signal,
      status: timedOut ? 'timeout' : 'failed',
      outcome: timedOut ? 'timeout' : 'failure',
      paths,
    });

    const transition = resolveNextPhase(state.workflow, phaseId, timedOut ? 'timeout' : 'failure');
    return {
      state: {
        ...state,
        currentPhase: transition ?? state.currentPhase,
        pollRuns: {
          ...(state.pollRuns ?? {}),
          [phaseId]: run,
        },
        updatedAt: finishedAt,
      },
      result: {
        status: transition ? 'continue' : 'stop',
        currentPhase: phaseId,
        nextPhase: transition ?? undefined,
        reason: `poll phase ${phaseId} completed with ${run.outcome}`,
      },
    };
  }

  const outcome = timedOut ? 'timeout' : parsedOutcome.outcome || (exitCode === 0 ? 'waiting' : 'failure');
  const status = pollStatusFrom(outcome, timedOut);
  const rawOutput = scriptLogContents({
    command,
    resolvedCommandPath,
    args,
    cwd,
    env,
    timeoutSeconds,
    startedAt,
    finishedAt,
    stdout: helperStdout,
    stderr: helperStderr,
  });
  writeScriptLogFiles(paths, helperStdout, helperStderr, rawOutput);

  const run = createPollRunState({
    phaseId,
    runId,
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
    exitCode,
    signal,
    status,
    outcome,
    capture: parsedOutcome.capture,
    stdout: helperStdout,
    stderr: helperStderr,
    paths,
  });

  const transition = outcome === 'waiting' ? null : resolveNextPhase(state.workflow, phaseId, outcome);
  const nextPhase = outcome === 'waiting' ? phaseId : transition ?? null;
  const updatedState: WorkflowRunState = {
    ...state,
    currentPhase: nextPhase ?? state.currentPhase,
    pollRuns: {
      ...(state.pollRuns ?? {}),
      [phaseId]: run,
    },
    updatedAt: finishedAt,
    context: mergeCaptureIntoContext(state.context, parsedOutcome.capture),
  };

  if (outcome === 'waiting') {
    return {
      state: updatedState,
      result: {
        status: 'sleep',
        currentPhase: phaseId,
        reason: `waiting on ${phaseId}`,
      },
    };
  }

  return {
    state: updatedState,
    result: {
      status: transition ? 'continue' : 'stop',
      currentPhase: phaseId,
      nextPhase: transition ?? undefined,
      reason: `poll phase ${phaseId} completed with ${outcome}`,
    },
  };
}

function requireIntervalSeconds(phase: NormalizedPhase, phaseId: string): number {
  const intervalSeconds = optionalFiniteNumber(phase.intervalSeconds);
  if (intervalSeconds === null || intervalSeconds <= 0) {
    throw new Error(`phases.${phaseId}.intervalSeconds must be a positive number`);
  }

  return intervalSeconds;
}
