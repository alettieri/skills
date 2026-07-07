import { spawnSync } from 'node:child_process';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function runGh(args) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

function runGhJson(args, allowNoChecks = false) {
  const result = runGh(args);
  if (allowNoChecks && result.status === 1 && result.stderr.includes('no checks reported')) {
    return [];
  }
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(' ')} failed with exit ${result.status}: ${result.stderr.trim()}`);
  }

  const stdout = result.stdout.trim();
  return stdout ? JSON.parse(stdout) : null;
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function latestTimestamp(values) {
  const timestamps = values
    .map((value) => (typeof value === 'string' && value ? Date.parse(value) : Number.NEGATIVE_INFINITY))
    .filter((value) => Number.isFinite(value));
  if (timestamps.length === 0) {
    return null;
  }
  return new Date(Math.max(...timestamps)).toISOString();
}

function bucketRank(bucket) {
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
    default:
      return -1;
  }
}

function summarizeChecks(checks) {
  const summary = {
    bucket: 'unknown',
    total: checks.length,
    failing: 0,
    pending: 0,
    canceled: 0,
    skipped: 0,
    passing: 0,
  };

  for (const check of checks) {
    const bucket = typeof check?.bucket === 'string' ? check.bucket : 'unknown';
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

function resolveOutcome(mode, pr, checksSummary, feedbackPresent) {
  const merged = Boolean(pr.mergedAt);
  const closed = Boolean(pr.closedAt) && !merged;
  const reviewDecision = optionalString(pr.reviewDecision) ?? 'REVIEW_REQUIRED';

  if (mode === 'review') {
    if (merged || closed) {
      return 'closed';
    }
    if (reviewDecision === 'CHANGES_REQUESTED') {
      return 'changes_requested';
    }
    if (checksSummary.bucket === 'fail') {
      return 'checks_failed';
    }
    if (reviewDecision === 'APPROVED' && checksSummary.bucket === 'pass') {
      return 'approved';
    }
    if (reviewDecision === 'APPROVED') {
      return 'waiting';
    }
    if (feedbackPresent) {
      return 'feedback';
    }
    return 'waiting';
  }

  if (merged) {
    return 'merged';
  }
  if (closed) {
    return 'closed';
  }
  if (checksSummary.bucket === 'fail') {
    return 'checks_failed';
  }
  if (reviewDecision === 'CHANGES_REQUESTED' || (reviewDecision !== 'APPROVED' && feedbackPresent)) {
    return 'feedback';
  }
  return 'waiting';
}

function main() {
  const mode = process.argv[2];
  const prRef = optionalString(process.argv[3]);

  if (mode !== 'review' && mode !== 'merged') {
    fail('usage: pr-poll-helper.mjs <review|merged> [pr-ref]');
  }

  try {
    const prFields = [
      'number',
      'url',
      'state',
      'mergedAt',
      'closedAt',
      'reviewDecision',
      'updatedAt',
      'title',
      'comments',
      'reviews',
    ].join(',');

    const prViewArgs = ['pr', 'view'];
    if (prRef) {
      prViewArgs.push(prRef);
    }
    prViewArgs.push('--json', prFields);
    const pr = runGhJson(prViewArgs);

    const checksArgs = ['pr', 'checks'];
    if (prRef) {
      checksArgs.push(prRef);
    }
    checksArgs.push('--json', 'bucket,state,name,workflow,description,link');
    const checks = runGhJson(checksArgs, true) ?? [];

    const commentCount = Array.isArray(pr.comments) ? pr.comments.length : 0;
    const reviewCount = Array.isArray(pr.reviews) ? pr.reviews.length : 0;
    const latestCommentAt = latestTimestamp(Array.isArray(pr.comments) ? pr.comments.map((comment) => comment?.createdAt) : []);
    const latestReviewAt = latestTimestamp(Array.isArray(pr.reviews) ? pr.reviews.map((review) => review?.submittedAt) : []);
    const checksSummary = summarizeChecks(checks);
    const feedbackPresent = commentCount > 0 || reviewCount > 0;

    const capture = {
      pr_number: pr.number ?? null,
      pr_url: pr.url ?? null,
      pr_state: pr.state ?? null,
      merged_at: pr.mergedAt ?? null,
      closed_at: pr.closedAt ?? null,
      review_decision: optionalString(pr.reviewDecision) ?? 'REVIEW_REQUIRED',
      comment_count: commentCount,
      review_count: reviewCount,
      latest_comment_at: latestCommentAt,
      latest_review_at: latestReviewAt,
      checks_bucket: checksSummary.bucket,
      checks_total: checksSummary.total,
      checks_failing: checksSummary.failing,
      checks_pending: checksSummary.pending,
      checks_canceled: checksSummary.canceled,
      checks_skipped: checksSummary.skipped,
      checks_passing: checksSummary.passing,
      feedback_present: feedbackPresent,
    };

    const outcome = resolveOutcome(mode, pr, checksSummary, feedbackPresent);
    process.stdout.write(`${JSON.stringify({ outcome, capture })}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`pr poll helper failed: ${message}`);
  }
}

main();
