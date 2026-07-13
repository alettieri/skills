import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { formatNotificationBody, normalizeHerdrAgentTarget, parseArgs, parseResultArtifact } from './agent-run-complete.ts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const completeEntry = fileURLToPath(new URL('./agent-run-complete.ts', import.meta.url));

type Fixture = {
  dir: string;
  fakeBin: string;
  logFile: string;
  resultPath: string;
};

type CompleteRunResult = SpawnSyncReturns<string>;

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'agent-run-complete-'));
  const fakeBin = join(dir, 'bin');
  const logFile = join(dir, 'commands.jsonl');
  const resultPath = join(dir, '.agent', 'runs', 'web-3756-implement-001', 'result.json');
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(dirname(resultPath), { recursive: true });

  writeExecutable(
    join(fakeBin, 'herdr'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.AGENT_RUN_COMPLETE_COMMAND_LOG, JSON.stringify({ cmd: 'herdr', args }) + '\\n');
if (args[0] === 'agent' && args[1] === 'get') {
  process.stdout.write(process.env.AGENT_RUN_COMPLETE_HERDR_GET_JSON || JSON.stringify({ result: { agent: { agent: 'claude', pane_id: 'pane-1' } } }));
  process.exit(0);
}
if (args[0] === 'agent' && args[1] === 'send') {
  const failCount = Number(process.env.AGENT_RUN_COMPLETE_SEND_FAIL_COUNT || '0');
  const countFile = process.env.AGENT_RUN_COMPLETE_COMMAND_LOG + '.send-count';
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
        runId: 'web-3756-implement-001',
        role: 'implementer',
        phase: 'implementing',
        status: 'complete',
        summary: 'Implemented the ticket.',
        payload: { changedFiles: [], checksRun: [], blockers: [] },
        ...overrides,
      },
      null,
      2,
    )}\n`,
  );
}

function runComplete(fixture: Fixture, extraArgs: string[] = [], env: Record<string, string> = {}): CompleteRunResult {
  return spawnSync(
    process.execPath,
    [
      completeEntry,
      '--run-id',
      'web-3756-implement-001',
      '--role',
      'implementer',
      '--phase',
      'implementing',
      '--result',
      fixture.resultPath,
      '--notify-target',
      'web-3756-orchestrator',
      ...extraArgs,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fixture.fakeBin}:${process.env.PATH}`,
        AGENT_RUN_COMPLETE_COMMAND_LOG: fixture.logFile,
        AGENT_RUN_COMPLETE_HERDR_RETURN_DELAY_MS: '0',
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

test('parseArgs accepts implementer and reviewer roles and rejects anything else', () => {
  const args = parseArgs(['--run-id', 'r1', '--role', 'reviewer', '--phase', 'reviewing', '--result', '/tmp/x.json', '--notify-target', 't']);
  assert.equal(args.role, 'reviewer');
  assert.throws(
    () => parseArgs(['--run-id', 'r1', '--role', 'orchestrator', '--phase', 'p', '--result', '/tmp/x.json', '--notify-target', 't']),
    /--role must be one of: implementer, reviewer/,
  );
});

test('parseArgs requires every option to be present and non-empty', () => {
  assert.throws(() => parseArgs(['--run-id', 'r1']), /missing required option/);
  assert.throws(() => parseArgs(['--run-id', '  ']), /--run-id must not be empty/);
});

test('parseResultArtifact defaults a missing payload to an empty object', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-run-complete-schema-'));
  const resultPath = join(dir, 'result.json');
  const args = { runId: 'r1', role: 'implementer' as const, phase: 'implementing', resultPath, notifyTarget: 't' };

  writeFileSync(
    resultPath,
    JSON.stringify({
      schemaVersion: 1,
      runId: 'r1',
      role: 'implementer',
      phase: 'implementing',
      status: 'complete',
      summary: 'done',
    }),
  );
  const artifact = parseResultArtifact(args);
  assert.deepEqual(artifact.payload, {});
});

test('normalizeHerdrAgentTarget accepts only concrete Claude agent targets', () => {
  assert.deepEqual(normalizeHerdrAgentTarget({ result: { agent: { agent: 'claude', pane_id: 'pane-1' } } }), {
    paneId: 'pane-1',
  });
  assert.equal(normalizeHerdrAgentTarget(null), null);
  assert.equal(normalizeHerdrAgentTarget({}), null);
  assert.equal(normalizeHerdrAgentTarget({ result: { agent: { agent: 'codex', pane_id: 'pane-1' } } }), null);
  assert.equal(normalizeHerdrAgentTarget({ result: { agent: { agent: 'claude', pane_id: 123 } } }), null);
});

