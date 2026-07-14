import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { formatNotificationBody, normalizeHerdrAgentTarget, parseArgs } from './agent-run-blocked.ts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const blockedEntry = fileURLToPath(new URL('./agent-run-blocked.ts', import.meta.url));

type Fixture = {
  dir: string;
  fakeBin: string;
  logFile: string;
  resultPath: string;
};

type BlockedRunResult = SpawnSyncReturns<string>;

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'agent-run-blocked-'));
  const fakeBin = join(dir, 'bin');
  const logFile = join(dir, 'commands.jsonl');
  const resultPath = join(dir, '.agent', 'runs', 'web-3756-orchestrate-001', 'result.json');
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(dirname(resultPath), { recursive: true });

  writeExecutable(
    join(fakeBin, 'herdr'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.AGENT_RUN_BLOCKED_COMMAND_LOG, JSON.stringify({ cmd: 'herdr', args }) + '\\n');
if (args[0] === 'agent' && args[1] === 'get') {
  process.stdout.write(process.env.AGENT_RUN_BLOCKED_HERDR_GET_JSON || JSON.stringify({ result: { agent: { agent: 'claude', pane_id: 'pane-9' } } }));
  process.exit(0);
}
if (args[0] === 'agent' && args[1] === 'send') {
  const failCount = Number(process.env.AGENT_RUN_BLOCKED_SEND_FAIL_COUNT || '0');
  const countFile = process.env.AGENT_RUN_BLOCKED_COMMAND_LOG + '.send-count';
  const count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0;
  fs.writeFileSync(countFile, String(count + 1));
  if (count < failCount) {
    process.stderr.write('herdr send failed');
    process.exit(1);
  }
  process.exit(0);
}
if (args[0] === 'pane' && args[1] === 'send-keys') {
  process.exit(0);
}
process.stderr.write('unexpected herdr args');
process.exit(2);
`,
  );

  return { dir, fakeBin, logFile, resultPath };
}

function writeResult(path: string, overrides: Record<string, unknown> = {}): void {
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        runId: 'web-3756-orchestrate-001',
        role: 'issue-orchestrator',
        phase: 'pr-monitoring',
        status: 'blocked',
        summary: 'PR feedback requires human input on API design.',
        payload: { reason: 'ambiguous-feedback' },
        ...overrides,
      },
      null,
      2,
    )}\n`,
  );
}

