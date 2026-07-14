import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import {
  classifySnapshot,
  formatNotificationBody,
  normalizeCheckResultsPayload,
  normalizeHerdrAgentTarget,
  normalizeNotifiedFingerprint,
  normalizePullRequestPayload,
  parseArgs,
  shouldMarkReady,
  summarizeChecks,
} from './pr-monitor.ts';
import type { CheckResult } from './pr-monitor.ts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const monitorEntry = fileURLToPath(new URL('./pr-monitor.ts', import.meta.url));

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

test('classifySnapshot defaults isDraft to false and preserves it when set', () => {
  const withoutDraft = classifySnapshot({ checks: [], commentCount: 0, reviewCount: 0 });
  assert.equal(withoutDraft.isDraft, false);

  const draft = classifySnapshot({ isDraft: true, checks: [], commentCount: 0, reviewCount: 0 });
  assert.equal(draft.isDraft, true);
});

test('shouldMarkReady is true only for a non-terminal draft PR with nothing actionable', () => {
  const cleanDraft = classifySnapshot({
    isDraft: true,
    reviewDecision: 'REVIEW_REQUIRED',
    commentCount: 0,
    reviewCount: 0,
    checks: [{ bucket: 'pass' }],
  });
  assert.equal(shouldMarkReady(cleanDraft), true);

  const actionableDraft = classifySnapshot({
    isDraft: true,
    reviewDecision: 'CHANGES_REQUESTED',
    commentCount: 1,
    reviewCount: 0,
    checks: [{ bucket: 'pass' }],
  });
  assert.equal(shouldMarkReady(actionableDraft), false);

  const nonDraft = classifySnapshot({
    isDraft: false,
    reviewDecision: 'REVIEW_REQUIRED',
    commentCount: 0,
    reviewCount: 0,
    checks: [{ bucket: 'pass' }],
  });
  assert.equal(shouldMarkReady(nonDraft), false);

  const mergedDraft = classifySnapshot({
    isDraft: true,
    mergedAt: '2026-06-25T12:34:56Z',
    reviewDecision: 'APPROVED',
    commentCount: 0,
    reviewCount: 0,
    checks: [{ bucket: 'pass' }],
  });
  assert.equal(shouldMarkReady(mergedDraft), false);
});

test('parseArgs accepts a notification target', () => {
  const args = parseArgs(['--pr', '42', '--notify-target', 'issue-orchestrator']);

  assert.equal(args.prRef, '42');
  assert.equal(args.notifyTarget, 'issue-orchestrator');
});

test('parseArgs rejects a missing or empty notification target', () => {
  assert.throws(() => parseArgs(['--notify-target']), /--notify-target requires a target value/);
  assert.throws(() => parseArgs(['--pr', '42', '--notify-target', '   ']), /--notify-target must not be empty/);
});

