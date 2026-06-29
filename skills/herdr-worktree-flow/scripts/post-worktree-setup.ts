import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const HOOK_PATH = '.agent/herdr-post-worktree-setup';
const LOG_PATH = '.agent/post-worktree-setup.log';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export type SetupStatus = 'skipped' | 'succeeded' | 'blocked';
export type BlockerReason = 'not_executable' | 'startup_error' | 'non_zero_exit' | 'timeout' | 'dirty_worktree';

export type PostWorktreeSetupResult = {
  status: SetupStatus;
  hookPath: string;
  logPath: string;
  exitCode?: number | null;
  timedOut?: boolean;
  blockerReason?: BlockerReason;
  message: string;
  dirtyStatus?: string;
};

export type PostWorktreeSetupOptions = {
  timeoutMs?: number;
};

function relativeResult(worktreePath: string, result: Omit<PostWorktreeSetupResult, 'hookPath' | 'logPath'>): PostWorktreeSetupResult {
  return {
    ...result,
    hookPath: join(worktreePath, HOOK_PATH),
    logPath: join(worktreePath, LOG_PATH),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeLog(logPath: string, contents: string): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, contents, 'utf8');
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number },
): Promise<{ status: number | null; stdout: string; stderr: string; error?: Error; timedOut: boolean }> {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            if (settled) {
              return;
            }
            timedOut = true;
            settled = true;
            child.kill('SIGTERM');
            const killTimeout = setTimeout(() => {
              child.kill('SIGKILL');
            }, 1000);
            killTimeout.unref();
            resolveRun({ status: null, stdout, stderr, timedOut });
          }, options.timeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      resolveRun({ status: null, stdout, stderr, error, timedOut });
    });

    child.on('close', (status) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      resolveRun({ status, stdout, stderr, timedOut });
    });
  });
}

function formatLog(stdout: string, stderr: string, footer?: string): string {
  const parts = [`[stdout]\n${stdout}`, `[stderr]\n${stderr}`];
  if (footer) {
    parts.push(`[post-worktree-setup]\n${footer}`);
  }
  return `${parts.join('\n')}\n`;
}

async function gitStatus(worktreePath: string): Promise<string> {
  const result = await runCommand('git', ['status', '--porcelain', '--untracked-files=normal'], {
    cwd: worktreePath,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`git status failed with exit ${result.status}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

export async function runPostWorktreeSetup(
  worktreePath: string,
  options: PostWorktreeSetupOptions = {},
): Promise<PostWorktreeSetupResult> {
  const root = resolve(worktreePath);
  const hookPath = join(root, HOOK_PATH);
  const logPath = join(root, LOG_PATH);

  if (!(await exists(hookPath))) {
    return relativeResult(root, {
      status: 'skipped',
      message: 'No post-worktree setup hook found.',
    });
  }

  if (!(await isExecutable(hookPath))) {
    await writeLog(logPath, formatLog('', '', `Blocked: ${HOOK_PATH} exists but is not executable.`));
    return relativeResult(root, {
      status: 'blocked',
      blockerReason: 'not_executable',
      message: 'Post-worktree setup hook exists but is not executable.',
    });
  }

  const hookRun = await runCommand(hookPath, [], {
    cwd: root,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  if (hookRun.error) {
    await writeLog(logPath, formatLog(hookRun.stdout, hookRun.stderr, `Startup error: ${hookRun.error.message}`));
    return relativeResult(root, {
      status: 'blocked',
      exitCode: null,
      blockerReason: 'startup_error',
      message: `Post-worktree setup hook could not start: ${hookRun.error.message}`,
    });
  }

  if (hookRun.timedOut) {
    await writeLog(logPath, formatLog(hookRun.stdout, hookRun.stderr, 'Blocked: setup timed out.'));
    return relativeResult(root, {
      status: 'blocked',
      exitCode: hookRun.status,
      timedOut: true,
      blockerReason: 'timeout',
      message: 'Post-worktree setup hook timed out.',
    });
  }

  if (hookRun.status !== 0) {
    await writeLog(logPath, formatLog(hookRun.stdout, hookRun.stderr, `Blocked: hook exited ${hookRun.status}.`));
    return relativeResult(root, {
      status: 'blocked',
      exitCode: hookRun.status,
      blockerReason: 'non_zero_exit',
      message: `Post-worktree setup hook exited with status ${hookRun.status}.`,
    });
  }

  await writeLog(logPath, formatLog(hookRun.stdout, hookRun.stderr));

  const dirtyStatus = await gitStatus(root);
  if (dirtyStatus) {
    return relativeResult(root, {
      status: 'blocked',
      exitCode: 0,
      blockerReason: 'dirty_worktree',
      dirtyStatus,
      message: 'Post-worktree setup hook left tracked or non-ignored untracked changes.',
    });
  }

  return relativeResult(root, {
    status: 'succeeded',
    exitCode: 0,
    message: 'Post-worktree setup hook completed successfully.',
  });
}

export function printHelp(): void {
  process.stdout.write(`Usage: post-worktree-setup.ts <worktree-path>\n\n`);
  process.stdout.write(`Runs .agent/herdr-post-worktree-setup from the issue worktree root when present.\n`);
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    printHelp();
    return 0;
  }

  const [worktreePath] = argv;
  if (!worktreePath) {
    process.stderr.write('post-worktree-setup requires a worktree path\n');
    return 2;
  }

  const result = await runPostWorktreeSetup(worktreePath);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.status === 'blocked' ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const exitCode = await main(process.argv.slice(2));
  process.exitCode = exitCode;
}
