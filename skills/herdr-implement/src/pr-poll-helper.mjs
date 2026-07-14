import {
  maxTimestamp,
  summarizeChecks,
} from '../../herdr-worktree-flow/scripts/pr-monitor-domain.ts';
import { createPrHostProvider } from '../../herdr-worktree-flow/scripts/pr-host-provider.ts';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
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
    const provider = createPrHostProvider();
    const pr = provider.fetchPullRequest(prRef, null);
    const checks = provider.fetchChecks(prRef, null);

    const commentCount = pr.comments.length;
    const reviewCount = pr.reviews.length;
    const latestCommentAt = maxTimestamp(pr.comments.map((comment) => comment.createdAt));
    const latestReviewAt = maxTimestamp(pr.reviews.map((review) => review.submittedAt));
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
