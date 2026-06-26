import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySnapshot, formatNotificationBody, parseArgs, summarizeChecks } from './pr-monitor.mjs';

test('summarizeChecks prefers failing over pending and pass', () => {
  const summary = summarizeChecks([
    { bucket: 'pass' },
    { bucket: 'pending' },
    { bucket: 'fail' },
  ]);

  assert.equal(summary.bucket, 'fail');
  assert.equal(summary.total, 3);
  assert.equal(summary.failing, 1);
  assert.equal(summary.pending, 1);
  assert.equal(summary.passing, 1);
});

test('summarizeChecks preserves unknown when no known buckets exist', () => {
  const summary = summarizeChecks([{ bucket: 'mystery' }]);

  assert.equal(summary.bucket, 'unknown');
  assert.equal(summary.total, 1);
});

test('classifySnapshot marks open PRs with pending checks as monitoring', () => {
  const report = classifySnapshot({
    prNumber: 42,
    prUrl: 'https://github.com/acme/repo/pull/42',
    title: 'Add monitor loop',
    state: 'OPEN',
    reviewDecision: 'REVIEW_REQUIRED',
    commentCount: 0,
    reviewCount: 0,
    checks: [{ bucket: 'pending' }],
  });

  assert.equal(report.terminal, false);
  assert.equal(report.actionRequired, false);
  assert.equal(report.checks.bucket, 'pending');
  assert.deepEqual(report.reasons, ['pending_checks']);
});

test('classifySnapshot flags requested changes as action required', () => {
  const report = classifySnapshot({
    prNumber: 42,
    prUrl: 'https://github.com/acme/repo/pull/42',
    state: 'OPEN',
    reviewDecision: 'CHANGES_REQUESTED',
    commentCount: 2,
    reviewCount: 1,
    checks: [{ bucket: 'pass' }],
  });

  assert.equal(report.terminal, false);
  assert.equal(report.actionRequired, true);
  assert.equal(report.feedbackPresent, true);
  assert.deepEqual(report.reasons, ['changes_requested', 'feedback_present']);
});

test('classifySnapshot treats merged PRs as terminal', () => {
  const report = classifySnapshot({
    prNumber: 42,
    prUrl: 'https://github.com/acme/repo/pull/42',
    state: 'MERGED',
    mergedAt: '2026-06-25T12:34:56Z',
    reviewDecision: 'APPROVED',
    commentCount: 4,
    reviewCount: 2,
    checks: [{ bucket: 'pass' }],
  });

  assert.equal(report.terminal, true);
  assert.equal(report.mergedAt, '2026-06-25T12:34:56Z');
  assert.deepEqual(report.reasons, ['merged']);
});

test('classifySnapshot preserves check details for notification formatting', () => {
  const report = classifySnapshot({
    prNumber: 42,
    prUrl: 'https://github.com/acme/repo/pull/42',
    state: 'OPEN',
    reviewDecision: 'REVIEW_REQUIRED',
    commentCount: 0,
    reviewCount: 0,
    checks: [
      { bucket: 'fail', workflow: 'ci', name: 'test', link: 'https://example.com/check/1' },
      { bucket: 'pass', workflow: 'lint', name: 'lint' },
    ],
  });

  assert.equal(report.checkResults.length, 2);
  const body = formatNotificationBody(report, '/tmp/pr-monitor-state.json');
  assert.match(body, /PR #42/);
  assert.match(body, /URL: https:\/\/github\.com\/acme\/repo\/pull\/42/);
  assert.match(body, /Reason: failing_checks/);
  assert.match(body, /Review decision: REVIEW_REQUIRED/);
  assert.match(body, /Check summary: bucket=fail total=2 failing=1 pending=0 canceled=0 skipped=0 passing=1/);
  assert.match(body, /State file: \/tmp\/pr-monitor-state\.json/);
  assert.match(body, /Failed check pointers:/);
  assert.match(body, /ci \| test \| https:\/\/example\.com\/check\/1/);
});

test('parseArgs accepts a notification target', () => {
  const args = parseArgs(['--pr', '42', '--notify-target', 'issue-orchestrator']);

  assert.equal(args.prRef, '42');
  assert.equal(args.notifyTarget, 'issue-orchestrator');
});

test('parseArgs rejects a missing notification target value', () => {
  assert.throws(() => parseArgs(['--notify-target']), /--notify-target requires a target value/);
});

test('parseArgs rejects an empty notification target', () => {
  assert.throws(() => parseArgs(['--pr', '42', '--notify-target', '   ']), /--notify-target must not be empty/);
});