function runBlocked(fixture: Fixture, extraArgs: string[] = [], env: Record<string, string> = {}): BlockedRunResult {
  return spawnSync(
    process.execPath,
    [
      blockedEntry,
      '--run-id',
      'web-3756-orchestrate-001',
      '--phase',
      'pr-monitoring',
      '--result',
      fixture.resultPath,
      '--notify-target',
      'main-orchestrator',
      ...extraArgs,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fixture.fakeBin}:${process.env.PATH}`,
        AGENT_RUN_BLOCKED_COMMAND_LOG: fixture.logFile,
        AGENT_RUN_BLOCKED_HERDR_RETURN_DELAY_MS: '0',
        ...env,
      },
    },
  );
}

function readCommands(logFile: string): Array<{ cmd: string; args: string[] }> {
  return readFileSync(logFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { cmd: string; args: string[] });
}

test('parseArgs has no --role flag and requires the remaining options', () => {
  const args = parseArgs(['--run-id', 'r1', '--phase', 'p', '--result', '/tmp/x.json', '--notify-target', 't']);
  assert.deepEqual(args, { runId: 'r1', phase: 'p', resultPath: '/tmp/x.json', notifyTarget: 't' });
  assert.throws(() => parseArgs(['--run-id', 'r1']), /missing required option/);
  assert.throws(() => parseArgs(['--role', 'issue-orchestrator']), /unknown option: --role/);
});

test('normalizeHerdrAgentTarget accepts only concrete Claude agent targets', () => {
  assert.deepEqual(normalizeHerdrAgentTarget({ result: { agent: { agent: 'claude', pane_id: 'pane-9' } } }), {
    paneId: 'pane-9',
  });
  assert.equal(normalizeHerdrAgentTarget({ result: { agent: { agent: 'codex', pane_id: 'pane-9' } } }), null);
  assert.equal(normalizeHerdrAgentTarget(null), null);
});

test('formatNotificationBody includes the recognizable AGENT_RUN_BLOCKED marker', () => {
  const body = formatNotificationBody(
    { runId: 'r1', phase: 'pr-monitoring', resultPath: '/tmp/result.json', notifyTarget: 't' },
    { schemaVersion: 1, runId: 'r1', role: 'issue-orchestrator', phase: 'pr-monitoring', status: 'blocked', summary: 'stuck', payload: {} },
    '/tmp/notification.json',
  );
  assert.match(body, /^AGENT_RUN_BLOCKED r1 \/tmp\/result\.json/);
  assert.match(body, /Summary: stuck/);
});

test('CLI validates the escalation artifact and sends a blocker notification', () => {
  const fixture = makeFixture();
  writeResult(fixture.resultPath);

  const result = runBlocked(fixture);

  assert.equal(result.status, 0);
  assert.match(result.stderr, /agent-run-blocked delivered/);

  const commands = readCommands(fixture.logFile);
  assert.deepEqual(commands[0].args, ['agent', 'get', 'main-orchestrator']);
  assert.deepEqual(commands[1].args.slice(0, 3), ['agent', 'send', 'main-orchestrator']);
  assert.match(
    commands[1].args[3],
    /^AGENT_RUN_BLOCKED web-3756-orchestrate-001 .*\/result\.json\nPhase: pr-monitoring\nStatus: blocked\nSummary: PR feedback requires human input on API design\.\nNotification marker: .*\/notification\.json$/,
  );
  assert.deepEqual(commands[2].args, ['pane', 'send-keys', 'pane-9', 'Return']);

  const marker = JSON.parse(readFileSync(join(dirname(fixture.resultPath), 'notification.json'), 'utf8'));
  assert.equal(marker.runId, 'web-3756-orchestrate-001');
  assert.equal(marker.target, 'main-orchestrator');
  assert.equal(marker.paneId, 'pane-9');
});

test('CLI accepts a failed status alongside blocked', () => {
  const fixture = makeFixture();
  writeResult(fixture.resultPath, { status: 'failed' });

  const result = runBlocked(fixture);

  assert.equal(result.status, 0);
});

test('CLI rejects a "complete" status because success reporting is out of scope for this channel', () => {
  const fixture = makeFixture();
  writeResult(fixture.resultPath, { status: 'complete' });

  const result = runBlocked(fixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /must not be "complete"/);
  assert.match(result.stderr, /out of scope/);
  assert.throws(() => readFileSync(fixture.logFile, 'utf8'), /ENOENT/);
});

test('CLI rejects any role other than issue-orchestrator', () => {
  const fixture = makeFixture();
  writeResult(fixture.resultPath, { role: 'implementer' });

  const result = runBlocked(fixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /role mismatch: expected issue-orchestrator/);
});

test('CLI rejects mismatched envelope fields, invalid statuses, and empty summaries', () => {
  for (const [name, overrides, expected] of [
    ['schema', { schemaVersion: 2 }, /schemaVersion must be 1/],
    ['run id', { runId: 'other' }, /runId mismatch/],
    ['phase', { phase: 'implementing' }, /phase mismatch/],
    ['status', { status: 'unknown' }, /status must be one of: blocked, failed/],
    ['summary', { summary: '' }, /summary must be a non-empty string/],
    ['payload', { payload: 'not-an-object' }, /payload must be an object/],
  ] as const) {
    const fixture = makeFixture();
    writeResult(fixture.resultPath, overrides);
    const result = runBlocked(fixture);
    assert.equal(result.status, 1, name);
    assert.match(result.stderr, expected);
  }
});

test('CLI rejects missing and malformed result artifacts before notifying', () => {
  const missing = makeFixture();
  const missingResult = runBlocked(missing);
  assert.equal(missingResult.status, 1);
  assert.match(missingResult.stderr, /result artifact does not exist/);

  const malformed = makeFixture();
  writeFileSync(malformed.resultPath, '{not json');
  const malformedResult = runBlocked(malformed);
  assert.equal(malformedResult.status, 1);
  assert.match(malformedResult.stderr, /result artifact is not valid JSON/);
});

test('CLI rejects notify targets that are not concrete Claude agents', () => {
  const fixture = makeFixture();
  writeResult(fixture.resultPath);

  const result = runBlocked(fixture, [], {
    AGENT_RUN_BLOCKED_HERDR_GET_JSON: JSON.stringify({ result: { agent: { pane_id: 'pane-9' } } }),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not resolve to a Claude agent/);
});

test('CLI retries Herdr notification delivery up to success before writing marker', () => {
  const fixture = makeFixture();
  writeResult(fixture.resultPath);

  const result = runBlocked(fixture, [], {
    AGENT_RUN_BLOCKED_SEND_FAIL_COUNT: '2',
  });

  assert.equal(result.status, 0);
  const commands = readCommands(fixture.logFile);
  const sends = commands.filter((command) => command.args[0] === 'agent' && command.args[1] === 'send');
  assert.equal(sends.length, 3);

  const marker = JSON.parse(readFileSync(join(dirname(fixture.resultPath), 'notification.json'), 'utf8'));
  assert.equal(marker.attempts, 3);
});

test('CLI exits non-zero after three failed notification attempts and writes no marker', () => {
  const fixture = makeFixture();
  writeResult(fixture.resultPath);

  const result = runBlocked(fixture, [], {
    AGENT_RUN_BLOCKED_SEND_FAIL_COUNT: '3',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /failed to deliver blocker notification after 3 attempts/);
  assert.throws(() => readFileSync(join(dirname(fixture.resultPath), 'notification.json'), 'utf8'), /ENOENT/);
});