test('formatNotificationBody includes the recognizable AGENT_RUN_COMPLETE marker and summary', () => {
  const body = formatNotificationBody(
    { runId: 'r1', role: 'implementer', phase: 'implementing', resultPath: '/tmp/result.json', notifyTarget: 't' },
    { schemaVersion: 1, runId: 'r1', role: 'implementer', phase: 'implementing', status: 'complete', summary: 'done', payload: {} },
    '/tmp/notification.json',
  );
  assert.match(body, /^AGENT_RUN_COMPLETE r1 \/tmp\/result\.json/);
  assert.match(body, /Summary: done/);
});

test('CLI validates the result artifact and sends a completion notification', () => {
  const fixture = makeFixture();
  writeResult(fixture.resultPath);

  const result = runComplete(fixture);

  assert.equal(result.status, 0);
  assert.match(result.stderr, /agent-run-complete delivered/);

  const commands = readCommands(fixture.logFile);
  assert.deepEqual(commands[0].args, ['agent', 'get', 'web-3756-orchestrator']);
  assert.deepEqual(commands[1].args.slice(0, 3), ['agent', 'send', 'web-3756-orchestrator']);
  assert.match(
    commands[1].args[3],
    /^AGENT_RUN_COMPLETE web-3756-implement-001 .*\/result\.json\nRole: implementer\nPhase: implementing\nStatus: complete\nSummary: Implemented the ticket\.\nNotification marker: .*\/notification\.json$/,
  );
  assert.deepEqual(commands[2].args, ['pane', 'send-keys', 'pane-1', 'Return']);

  const marker = JSON.parse(readFileSync(join(dirname(fixture.resultPath), 'notification.json'), 'utf8'));
  assert.equal(marker.schemaVersion, 1);
  assert.equal(marker.runId, 'web-3756-implement-001');
  assert.equal(marker.target, 'web-3756-orchestrator');
  assert.equal(marker.paneId, 'pane-1');
  assert.equal(marker.attempts, 1);
  assert.match(marker.deliveredAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('CLI rejects missing and malformed result artifacts before notifying', () => {
  const missing = makeFixture();
  const missingResult = runComplete(missing);
  assert.equal(missingResult.status, 1);
  assert.match(missingResult.stderr, /result artifact does not exist/);

  const malformed = makeFixture();
  writeFileSync(malformed.resultPath, '{not json');
  const malformedResult = runComplete(malformed);
  assert.equal(malformedResult.status, 1);
  assert.match(malformedResult.stderr, /result artifact is not valid JSON/);
});

test('CLI rejects mismatched artifact envelope fields, invalid statuses, and empty summaries', () => {
  for (const [name, overrides, expected] of [
    ['schema', { schemaVersion: 2 }, /schemaVersion must be 1/],
    ['run id', { runId: 'other' }, /runId mismatch/],
    ['role', { role: 'reviewer' }, /role mismatch/],
    ['phase', { phase: 'reviewing' }, /phase mismatch/],
    ['status', { status: 'completed' }, /status must be one of: complete, blocked, failed/],
    ['summary', { summary: '' }, /summary must be a non-empty string/],
    ['payload', { payload: 'not-an-object' }, /payload must be an object/],
  ] as const) {
    const fixture = makeFixture();
    writeResult(fixture.resultPath, overrides);
    const result = runComplete(fixture);
    assert.equal(result.status, 1, name);
    assert.match(result.stderr, expected);
  }
});

test('CLI rejects notify targets that are not concrete Claude agents', () => {
  const fixture = makeFixture();
  writeResult(fixture.resultPath);

  const result = runComplete(fixture, [], {
    AGENT_RUN_COMPLETE_HERDR_GET_JSON: JSON.stringify({ result: { agent: { pane_id: 'pane-1' } } }),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not resolve to a Claude agent/);
  const commands = readCommands(fixture.logFile);
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].args, ['agent', 'get', 'web-3756-orchestrator']);
});

test('CLI retries Herdr notification delivery up to success before writing marker', () => {
  const fixture = makeFixture();
  writeResult(fixture.resultPath);

  const result = runComplete(fixture, [], {
    AGENT_RUN_COMPLETE_SEND_FAIL_COUNT: '2',
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

  const result = runComplete(fixture, [], {
    AGENT_RUN_COMPLETE_SEND_FAIL_COUNT: '3',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /failed to deliver completion notification after 3 attempts/);
  const commands = readCommands(fixture.logFile);
  const sends = commands.filter((command) => command.args[0] === 'agent' && command.args[1] === 'send');
  assert.equal(sends.length, 3);
  assert.throws(() => readFileSync(join(dirname(fixture.resultPath), 'notification.json'), 'utf8'), /ENOENT/);
});
