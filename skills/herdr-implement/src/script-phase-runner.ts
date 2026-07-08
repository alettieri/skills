import { spawn } from 'node:child_process';

type ScriptPhaseRunnerPayload = {
  commandPath: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
};

type ScriptPhaseRunnerResult =
  | {
      kind: 'result';
      startedAt: string;
      finishedAt: string;
      durationMs: number;
      timedOut: boolean;
      exitCode: number | null;
      signal: string | null;
      stdout: string;
      stderr: string;
    }
  | {
      kind: 'error';
      startedAt: string;
      finishedAt: string;
      durationMs: number;
      timedOut: boolean;
      exitCode: number | null;
      signal: string | null;
      stdout: string;
      stderr: string;
      errorMessage: string;
    };

function readPayload(argv: string[]): ScriptPhaseRunnerPayload {
  const raw = argv[2];
  if (!raw) {
    throw new Error('missing script phase payload');
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('script phase payload must be an object');
  }

  const payload = parsed as Record<string, unknown>;
  if (
    typeof payload.commandPath !== 'string' ||
    !Array.isArray(payload.args) ||
    !payload.args.every((arg) => typeof arg === 'string') ||
    typeof payload.cwd !== 'string' ||
    typeof payload.env !== 'object' ||
    payload.env === null ||
    Array.isArray(payload.env) ||
    typeof payload.timeoutMs !== 'number'
  ) {
    throw new Error('script phase payload is invalid');
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload.env as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      throw new Error(`script phase env ${key} must be a string`);
    }
    env[key] = value;
  }

  return {
    commandPath: payload.commandPath,
    args: payload.args,
    cwd: payload.cwd,
    env,
    timeoutMs: payload.timeoutMs,
  };
}

async function runScriptPhase(payload: ScriptPhaseRunnerPayload): Promise<void> {
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.parse(startedAt);
  let timedOut = false;
  let stdout = '';
  let stderr = '';
  let exitCode: number | null = null;
  let signal: string | null = null;
  let childPid: number | null = null;
  let done = false;
  let finishResolve: (() => void) | null = null;

  const finished = new Promise<void>((resolve) => {
    finishResolve = resolve;
  });

  const child = spawn(payload.commandPath, payload.args, {
    cwd: payload.cwd,
    env: payload.env,
    detached: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  childPid = child.pid ?? null;
  child.stdout?.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.once('error', (error) => {
    if (done) {
      return;
    }
    done = true;
    const finishedAt = new Date().toISOString();
    const result: ScriptPhaseRunnerResult = {
      kind: 'error',
      startedAt,
      finishedAt,
      durationMs: Math.max(0, Date.parse(finishedAt) - startedAtMs),
      timedOut: false,
      exitCode: null,
      signal: null,
      stdout,
      stderr,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    finishResolve?.();
  });
  child.once('close', (code, closeSignal) => {
    if (done) {
      return;
    }
    done = true;
    exitCode = code;
    signal = closeSignal;
    const finishedAt = new Date().toISOString();
    const result: ScriptPhaseRunnerResult = {
      kind: 'result',
      startedAt,
      finishedAt,
      durationMs: Math.max(0, Date.parse(finishedAt) - startedAtMs),
      timedOut,
      exitCode,
      signal,
      stdout,
      stderr,
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    finishResolve?.();
  });

  const timeout = setTimeout(() => {
    if (done) {
      return;
    }
    timedOut = true;
    if (childPid !== null) {
      try {
        process.kill(-childPid, 'SIGTERM');
      } catch {
        // Ignore kill failures; the close event will still resolve if the child exits.
      }
    }
    setTimeout(() => {
      if (done || childPid === null) {
        return;
      }
      try {
        process.kill(-childPid, 'SIGKILL');
      } catch {
        // Ignore kill failures; the close event will still resolve if the child exits.
      }
    }, 100);
  }, payload.timeoutMs);

  await finished;
  clearTimeout(timeout);
}

export async function runScriptPhaseRunner(argv: string[] = process.argv): Promise<void> {
  const payload = readPayload(argv);
  await runScriptPhase(payload);
}
