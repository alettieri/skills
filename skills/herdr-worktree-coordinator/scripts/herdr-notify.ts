import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { SpawnSyncReturns } from 'node:child_process';

export type HerdrAgentTarget = {
  paneId: string;
};

type CommandResult = SpawnSyncReturns<string>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function runHerdr(args: string[], acceptableStatuses = new Set([0])): CommandResult {
  const result = spawnSync('herdr', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    if ('code' in result.error && result.error.code === 'ENOENT') {
      throw new Error('herdr is not installed or not on PATH');
    }
    throw result.error;
  }

  if (result.status === null || !acceptableStatuses.has(result.status)) {
    const stderr = result.stderr?.trim() ?? '';
    throw new Error(`herdr ${args.join(' ')} failed with exit ${result.status}: ${stderr}`);
  }

  return result;
}

export function runHerdrJson(args: string[]): unknown {
  const result = runHerdr(args);
  const stdout = result.stdout.trim();
  if (!stdout) {
    return null;
  }
  return JSON.parse(stdout) as unknown;
}

// This skill hardcodes the Claude launch policy, so a notify target only resolves when
// `herdr agent get` reports a concrete Claude agent pane — not a tab, terminal, or shell.
export function normalizeHerdrAgentTarget(value: unknown): HerdrAgentTarget | null {
  if (!isRecord(value)) {
    return null;
  }
  const result = value.result;
  if (!isRecord(result)) {
    return null;
  }
  const agent = result.agent;
  if (!isRecord(agent)) {
    return null;
  }
  if (agent.agent !== 'claude') {
    return null;
  }
  const paneId = agent.pane_id;
  return typeof paneId === 'string' && paneId.length > 0 ? { paneId } : null;
}

export function markerPath(resultPath: string): string {
  return join(dirname(resultPath), 'notification.json');
}

export type DeliverOptions = {
  returnDelayMs: number;
  label: string;
  maxAttempts?: number;
  retryDelayMs?: number;
};

export async function deliverNotification(target: string, paneId: string, body: string, options: DeliverOptions): Promise<number> {
  const maxAttempts = options.maxAttempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 50;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      runHerdr(['agent', 'send', target, body]);
      await delay(options.returnDelayMs);
      runHerdr(['pane', 'send-keys', paneId, 'Return']);
      return attempt;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await delay(retryDelayMs);
      }
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`failed to deliver ${options.label} after ${maxAttempts} attempts: ${message}`);
}

export type NotificationMarker = {
  runId: string;
  target: string;
  paneId: string;
  deliveredAt: string;
  attempts: number;
};

export async function writeNotificationMarker(path: string, marker: NotificationMarker): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        ...marker,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}
