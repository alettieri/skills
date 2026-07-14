export type OutputMode = 'text' | 'json';

export type MonitorArgs = {
  intervalSeconds: number;
  provider: string | null;
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
  mergedAt?: string | null;
  closedAt?: string | null;
  reviewDecision?: string | null;
  updatedAt?: string | null;
  title?: string;
  comments: ExternalComment[];
  reviews: ExternalReview[];
};

export type HerdrAgentTarget = {
  paneId: string;
};

export type ExternalComment = {
  createdAt?: string | null;
};

export type ExternalReview = {
  submittedAt?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
    throw new Error('PR host returned malformed JSON: expected an object');
  }

  return {
    number: optionalNumber(value.number),
    url: optionalString(value.url),
    state: optionalString(value.state),
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
  if (agent.agent !== 'codex') {
    return null;
  }
  const paneId = agent.pane_id;
  return typeof paneId === 'string' && paneId.length > 0 ? { paneId } : null;
}

export function parseArgs(argv: string[]): MonitorArgs {
  const args: MonitorArgs = {
    intervalSeconds: 30,
    provider: null,
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
    } else if (arg === '--provider') {
      args.provider = argv[++i] ?? null;
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

export class HelpRequested extends Error {
  constructor() {
    super('Help requested');
    this.name = 'HelpRequested';
  }
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

export function formatText(report: MonitorReport): string {
  const status = report.terminal
    ? report.mergedAt
      ? 'MERGED'
      : 'CLOSED'
    : 'OPEN';
  const action = report.actionRequired ? 'action-required' : 'monitoring';
  const reasons = report.reasons.length > 0 ? report.reasons.join(',') : 'none';
  const title = report.title ? ` title="${report.title}"` : '';
  return `${report.generatedAt} PR#${report.prNumber ?? '?'} ${status}${title} review=${report.reviewDecision} checks=${report.checks.bucket} comments=${report.commentCount} reviews=${report.reviewCount} ${action} reasons=${reasons}`;
}
