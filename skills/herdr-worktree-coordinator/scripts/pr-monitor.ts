import { readFileSync, realpathSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { deliverNotification, isRecord, normalizeHerdrAgentTarget, runHerdrJson } from './herdr-notify.ts';

export type OutputMode = 'text' | 'json';

export type MonitorArgs = {
  intervalSeconds: number;
  once: boolean;
  notifyTarget: string | null;
  quiet: boolean;
  output: OutputMode;
  prRef: string | null;
  repo: string | null;
  stateFile: string | null;
};

export type CheckBucket = 'fail' | 'pending' | 'cancel' | 'skipping' | 'pass' | 'unknown';

export type CheckResult = {
  bucket: CheckBucket;
  state?: string;
  name?: string;
  workflow?: string;
  description?: string;
  link?: string;
};

export type CheckSummary = {
  bucket: CheckBucket;
  total: number;
  failing: number;
  pending: number;
  canceled: number;
  skipped: number;
  passing: number;
};

export type PullRequestSnapshot = {
  prNumber?: number;
  prUrl?: string;
  title?: string;
  state?: string;
  isDraft?: boolean;
  mergedAt?: string | null;
  closedAt?: string | null;
  reviewDecision?: string | null;
  commentCount?: number;
  reviewCount?: number;
  latestCommentAt?: string | null;
  latestReviewAt?: string | null;
  checks: CheckResult[];
};

export type NotificationReason =
  | 'merged'
  | 'closed'
  | 'changes_requested'
  | 'failing_checks'
  | 'pending_checks'
  | 'canceled_checks'
  | 'feedback_present'
  | 'monitoring';

export type MonitorReport = {
  prNumber?: number;
  prUrl?: string;
  title?: string;
  state?: string;
  isDraft: boolean;
  mergedAt: string | null;
  closedAt: string | null;
  reviewDecision: string;
  checks: CheckSummary;
  commentCount: number;
  reviewCount: number;
  latestFeedbackAt: string | null;
  actionRequired: boolean;
  feedbackPresent: boolean;
  reasons: NotificationReason[];
  checkResults: CheckResult[];
  terminal: boolean;
  generatedAt: string;
  fingerprint: string;
};

export type PullRequestPayload = {
  number?: number;
  url?: string;
  state?: string;
  isDraft?: boolean;
  mergedAt?: string | null;
  closedAt?: string | null;
  reviewDecision?: string | null;
  updatedAt?: string | null;
  title?: string;
  comments: ExternalComment[];
  reviews: ExternalReview[];
};

export type ExternalComment = {
  createdAt?: string | null;
};

export type ExternalReview = {
  submittedAt?: string | null;
};

type CommandResult = SpawnSyncReturns<string>;

const DEFAULT_HERDR_RETURN_DELAY_MS = 250;

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNullableString(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return optionalString(value);
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function normalizeComment(value: unknown): ExternalComment {
  if (!isRecord(value)) {
    return {};
  }
  return {
    createdAt: optionalNullableString(value.createdAt),
  };
}

function normalizeReview(value: unknown): ExternalReview {
  if (!isRecord(value)) {
    return {};
  }
  return {
    submittedAt: optionalNullableString(value.submittedAt),
  };
}

export function normalizePullRequestPayload(value: unknown): PullRequestPayload {
  if (!isRecord(value)) {
    throw new Error('gh pr view returned malformed JSON: expected an object');
  }

  return {
    number: optionalNumber(value.number),
    url: optionalString(value.url),
    state: optionalString(value.state),
    isDraft: optionalBoolean(value.isDraft),
    mergedAt: optionalNullableString(value.mergedAt),
    closedAt: optionalNullableString(value.closedAt),
    reviewDecision: optionalNullableString(value.reviewDecision),
    updatedAt: optionalNullableString(value.updatedAt),
    title: optionalString(value.title),
    comments: Array.isArray(value.comments) ? value.comments.map(normalizeComment) : [],
    reviews: Array.isArray(value.reviews) ? value.reviews.map(normalizeReview) : [],
  };
}

function normalizeBucket(value: unknown): CheckBucket {
  switch (value) {
    case 'fail':
    case 'pending':
    case 'cancel':
    case 'skipping':
    case 'pass':
      return value;
    default:
      return 'unknown';
  }
}

function normalizeCheckResult(value: unknown): CheckResult {
  if (!isRecord(value)) {
    return { bucket: 'unknown' };
  }

  const check: CheckResult = {
    bucket: normalizeBucket(value.bucket),
  };

  const state = optionalString(value.state);
  const name = optionalString(value.name);
  const workflow = optionalString(value.workflow);
  const description = optionalString(value.description);
  const link = optionalString(value.link);

  if (state !== undefined) {
    check.state = state;
  }
  if (name !== undefined) {
    check.name = name;
  }
  if (workflow !== undefined) {
    check.workflow = workflow;
  }
  if (description !== undefined) {
    check.description = description;
  }
  if (link !== undefined) {
    check.link = link;
  }

  return check;
}

export function normalizeCheckResultsPayload(value: unknown): CheckResult[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(normalizeCheckResult);
}

export function normalizeBaselineFingerprint(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  return typeof value.fingerprint === 'string' ? value.fingerprint : null;
}

export function normalizeNotifiedFingerprint(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  return typeof value.notifiedFingerprint === 'string' ? value.notifiedFingerprint : null;
}

export { normalizeHerdrAgentTarget };

export class HelpRequested extends Error {
  constructor() {
    super('Help requested');
    this.name = 'HelpRequested';
  }
}

export function parseArgs(argv: string[]): MonitorArgs {
  const args: MonitorArgs = {
    intervalSeconds: 30,
    once: false,
    notifyTarget: null,
    quiet: false,
    output: 'text',
    prRef: null,
    repo: null,
    stateFile: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--interval') {
      args.intervalSeconds = Number(argv[++i]);
    } else if (arg === '--once') {
      args.once = true;
    } else if (arg === '--quiet') {
      args.quiet = true;
    } else if (arg === '--json') {
      args.output = 'json';
    } else if (arg === '--text') {
      args.output = 'text';
    } else if (arg === '--pr') {
      args.prRef = argv[++i] ?? null;
    } else if (arg === '--repo') {
      args.repo = argv[++i] ?? null;
    } else if (arg === '--state-file') {
      args.stateFile = argv[++i] ?? null;
    } else if (arg === '--notify-target') {
      const target = argv[++i];
      if (target === undefined || target.startsWith('--')) {
        throw new Error('--notify-target requires a target value');
      }
      args.notifyTarget = target;
    } else if (arg === '--help' || arg === '-h') {
      throw new HelpRequested();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.intervalSeconds) || args.intervalSeconds <= 0) {
    throw new Error('--interval must be a positive number');
  }

  if (args.notifyTarget !== null && args.notifyTarget.trim() === '') {
    throw new Error('--notify-target must not be empty');
  }

  return args;
}

export function maxTimestamp(values: Array<string | null | undefined>): string | null {
  const timestamps = values
    .map((value) => (value ? Date.parse(value) : Number.NEGATIVE_INFINITY))
    .filter((value) => Number.isFinite(value));
  if (timestamps.length === 0) {
    return null;
  }
  return new Date(Math.max(...timestamps)).toISOString();
}

function bucketRank(bucket: CheckBucket): number {
  switch (bucket) {
    case 'fail':
      return 4;
    case 'pending':
      return 3;
    case 'cancel':
      return 2;
    case 'skipping':
      return 1;
    case 'pass':
      return 0;
    case 'unknown':
      return -1;
  }
}

export function summarizeChecks(checks: CheckResult[]): CheckSummary {
  if (checks.length === 0) {
    return {
      bucket: 'unknown',
      total: 0,
      failing: 0,
      pending: 0,
      canceled: 0,
      skipped: 0,
      passing: 0,
    };
  }

  const summary: CheckSummary = {
    bucket: 'unknown',
    total: checks.length,
    failing: 0,
    pending: 0,
    canceled: 0,
    skipped: 0,
    passing: 0,
  };

  for (const check of checks) {
    const bucket = check.bucket;
    if (bucketRank(bucket) > bucketRank(summary.bucket)) {
      summary.bucket = bucket;
    }
    if (bucket === 'fail') {
      summary.failing += 1;
    } else if (bucket === 'pending') {
      summary.pending += 1;
    } else if (bucket === 'cancel') {
      summary.canceled += 1;
    } else if (bucket === 'skipping') {
      summary.skipped += 1;
    } else if (bucket === 'pass') {
      summary.passing += 1;
    }
  }

  return summary;
}

export function describeNotificationReason(report: MonitorReport): NotificationReason {
  if (report.terminal) {
    return report.mergedAt ? 'merged' : 'closed';
  }

  if (report.reviewDecision === 'CHANGES_REQUESTED') {
    return 'changes_requested';
  }

  if (report.checks.bucket === 'fail') {
    return 'failing_checks';
  }

  if (report.checks.bucket === 'cancel') {
    return 'canceled_checks';
  }

  return report.reasons[0] ?? 'monitoring';
}

export function formatCheckSummary(checks: CheckSummary): string {
  return `bucket=${checks.bucket} total=${checks.total} failing=${checks.failing} pending=${checks.pending} canceled=${checks.canceled} skipped=${checks.skipped} passing=${checks.passing}`;
}

function formatCheckPointer(check: CheckResult): string {
  const parts: string[] = [];

  if (check.workflow) {
    parts.push(check.workflow);
  }

  if (check.name && check.name !== check.workflow) {
    parts.push(check.name);
  }

  if (check.description) {
    parts.push(check.description);
  }

  if (check.link) {
    parts.push(check.link);
  }

  return `- ${parts.join(' | ')}`;
}

export function formatNotificationBody(report: MonitorReport, stateFile: string | null): string {
  const lines = [
    `PR #${report.prNumber ?? '?'}`,
    `URL: ${report.prUrl ?? '(unknown)'}`,
    `Reason: ${describeNotificationReason(report)}`,
    `Review decision: ${report.reviewDecision}`,
    `Check summary: ${formatCheckSummary(report.checks)}`,
    `State file: ${stateFile ?? '(none)'}`,
  ];

  const pointers = report.checkResults.filter((check) => check.bucket === 'fail' || check.bucket === 'cancel');

  if (pointers.length > 0) {
    lines.push('Failed check pointers:');
    for (const check of pointers) {
      lines.push(formatCheckPointer(check));
    }
  }

  return lines.join('\n');
}

export function classifySnapshot(snapshot: PullRequestSnapshot): MonitorReport {
  const merged = Boolean(snapshot.mergedAt);
  const closed = Boolean(snapshot.closedAt) && !merged;
  const terminal = merged || closed;
  const checks = summarizeChecks(snapshot.checks);
  const reviewDecision = snapshot.reviewDecision ?? 'REVIEW_REQUIRED';
  const commentCount = snapshot.commentCount ?? 0;
  const reviewCount = snapshot.reviewCount ?? 0;
  const latestFeedbackAt = maxTimestamp([
    snapshot.latestCommentAt,
    snapshot.latestReviewAt,
  ]);
  const feedbackPresent = commentCount > 0 || reviewCount > 0;

  const actionRequired =
    !terminal
    && (
      reviewDecision === 'CHANGES_REQUESTED'
      || checks.bucket === 'fail'
      || checks.bucket === 'cancel'
      || feedbackPresent
    );

  const reasons: NotificationReason[] = [];
  if (terminal) {
    reasons.push(merged ? 'merged' : 'closed');
  } else {
    if (reviewDecision === 'CHANGES_REQUESTED') {
      reasons.push('changes_requested');
    }
    if (checks.bucket === 'fail') {
      reasons.push('failing_checks');
    } else if (checks.bucket === 'pending') {
      reasons.push('pending_checks');
    } else if (checks.bucket === 'cancel') {
      reasons.push('canceled_checks');
    }
    if (feedbackPresent) {
      reasons.push('feedback_present');
    }
  }

  return {
    prNumber: snapshot.prNumber,
    prUrl: snapshot.prUrl,
    title: snapshot.title,
    state: snapshot.state,
    isDraft: snapshot.isDraft ?? false,
    mergedAt: snapshot.mergedAt ?? null,
    closedAt: snapshot.closedAt ?? null,
    reviewDecision,
    checks,
    commentCount,
    reviewCount,
    latestFeedbackAt,
    actionRequired,
    feedbackPresent,
    reasons,
    checkResults: snapshot.checks,
    terminal,
    generatedAt: new Date().toISOString(),
    fingerprint: JSON.stringify({
      state: snapshot.state,
      mergedAt: snapshot.mergedAt ?? null,
      closedAt: snapshot.closedAt ?? null,
      reviewDecision,
      checksBucket: checks.bucket,
      commentCount,
      reviewCount,
      latestFeedbackAt,
    }),
  };
}

// Once a draft PR has no actionable feedback outstanding, the monitor takes it out of draft itself.
export function shouldMarkReady(report: MonitorReport): boolean {
  return report.isDraft && !report.terminal && !report.actionRequired;
}

export function formatText(report: MonitorReport): string {
  const status = report.terminal
    ? report.mergedAt
      ? 'MERGED'
      : 'CLOSED'
    : 'OPEN';
  const action = report.actionRequired ? 'action-required' : 'monitoring';
  const reasons = report.reasons.length > 0 ? report.reasons.join(',') : 'none';
  const title = report.title ? ` title="${report.title}"` : '';
  const draft = report.isDraft ? ' draft=true' : '';
  return `${report.generatedAt} PR#${report.prNumber ?? '?'} ${status}${draft}${title} review=${report.reviewDecision} checks=${report.checks.bucket} comments=${report.commentCount} reviews=${report.reviewCount} ${action} reasons=${reasons}`;
}

function logStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

function formatArgsValue(value: string | null): string {
  return value ?? '(default)';
}

function logStartup(args: MonitorArgs): void {
  logStderr(
    [
      'pr-monitor start',
      `output=${args.output}`,
      `interval=${args.intervalSeconds}`,
      `once=${args.once}`,
      `quiet=${args.quiet}`,
      `pr=${formatArgsValue(args.prRef)}`,
      `repo=${formatArgsValue(args.repo)}`,
      `stateFile=${formatArgsValue(args.stateFile)}`,
      `notifyTarget=${formatArgsValue(args.notifyTarget)}`,
    ].join(' '),
  );
}

function logPoll(report: MonitorReport): void {
  logStderr(
    [
      'pr-monitor poll',
      `pr=${report.prNumber ?? '?'}`,
      `state=${report.state ?? '(unknown)'}`,
      `draft=${report.isDraft}`,
      `review=${report.reviewDecision}`,
      `checks=${report.checks.bucket}`,
      `comments=${report.commentCount}`,
      `reviews=${report.reviewCount}`,
      `reasons=${report.reasons.join(',') || 'none'}`,
      `actionRequired=${report.actionRequired}`,
    ].join(' '),
  );
}

function logDecision(message: string): void {
  logStderr(`pr-monitor decision ${message}`);
}

function herdrReturnDelayMs(): number {
  const raw = process.env.PR_MONITOR_HERDR_RETURN_DELAY_MS;
  if (raw === undefined) {
    return DEFAULT_HERDR_RETURN_DELAY_MS;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_HERDR_RETURN_DELAY_MS;
  }

  return parsed;
}

export function printHelp(): void {
  process.stdout.write(`Usage: pr-monitor.ts [options]\n\n`);
  process.stdout.write(`Options:\n`);
  process.stdout.write(`  --pr <ref>          PR number, URL, or branch name. Defaults to current branch.\n`);
  process.stdout.write(`  --repo <owner/repo> GitHub repository override for gh.\n`);
  process.stdout.write(`  --interval <sec>    Poll interval in seconds. Default: 30.\n`);
  process.stdout.write(`  --state-file <path> Write the latest snapshot to a JSON state file.\n`);
  process.stdout.write(`  --notify-target <target>\n`);
  process.stdout.write(`                      Send one Herdr notification to the target when the PR becomes actionable or terminal.\n`);
  process.stdout.write(`  --json              Emit JSON lines.\n`);
  process.stdout.write(`  --text              Emit human-readable lines. Default.\n`);
  process.stdout.write(`  --quiet             Only emit when the snapshot changes.\n`);
  process.stdout.write(`  --once              Take one snapshot and exit.\n`);
  process.stdout.write(`  -h, --help          Show this help.\n`);
}

function ghBaseArgs(repo: string | null): string[] {
  return repo ? ['-R', repo] : [];
}

function runGh(args: string[], repo: string | null): CommandResult {
  const result = spawnSync('gh', [...ghBaseArgs(repo), ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    if ('code' in result.error && result.error.code === 'ENOENT') {
      throw new Error('gh is not installed or not on PATH');
    }
    throw result.error;
  }

  return result;
}

function runGhJson(args: string[], repo: string | null, acceptableStatuses = new Set([0])): unknown {
  const result = runGh(args, repo);
  if (result.status === null || !acceptableStatuses.has(result.status)) {
    throw new Error(`gh ${args.join(' ')} failed with exit ${result.status}: ${result.stderr.trim()}`);
  }

  const stdout = result.stdout.trim();
  if (!stdout) {
    return null;
  }

  return JSON.parse(stdout) as unknown;
}

function isNoChecksReportedResult(result: CommandResult): boolean {
  return result.status === 1 && result.stderr.trim().includes('no checks reported');
}

function runGhChecksJson(args: string[], repo: string | null): unknown {
  const result = runGh(args, repo);
  if (isNoChecksReportedResult(result)) {
    logStderr(`pr-monitor gh checks normalized empty: ${result.stderr.trim()}`);
    return [];
  }
  if (result.status === null || !new Set([0, 8]).has(result.status)) {
    throw new Error(`gh ${args.join(' ')} failed with exit ${result.status}: ${result.stderr.trim()}`);
  }

  const stdout = result.stdout.trim();
  if (!stdout) {
    return null;
  }

  return JSON.parse(stdout) as unknown;
}

function runGhReady(prRef: string | null, repo: string | null): void {
  const result = runGh(['pr', 'ready', ...(prRef ? [prRef] : [])], repo);
  if (result.status !== 0) {
    throw new Error(`gh pr ready failed with exit ${result.status}: ${result.stderr.trim()}`);
  }
}

type PersistedState = MonitorReport & {
  notifiedFingerprint?: string | null;
};

async function writeStateFile(
  stateFile: string | null,
  report: MonitorReport,
  notifiedFingerprint?: string | null,
): Promise<void> {
  if (!stateFile) {
    return;
  }

  logDecision(`write-state ${stateFile}`);
  const persisted: PersistedState = notifiedFingerprint
    ? { ...report, notifiedFingerprint }
    : { ...report };
  const json = `${JSON.stringify(persisted, null, 2)}\n`;
  const tmpFile = `${stateFile}.tmp`;
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(tmpFile, json, 'utf8');
  await rename(tmpFile, stateFile);
}

function loadBaselineFingerprint(stateFile: string | null): string | null {
  if (!stateFile) {
    return null;
  }

  try {
    const raw = readFileSync(stateFile, 'utf8');
    return normalizeBaselineFingerprint(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function loadNotifiedFingerprint(stateFile: string | null): string | null {
  if (!stateFile) {
    return null;
  }

  try {
    const raw = readFileSync(stateFile, 'utf8');
    return normalizeNotifiedFingerprint(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

async function snapshot(args: MonitorArgs): Promise<MonitorReport> {
  const prFields = [
    'number',
    'url',
    'state',
    'isDraft',
    'mergedAt',
    'closedAt',
    'reviewDecision',
    'updatedAt',
    'title',
    'comments',
    'reviews',
  ].join(',');

  const prViewArgs = ['pr', 'view'];
  if (args.prRef) {
    prViewArgs.push(args.prRef);
  }
  prViewArgs.push('--json', prFields);

  const pr = normalizePullRequestPayload(runGhJson(prViewArgs, args.repo));
  const checks = normalizeCheckResultsPayload(
    runGhChecksJson(
      ['pr', 'checks', ...(args.prRef ? [args.prRef] : []), '--json', 'bucket,state,name,workflow,description,link'],
      args.repo,
    ),
  );

  return classifySnapshot({
    prNumber: pr.number,
    prUrl: pr.url,
    title: pr.title,
    state: pr.state,
    isDraft: pr.isDraft,
    mergedAt: pr.mergedAt,
    closedAt: pr.closedAt,
    reviewDecision: pr.reviewDecision,
    commentCount: pr.comments.length,
    reviewCount: pr.reviews.length,
    latestCommentAt: maxTimestamp(pr.comments.map((comment) => comment.createdAt)),
    latestReviewAt: maxTimestamp(pr.reviews.map((review) => review.submittedAt)),
    checks,
  });
}

async function sendNotification(target: string, body: string): Promise<void> {
  logDecision(`notify target=${target}`);
  const agentTarget = normalizeHerdrAgentTarget(runHerdrJson(['agent', 'get', target]));

  if (!agentTarget) {
    throw new Error(
      `herdr send target ${target} does not resolve to a Claude agent; refusing to send notification.\n`
      + 'Use the issue orchestrator agent name from `herdr agent list`, not a tab id, pane id, or shell terminal.',
    );
  }

  const returnDelayMs = herdrReturnDelayMs();
  logDecision(`wait-before-return ms=${returnDelayMs}`);
  const attempts = await deliverNotification(target, agentTarget.paneId, body, {
    returnDelayMs,
    label: 'PR notification',
  });
  logDecision(`sent-return pane=${agentTarget.paneId} attempts=${attempts}`);
}

function maybeMarkReady(report: MonitorReport, args: MonitorArgs): void {
  if (!shouldMarkReady(report)) {
    return;
  }

  logDecision(`mark-ready pr=${report.prNumber ?? '?'}`);
  runGhReady(args.prRef, args.repo);
  logDecision('marked-ready');
}

async function main(): Promise<void> {
  let args: MonitorArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof HelpRequested) {
      printHelp();
      process.exit(0);
    }
    throw error;
  }

  const baselineFingerprint = loadBaselineFingerprint(args.stateFile);
  let notifiedFingerprint = loadNotifiedFingerprint(args.stateFile);
  let lastFingerprint = baselineFingerprint;
  const notifyMode = Boolean(args.notifyTarget);

  logStartup(args);

  while (true) {
    const report = await snapshot(args);
    logPoll(report);
    maybeMarkReady(report, args);

    if (!notifyMode && (report.fingerprint !== lastFingerprint || !args.quiet)) {
      const payload = args.output === 'json' ? JSON.stringify(report) : formatText(report);
      process.stdout.write(`${payload}\n`);
      lastFingerprint = report.fingerprint;
    }

    if (notifyMode) {
      if (report.actionRequired || report.terminal) {
        if (report.fingerprint !== notifiedFingerprint) {
          logDecision(`notify-ready target=${args.notifyTarget}`);
          await writeStateFile(args.stateFile, report);
          const body = formatNotificationBody(report, args.stateFile);
          await sendNotification(args.notifyTarget as string, body);
          await writeStateFile(args.stateFile, report, report.fingerprint);
          notifiedFingerprint = report.fingerprint;

          if (report.terminal) {
            logDecision('exit-terminal');
            process.exit(0);
          }
        } else if (report.terminal) {
          logDecision('duplicate-terminal exit');
          process.exit(0);
        } else {
          logDecision('duplicate-actionable continue');
        }
      }
      logDecision('continue');
    } else {
      logDecision('write-state-and-evaluate');
      await writeStateFile(args.stateFile, report);

      if (report.terminal || args.once) {
        logDecision(report.terminal ? 'exit-terminal' : 'exit-once');
        process.exit(0);
      }
      logDecision('continue');
    }

    await new Promise((resolve) => setTimeout(resolve, args.intervalSeconds * 1000));
  }
}

const entryPoint = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : null;

if (entryPoint && import.meta.url === entryPoint) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