test('normalizePullRequestPayload rejects non-object gh pr view payloads', () => {
  assert.throws(() => normalizePullRequestPayload([]), /gh pr view returned malformed JSON/);
  assert.throws(() => normalizePullRequestPayload(null), /gh pr view returned malformed JSON/);
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

test('normalizePullRequestPayload reads isDraft only when it is a boolean', () => {
  assert.equal(normalizePullRequestPayload({ isDraft: true }).isDraft, true);
  assert.equal(normalizePullRequestPayload({ isDraft: 'true' }).isDraft, undefined);
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

test('normalizeHerdrAgentTarget accepts only concrete Claude agent targets', () => {
  assert.deepEqual(normalizeHerdrAgentTarget({ result: { agent: { agent: 'claude', pane_id: 'pane-1' } } }), {
    paneId: 'pane-1',
  });
  assert.equal(normalizeHerdrAgentTarget(null), null);
  assert.equal(normalizeHerdrAgentTarget({}), null);
  assert.equal(normalizeHerdrAgentTarget({ result: { agent: { agent: 'codex', pane_id: 'pane-1' } } }), null);
  assert.equal(normalizeHerdrAgentTarget({ result: { agent: { pane_id: 'pane-1' } } }), null);
});

test('normalizeNotifiedFingerprint only accepts explicit notified fingerprint markers', () => {
  assert.equal(normalizeNotifiedFingerprint({ notifiedFingerprint: 'abc' }), 'abc');
  assert.equal(normalizeNotifiedFingerprint({ fingerprint: 'abc' }), null);
  assert.equal(normalizeNotifiedFingerprint(null), null);
});

test('formatNotificationBody points at the failed checks and PR', () => {
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

  const body = formatNotificationBody(report, '/tmp/pr-monitor-state.json');
  assert.match(body, /PR #42/);
  assert.match(body, /Reason: failing_checks/);
  assert.match(body, /Check summary: bucket=fail total=2 failing=1 pending=0 canceled=0 skipped=0 passing=1/);
  assert.match(body, /Failed check pointers:/);
  assert.match(body, /ci \| test \| https:\/\/example\.com\/check\/1/);
});

// --- CLI integration against fake gh/herdr binaries (no live herdr instance) ---

type Fixture = { dir: string; fakeBin: string; logFile: string };
type MonitorRunOptions = { env?: Record<string, string>; fakeBin?: string; timeoutMs?: number };
type MonitorRunResult = SpawnSyncReturns<string> & { error?: Error & { code?: string } };

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'pr-monitor-'));
  const fakeBin = join(dir, 'bin');
  const logFile = join(dir, 'commands.jsonl');
  mkdirSync(fakeBin, { recursive: true });

  writeExecutable(
    join(fakeBin, 'gh'),
    `#!/usr/bin/env node
const fs = require('node:fs');
let args = process.argv.slice(2);
fs.appendFileSync(process.env.PR_MONITOR_COMMAND_LOG, JSON.stringify({ cmd: 'gh', args }) + '\\n');
if (args[0] === '-R') {
  args = args.slice(2);
}
const scenarioFile = process.env.PR_MONITOR_COMMAND_LOG + '.scenario';
const draftFile = process.env.PR_MONITOR_COMMAND_LOG + '.draft';
function isDraft() {
  return fs.existsSync(draftFile) ? fs.readFileSync(draftFile, 'utf8') === 'true' : process.env.PR_MONITOR_DRAFT === '1';
}
if (args[0] === 'pr' && args[1] === 'view') {
  const scenario = process.env.PR_MONITOR_SCENARIO || 'pass';
  const merged = scenario === 'merged';
  process.stdout.write(JSON.stringify({
    number: 42,
    url: 'https://github.com/acme/repo/pull/42',
    state: merged ? 'MERGED' : 'OPEN',
    isDraft: isDraft(),
    mergedAt: merged ? '2026-06-25T12:34:56Z' : null,
    closedAt: null,
    title: 'Fixture PR',
    reviewDecision: scenario === 'changes' ? 'CHANGES_REQUESTED' : 'REVIEW_REQUIRED',
    comments: scenario === 'changes' ? [{ createdAt: '2026-06-25T12:00:00Z' }] : [],
    reviews: []
  }));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'checks') {
  process.stdout.write(JSON.stringify([{ bucket: 'pass', workflow: 'ci', name: 'test' }]));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'ready') {
  fs.writeFileSync(draftFile, 'false');
  process.exit(0);
}
process.stderr.write('unexpected gh args');
process.exit(2);
`,
  );

  writeExecutable(
    join(fakeBin, 'herdr'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PR_MONITOR_COMMAND_LOG, JSON.stringify({ cmd: 'herdr', args }) + '\\n');
if (args[0] === 'agent' && args[1] === 'get') {
  process.stdout.write(process.env.PR_MONITOR_HERDR_GET_JSON || JSON.stringify({ result: { agent: { agent: 'claude', pane_id: 'pane-1' } } }));
  process.exit(0);
}
if (args[0] === 'agent' && args[1] === 'send') {
  const failCount = Number(process.env.PR_MONITOR_HERDR_SEND_FAIL_COUNT || '0');
  const countFile = process.env.PR_MONITOR_COMMAND_LOG + '.send-count';
  const count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0;
  fs.writeFileSync(countFile, String(count + 1));
  if (count < failCount) {
    process.stderr.write('herdr send failed');
    process.exit(1);
  }
  process.exit(0);
}
process.exit(0);
`,
  );

  return { dir, fakeBin, logFile };
}

function runMonitor(args: string[], options: MonitorRunOptions = {}): MonitorRunResult {
  return spawnSync(process.execPath, [monitorEntry, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: options.timeoutMs,
    killSignal: 'SIGTERM',
    env: {
      ...process.env,
      PATH: options.fakeBin ? `${options.fakeBin}:${process.env.PATH}` : process.env.PATH,
      ...options.env,
    },
  }) as MonitorRunResult;
}

function readCommands(logFile: string): Array<{ cmd: string; args: string[] }> {
  return readFileSync(logFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { cmd: string; args: string[] });
}

test('CLI --help exits successfully and prints usage', () => {
  const result = runMonitor(['--help']);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: pr-monitor\.ts \[options\]/);
  assert.equal(result.stderr, '');
});

test('CLI --once --json takes one snapshot and exits', () => {
  const fixture = makeFixture();
  const result = runMonitor(['--once', '--json', '--pr', '42'], {
    fakeBin: fixture.fakeBin,
    env: { PR_MONITOR_COMMAND_LOG: fixture.logFile },
  });

  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.prNumber, 42);
  assert.equal(report.isDraft, false);
});

test('CLI marks a clean draft PR ready without being told to', () => {
  const fixture = makeFixture();
  const result = runMonitor(['--once', '--json', '--pr', '42'], {
    fakeBin: fixture.fakeBin,
    env: { PR_MONITOR_COMMAND_LOG: fixture.logFile, PR_MONITOR_DRAFT: '1' },
  });

  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.isDraft, true, 'the snapshot itself still reflects the state at fetch time');
  assert.match(result.stderr, /pr-monitor decision mark-ready pr=42/);
  assert.match(result.stderr, /pr-monitor decision marked-ready/);

  const commands = readCommands(fixture.logFile).filter((command) => command.cmd === 'gh');
  assert.ok(commands.some((command) => command.args.slice(-2).join(' ') === 'pr ready' || command.args.includes('ready')));
});

test('CLI does not mark a draft PR ready while changes are requested', () => {
  const fixture = makeFixture();
  const result = runMonitor(['--once', '--json', '--pr', '42'], {
    fakeBin: fixture.fakeBin,
    env: { PR_MONITOR_COMMAND_LOG: fixture.logFile, PR_MONITOR_DRAFT: '1', PR_MONITOR_SCENARIO: 'changes' },
  });

  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stderr, /mark-ready/);
  const commands = readCommands(fixture.logFile).filter((command) => command.cmd === 'gh');
  assert.ok(!commands.some((command) => command.args.includes('ready')));
});

test('CLI notification mode sends once for an actionable snapshot and presses Return', () => {
  const fixture = makeFixture();
  const stateFile = join(fixture.dir, 'state', 'pr-monitor.json');
  const result = runMonitor(['--pr', '42', '--state-file', stateFile, '--notify-target', 'issue-orchestrator'], {
    fakeBin: fixture.fakeBin,
    timeoutMs: 5000,
    env: {
      PR_MONITOR_COMMAND_LOG: fixture.logFile,
      PR_MONITOR_SCENARIO: 'changes',
      PR_MONITOR_HERDR_RETURN_DELAY_MS: '0',
    },
  });

  assert.equal(result.status, null);
  assert.equal(result.error?.code, 'ETIMEDOUT');
  assert.match(result.stderr, /pr-monitor decision notify-ready target=issue-orchestrator/);

  const herdrCommands = readCommands(fixture.logFile).filter((command) => command.cmd === 'herdr');
  assert.equal(herdrCommands.length, 3);
  assert.deepEqual(herdrCommands[0].args, ['agent', 'get', 'issue-orchestrator']);
  assert.deepEqual(herdrCommands[1].args.slice(0, 3), ['agent', 'send', 'issue-orchestrator']);
  assert.deepEqual(herdrCommands[2].args, ['pane', 'send-keys', 'pane-1', 'Return']);

  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(state.notifiedFingerprint, state.fingerprint);
});

test('CLI notification mode retries herdr send failures before succeeding', () => {
  const fixture = makeFixture();
  const stateFile = join(fixture.dir, 'state', 'pr-monitor.json');
  const result = runMonitor(['--pr', '42', '--state-file', stateFile, '--notify-target', 'issue-orchestrator'], {
    fakeBin: fixture.fakeBin,
    timeoutMs: 5000,
    env: {
      PR_MONITOR_COMMAND_LOG: fixture.logFile,
      PR_MONITOR_SCENARIO: 'changes',
      PR_MONITOR_HERDR_RETURN_DELAY_MS: '0',
      PR_MONITOR_HERDR_SEND_FAIL_COUNT: '2',
    },
  });

  assert.equal(result.error?.code, 'ETIMEDOUT');
  const sends = readCommands(fixture.logFile).filter((command) => command.cmd === 'herdr' && command.args[0] === 'agent' && command.args[1] === 'send');
  assert.equal(sends.length, 3);
  assert.match(result.stderr, /sent-return pane=pane-1 attempts=3/);
});

test('CLI notification mode exits non-zero after exhausting herdr send retries', () => {
  const fixture = makeFixture();
  const result = runMonitor(['--pr', '42', '--notify-target', 'issue-orchestrator'], {
    fakeBin: fixture.fakeBin,
    env: {
      PR_MONITOR_COMMAND_LOG: fixture.logFile,
      PR_MONITOR_SCENARIO: 'changes',
      PR_MONITOR_HERDR_RETURN_DELAY_MS: '0',
      PR_MONITOR_HERDR_SEND_FAIL_COUNT: '3',
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /failed to deliver PR notification after 3 attempts/);
  const sends = readCommands(fixture.logFile).filter((command) => command.cmd === 'herdr' && command.args[0] === 'agent' && command.args[1] === 'send');
  assert.equal(sends.length, 3);
});

test('CLI notify mode does not resend a duplicate actionable snapshot', () => {
  const fixture = makeFixture();
  const stateFile = join(fixture.dir, 'state', 'pr-monitor.json');

  const seed = runMonitor(['--pr', '42', '--state-file', stateFile, '--notify-target', 'issue-orchestrator'], {
    fakeBin: fixture.fakeBin,
    timeoutMs: 5000,
    env: { PR_MONITOR_COMMAND_LOG: fixture.logFile, PR_MONITOR_SCENARIO: 'changes', PR_MONITOR_HERDR_RETURN_DELAY_MS: '0' },
  });
  assert.equal(seed.error?.code, 'ETIMEDOUT');
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).notifiedFingerprint, JSON.parse(readFileSync(stateFile, 'utf8')).fingerprint);

  writeFileSync(fixture.logFile, '');

  const result = runMonitor(['--interval', '0.05', '--pr', '42', '--state-file', stateFile, '--notify-target', 'issue-orchestrator'], {
    fakeBin: fixture.fakeBin,
    timeoutMs: 2000,
    env: { PR_MONITOR_COMMAND_LOG: fixture.logFile, PR_MONITOR_SCENARIO: 'changes', PR_MONITOR_HERDR_RETURN_DELAY_MS: '0' },
  });

  assert.equal(result.error?.code, 'ETIMEDOUT');
  assert.match(result.stderr, /duplicate-actionable continue/);
  const commands = readCommands(fixture.logFile).filter((command) => command.cmd === 'herdr');
  assert.equal(commands.length, 0);
});

test('CLI notification mode exits after notifying for a terminal merged snapshot', () => {
  const fixture = makeFixture();
  const stateFile = join(fixture.dir, 'state', 'pr-monitor.json');
  const result = runMonitor(['--pr', '42', '--state-file', stateFile, '--notify-target', 'issue-orchestrator'], {
    fakeBin: fixture.fakeBin,
    env: { PR_MONITOR_COMMAND_LOG: fixture.logFile, PR_MONITOR_SCENARIO: 'merged' },
  });

  assert.equal(result.status, 0);
  assert.match(result.stderr, /pr-monitor decision exit-terminal/);

  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(state.terminal, true);
  assert.deepEqual(state.reasons, ['merged']);
});

for (const [name, payload] of [
  ['null', 'null'],
  ['missing pane id', '{"result":{"agent":{}}}'],
  ['codex agent', '{"result":{"agent":{"agent":"codex","pane_id":"pane-1"}}}'],
] as const) {
  test(`CLI notification mode rejects malformed herdr agent get JSON: ${name}`, () => {
    const fixture = makeFixture();
    const result = runMonitor(['--pr', '42', '--notify-target', 'issue-orchestrator'], {
      fakeBin: fixture.fakeBin,
      env: { PR_MONITOR_COMMAND_LOG: fixture.logFile, PR_MONITOR_SCENARIO: 'changes', PR_MONITOR_HERDR_GET_JSON: payload },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not resolve to a Claude agent/);
  });
}
