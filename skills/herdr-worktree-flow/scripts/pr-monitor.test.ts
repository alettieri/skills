import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySnapshot,
  formatNotificationBody,
  normalizeCheckResultsPayload,
  normalizeHerdrAgentTarget,
  normalizeNotifiedFingerprint,
  normalizePullRequestPayload,
  parseArgs,
  summarizeChecks,
} from './pr-monitor.ts';
import type { CheckResult } from './pr-monitor-domain.ts';

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
  const summary = summarizeChecks([{ bucket: 'unknown' }]);

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

test('classifySnapshot marks feedback-only reviews as actionable', () => {
  const report = classifySnapshot({
    prNumber: 42,
    prUrl: 'https://github.com/acme/repo/pull/42',
    state: 'OPEN',
    reviewDecision: 'REVIEW_REQUIRED',
    commentCount: 0,
    reviewCount: 1,
    checks: [{ bucket: 'pass' }],
  });

  assert.equal(report.terminal, false);
  assert.equal(report.feedbackPresent, true);
  assert.equal(report.actionRequired, true);
  assert.deepEqual(report.reasons, ['feedback_present']);
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
  const args = parseArgs(['--pr', '42', '--provider', 'github', '--notify-target', 'issue-orchestrator']);

  assert.equal(args.prRef, '42');
  assert.equal(args.provider, 'github');
  assert.equal(args.notifyTarget, 'issue-orchestrator');
});

test('parseArgs defaults provider to null for github resolution', () => {
  const args = parseArgs([]);

  assert.equal(args.provider, null);
});

test('parseArgs rejects a missing notification target value', () => {
  assert.throws(() => parseArgs(['--notify-target']), /--notify-target requires a target value/);
});

test('parseArgs rejects an empty notification target', () => {
  assert.throws(() => parseArgs(['--pr', '42', '--notify-target', '   ']), /--notify-target must not be empty/);
});

test('normalizePullRequestPayload rejects non-object gh pr view payloads', () => {
  assert.throws(() => normalizePullRequestPayload([]), /PR host returned malformed JSON/);
  assert.throws(() => normalizePullRequestPayload(null), /PR host returned malformed JSON/);
});

test('normalizePullRequestPayload defaults malformed comment and review lists to empty arrays', () => {
  const normalized = normalizePullRequestPayload({
    number: 42,
    url: 'https://github.com/acme/repo/pull/42',
    comments: 'not-an-array',
    reviews: { totalCount: 1 },
  });

  assert.equal(normalized.number, 42);
  assert.deepEqual(normalized.comments, []);
  assert.deepEqual(normalized.reviews, []);
});

test('normalizePullRequestPayload ignores malformed nested feedback timestamps', () => {
  const normalized = normalizePullRequestPayload({
    comments: [{ createdAt: '2026-06-25T12:00:00Z' }, { createdAt: 123 }, 'bad-comment'],
    reviews: [{ submittedAt: '2026-06-25T12:30:00Z' }, { submittedAt: false }, null],
  });

  assert.deepEqual(normalized.comments, [
    { createdAt: '2026-06-25T12:00:00Z' },
    { createdAt: undefined },
    {},
  ]);
  assert.deepEqual(normalized.reviews, [
    { submittedAt: '2026-06-25T12:30:00Z' },
    { submittedAt: undefined },
    {},
  ]);
});

test('normalizeCheckResultsPayload converts malformed check payloads to typed unknown checks', () => {
  const normalized = normalizeCheckResultsPayload([
    { bucket: 'fail', workflow: 'ci', name: 'test', link: 'https://example.com/check/1' },
    { bucket: 'mystery', name: 123 },
    'bad-check',
  ]);

  assert.deepEqual(normalized, [
    { bucket: 'fail', workflow: 'ci', name: 'test', link: 'https://example.com/check/1' },
    { bucket: 'unknown' },
    { bucket: 'unknown' },
  ] satisfies CheckResult[]);
});

test('normalizeCheckResultsPayload treats non-array gh checks payloads as no checks', () => {
  assert.deepEqual(normalizeCheckResultsPayload({ bucket: 'fail' }), []);
  assert.deepEqual(normalizeCheckResultsPayload(null), []);
});

test('normalizeHerdrAgentTarget accepts only concrete Codex agent targets', () => {
  assert.deepEqual(normalizeHerdrAgentTarget({ result: { agent: { agent: 'codex', pane_id: 'pane-1' } } }), {
    paneId: 'pane-1',
  });
  assert.equal(normalizeHerdrAgentTarget(null), null);
  assert.equal(normalizeHerdrAgentTarget([]), null);
  assert.equal(normalizeHerdrAgentTarget({}), null);
  assert.equal(normalizeHerdrAgentTarget({ result: {} }), null);
  assert.equal(normalizeHerdrAgentTarget({ result: { agent: {} } }), null);
  assert.equal(normalizeHerdrAgentTarget({ result: { agent: { pane_id: 'pane-1' } } }), null);
  assert.equal(normalizeHerdrAgentTarget({ result: { agent: { agent: 'codex', pane_id: 123 } } }), null);
});

test('normalizeNotifiedFingerprint only accepts explicit notified fingerprint markers', () => {
  assert.equal(normalizeNotifiedFingerprint({ notifiedFingerprint: 'abc' }), 'abc');
  assert.equal(normalizeNotifiedFingerprint({ fingerprint: 'abc' }), null);
  assert.equal(normalizeNotifiedFingerprint(null), null);
});
