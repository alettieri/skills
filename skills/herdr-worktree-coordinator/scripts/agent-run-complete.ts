import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  deliverNotification,
  isRecord,
  markerPath,
  normalizeHerdrAgentTarget,
  runHerdr,
  runHerdrJson,
  writeNotificationMarker,
} from './herdr-notify.ts';
import type { HerdrAgentTarget } from './herdr-notify.ts';

type CompletionRole = 'implementer' | 'reviewer';
type CompletionStatus = 'complete' | 'blocked' | 'failed';

type CompletionArgs = {
  runId: string;
  role: CompletionRole;
  phase: string;
  resultPath: string;
  notifyTarget: string;
};

type ResultArtifact = {
  schemaVersion: 1;
  runId: string;
  role: CompletionRole;
  phase: string;
  status: CompletionStatus;
  summary: string;
  payload: Record<string, unknown>;
};

const ACCEPTED_ROLES = new Set(['implementer', 'reviewer']);
const ACCEPTED_STATUSES = new Set(['complete', 'blocked', 'failed']);
const DEFAULT_HERDR_RETURN_DELAY_MS = 250;

function requireValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (value === undefined) {
    throw new Error(`${option} requires a value`);
  }
  if (value.trim() === '') {
    throw new Error(`${option} must not be empty`);
  }
  return value;
}

function parseArgs(argv: string[]): CompletionArgs {
  const parsed: Partial<Record<keyof CompletionArgs, string>> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--run-id':
        parsed.runId = requireValue(argv, index, arg);
        index += 1;
        break;
      case '--role':
        parsed.role = requireValue(argv, index, arg);
        index += 1;
        break;
      case '--phase':
        parsed.phase = requireValue(argv, index, arg);
        index += 1;
        break;
      case '--result':
        parsed.resultPath = requireValue(argv, index, arg);
        index += 1;
        break;
      case '--notify-target':
        parsed.notifyTarget = requireValue(argv, index, arg);
        index += 1;
        break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }

  for (const key of ['runId', 'role', 'phase', 'resultPath', 'notifyTarget'] as const) {
    if (!parsed[key]) {
      throw new Error(`missing required option --${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
    }
  }

  if (!ACCEPTED_ROLES.has(parsed.role as string)) {
    throw new Error('--role must be one of: implementer, reviewer');
  }

  return parsed as CompletionArgs;
}

function printHelp(): void {
  process.stdout.write(
    'Usage: agent-run-complete.ts --run-id <id> --role <implementer|reviewer> --phase <phase> --result <path> --notify-target <target>\n',
  );
}

function parseResultArtifact(args: CompletionArgs): ResultArtifact {
  if (!existsSync(args.resultPath)) {
    throw new Error(`result artifact does not exist: ${args.resultPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(args.resultPath, 'utf8')) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`result artifact is not valid JSON: ${message}`);
  }

  if (!isRecord(parsed)) {
    throw new Error('result artifact must be a JSON object');
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error('result artifact schemaVersion must be 1');
  }
  if (parsed.runId !== args.runId) {
    throw new Error(`result artifact runId mismatch: expected ${args.runId}`);
  }
  if (parsed.role !== args.role) {
    throw new Error(`result artifact role mismatch: expected ${args.role}`);
  }
  if (parsed.phase !== args.phase) {
    throw new Error(`result artifact phase mismatch: expected ${args.phase}`);
  }
  if (!ACCEPTED_STATUSES.has(parsed.status as string)) {
    throw new Error('result artifact status must be one of: complete, blocked, failed');
  }
  if (typeof parsed.summary !== 'string' || parsed.summary.trim() === '') {
    throw new Error('result artifact summary must be a non-empty string');
  }
  if (parsed.payload !== undefined && !isRecord(parsed.payload)) {
    throw new Error('result artifact payload must be an object');
  }

  return {
    ...(parsed as Omit<ResultArtifact, 'payload'>),
    payload: isRecord(parsed.payload) ? parsed.payload : {},
  };
}

function herdrReturnDelayMs(): number {
  const raw = process.env.AGENT_RUN_COMPLETE_HERDR_RETURN_DELAY_MS;
  if (raw === undefined) {
    return DEFAULT_HERDR_RETURN_DELAY_MS;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_HERDR_RETURN_DELAY_MS;
  }

  return parsed;
}

function formatNotificationBody(args: CompletionArgs, artifact: ResultArtifact, notificationPath: string): string {
  return [
    `AGENT_RUN_COMPLETE ${args.runId} ${args.resultPath}`,
    `Role: ${args.role}`,
    `Phase: ${args.phase}`,
    `Status: ${artifact.status}`,
    `Summary: ${artifact.summary}`,
    `Notification marker: ${notificationPath}`,
  ].join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const artifact = parseResultArtifact(args);
  const agentTarget = normalizeHerdrAgentTarget(runHerdrJson(['agent', 'get', args.notifyTarget]));

  if (!agentTarget) {
    throw new Error(
      `herdr notify target ${args.notifyTarget} does not resolve to a Claude agent; refusing to send completion notification.\n`
        + 'Use the issue orchestrator agent name from `herdr agent list`, not a tab id, pane id, or shell terminal.',
    );
  }

  const notificationPath = markerPath(args.resultPath);
  const body = formatNotificationBody(args, artifact, notificationPath);
  const attempts = await deliverNotification(args.notifyTarget, agentTarget.paneId, body, {
    returnDelayMs: herdrReturnDelayMs(),
    label: 'completion notification',
  });
  const deliveredAt = new Date().toISOString();
  await writeNotificationMarker(notificationPath, {
    runId: args.runId,
    target: args.notifyTarget,
    paneId: agentTarget.paneId,
    deliveredAt,
    attempts,
  });
  process.stderr.write(`agent-run-complete delivered target=${args.notifyTarget} attempts=${attempts} marker=${notificationPath}\n`);
}

const entryPoint = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : null;

if (entryPoint && import.meta.url === entryPoint) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}

export { parseArgs, parseResultArtifact, normalizeHerdrAgentTarget, formatNotificationBody };
export type { CompletionArgs, ResultArtifact, HerdrAgentTarget };
