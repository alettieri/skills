import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySnapshot, summarizeChecks } from './pr-monitor.mjs';

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
