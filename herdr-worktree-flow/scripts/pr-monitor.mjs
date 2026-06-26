#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

function parseArgs(argv) {
  const args = {
    intervalSeconds: 30,
    once: false,
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
      args.prRef = argv[++i];
    } else if (arg === '--repo') {
      args.repo = argv[++i];
    } else if (arg === '--state-file') {
      args.stateFile = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      printHelpAndExit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.intervalSeconds) || args.intervalSeconds <= 0) {
    throw new Error('--interval must be a positive number');
  }

  return args;
}

function printHelpAndExit(code) {
  process.stdout.write(`Usage: pr-monitor.mjs [options]\n\n`);
  process.stdout.write(`Options:\n`);
  process.stdout.write(`  --pr <ref>          PR number, URL, or branch name. Defaults to current branch.\n`);
  process.stdout.write(`  --repo <owner/repo> GitHub repository override for gh.\n`);
  process.stdout.write(`  --interval <sec>    Poll interval in seconds. Default: 30.\n`);
  process.stdout.write(`  --state-file <path> Write the latest snapshot to a JSON state file.\n`);
  process.stdout.write(`  --json              Emit JSON lines.\n`);
  process.stdout.write(`  --text              Emit human-readable lines. Default.\n`);
  process.stdout.write(`  --quiet             Only emit when the snapshot changes.\n`);
  process.stdout.write(`  --once              Take one snapshot and exit.\n`);
  process.stdout.write(`  -h, --help          Show this help.\n`);
  process.exit(code);
}

function ghBaseArgs(repo) {
  return repo ? ['-R', repo] : [];
}

function runGh(args, repo) {
  const result = spawnSync('gh', [...ghBaseArgs(repo), ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error('gh is not installed or not on PATH');
    }
    throw result.error;
  }

  return result;
}

function runGhJson(args, repo, acceptableStatuses = new Set([0])) {
  const result = runGh(args, repo);
  if (!acceptableStatuses.has(result.status)) {
    throw new Error(`gh ${args.join(' ')} failed with exit ${result.status}: ${result.stderr.trim()}`);
  }

  const stdout = result.stdout.trim();
  if (!stdout) {
    return null;
  }

  return JSON.parse(stdout);
}

function maxTimestamp(values) {
  const timestamps = values
    .map((value) => (value ? Date.parse(value) : Number.NEGATIVE_INFINITY))
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
  if (!Array.isArray(checks) || checks.length === 0) {
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
    const bucket = check?.bucket ?? 'unknown';
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

function classifySnapshot(snapshot) {
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

  const actionRequired =
    !terminal && (reviewDecision === 'CHANGES_REQUESTED' || checks.bucket === 'fail' || checks.bucket === 'cancel');

  const feedbackPresent = commentCount > 0 || reviewCount > 0;

  const reasons = [];
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

function formatText(report) {
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

async function writeStateFile(stateFile, report) {
  if (!stateFile) {
    return;
  }

  const json = `${JSON.stringify(report, null, 2)}\n`;
  const tmpFile = `${stateFile}.tmp`;
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(tmpFile, json, 'utf8');
  await rename(tmpFile, stateFile);
}

function loadBaselineFingerprint(stateFile) {
  if (!stateFile) {
    return null;
  }

  try {
    const raw = readFileSync(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed?.fingerprint ?? null;
  } catch {
    return null;
  }
}

async function snapshot(args) {
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
  if (args.prRef) {
    prViewArgs.push(args.prRef);
  }
  prViewArgs.push('--json', prFields);

  const pr = runGhJson(prViewArgs, args.repo);
  const checks = runGhJson(
    ['pr', 'checks', ...(args.prRef ? [args.prRef] : []), '--json', 'bucket,state,name,workflow,description,link'],
    args.repo,
    new Set([0, 8]),
  ) ?? [];

  const comments = Array.isArray(pr.comments) ? pr.comments : [];
  const reviews = Array.isArray(pr.reviews) ? pr.reviews : [];

  return classifySnapshot({
    prNumber: pr.number,
    prUrl: pr.url,
    title: pr.title,
    state: pr.state,
    mergedAt: pr.mergedAt,
    closedAt: pr.closedAt,
    reviewDecision: pr.reviewDecision,
    commentCount: comments.length,
    reviewCount: reviews.length,
    latestCommentAt: maxTimestamp(comments.map((comment) => comment?.createdAt)),
    latestReviewAt: maxTimestamp(reviews.map((review) => review?.submittedAt)),
    checks,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baselineFingerprint = loadBaselineFingerprint(args.stateFile);
  let lastFingerprint = baselineFingerprint;

  while (true) {
    const report = await snapshot(args);
    if (report.fingerprint !== lastFingerprint || !args.quiet) {
      const payload = args.output === 'json' ? JSON.stringify(report) : formatText(report);
      process.stdout.write(`${payload}\n`);
      lastFingerprint = report.fingerprint;
    }

    await writeStateFile(args.stateFile, report);

    if (report.terminal || args.once) {
      process.exit(0);
    }

    await new Promise((resolve) => setTimeout(resolve, args.intervalSeconds * 1000));
  }
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;

if (entryPoint && import.meta.url === entryPoint) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}

export {
  classifySnapshot,
  formatText,
  maxTimestamp,
  parseArgs,
  summarizeChecks,
};
