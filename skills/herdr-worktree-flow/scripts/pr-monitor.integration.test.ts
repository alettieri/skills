import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const monitorEntry = fileURLToPath(new URL('./pr-monitor.ts', import.meta.url));

type MonitorRunOptions = {
  env?: Record<string, string>;
  fakeBin?: string;
  timeoutMs?: number;
};

function makeFixture(): { dir: string; fakeBin: string; logFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pr-monitor-integration-'));
  const fakeBin = join(dir, 'bin');
  const logFile = join(dir, 'commands.jsonl');

  writeFileSync(join(dir, 'mkdir-placeholder'), '');
  mkdir(fakeBin);

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
const countFile = process.env.PR_MONITOR_COMMAND_LOG + '.count';
function scenarioForView() {
  if (!process.env.PR_MONITOR_SCENARIO_SEQUENCE) {
    return process.env.PR_MONITOR_SCENARIO || 'pass';
  }
  const scenarios = process.env.PR_MONITOR_SCENARIO_SEQUENCE.split(',').map((value) => value.trim()).filter(Boolean);
  const count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0;
  const scenario = scenarios[Math.min(count, scenarios.length - 1)] || 'pass';
  fs.writeFileSync(countFile, String(count + 1));
  fs.writeFileSync(scenarioFile, scenario);
  return scenario;
}
function scenarioForChecks() {
  if (fs.existsSync(scenarioFile)) {
    return fs.readFileSync(scenarioFile, 'utf8');
  }
  return process.env.PR_MONITOR_SCENARIO || 'pass';
}
if (args[0] === 'pr' && args[1] === 'view') {
  const scenario = scenarioForView();
  const merged = scenario === 'merged';
  const closed = scenario === 'closed';
  process.stdout.write(JSON.stringify({
    number: 42,
    url: 'https://github.com/acme/repo/pull/42',
    state: merged ? 'MERGED' : closed ? 'CLOSED' : 'OPEN',
    mergedAt: merged ? '2026-06-25T12:34:56Z' : null,
    closedAt: closed ? '2026-06-25T13:34:56Z' : null,
    title: merged ? 'Merged fixture' : closed ? 'Closed fixture' : 'Open fixture',
    reviewDecision: scenario === 'changes' ? 'CHANGES_REQUESTED' : 'REVIEW_REQUIRED',
    comments: [{ createdAt: '2026-06-25T12:00:00Z' }],
    reviews: [{ submittedAt: '2026-06-25T12:30:00Z' }]
  }));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'checks') {
  const scenario = scenarioForChecks();
  if (scenario === 'no-checks') {
    process.stderr.write('no checks reported on the issue-4-pr-monitor-typescript branch');
    process.exit(1);
  }
  const bucket = scenario === 'fail' ? 'fail' : 'pass';
  process.stdout.write(JSON.stringify([{ bucket, workflow: 'ci', name: 'test', link: 'https://example.com/check/1' }]));
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
if (args[0] === 'agent' && args[1] === 'send' && process.env.PR_MONITOR_HERDR_SEND_FAIL === '1') {
  process.stderr.write('herdr send failed');
  process.exit(1);
}
if (args[0] === 'agent' && args[1] === 'get') {
  process.stdout.write(process.env.PR_MONITOR_HERDR_GET_JSON || JSON.stringify({ result: { agent: { agent: 'codex', pane_id: 'pane-1' } } }));
  process.exit(0);
}
process.exit(0);
`,
  );

  return { dir, fakeBin, logFile };
}

function mkdir(path: string): void {
  spawnSync(process.execPath, ['-e', `require('node:fs').mkdirSync(${JSON.stringify(path)}, { recursive: true })`]);
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function runMonitor(args: string[], options: MonitorRunOptions = {}) {
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
  });
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
  assert.match(result.stdout, /--notify-target <target>/);
  assert.equal(result.stderr, '');
});

test('CLI --once --json uses --pr and --repo in gh calls and emits one JSON report', () => {
  const fixture = makeFixture();
  const result = runMonitor(['--once', '--json', '--pr', '42', '--repo', 'acme/repo'], {
    fakeBin: fixture.fakeBin,
    env: { PR_MONITOR_COMMAND_LOG: fixture.logFile },
  });

  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.prNumber, 42);
  assert.equal(report.checks.bucket, 'pass');

  const commands = readCommands(fixture.logFile);
  assert.deepEqual(commands[0].args.slice(0, 5), ['-R', 'acme/repo', 'pr', 'view', '42']);
  assert.deepEqual(commands[1].args.slice(0, 5), ['-R', 'acme/repo', 'pr', 'checks', '42']);
});

test('CLI --once --text emits human-readable report', () => {
  const fixture = makeFixture();
  const result = runMonitor(['--once', '--text', '--pr', '42'], {
    fakeBin: fixture.fakeBin,
    env: { PR_MONITOR_COMMAND_LOG: fixture.logFile },
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /PR#42 OPEN title="Open fixture"/);
  assert.match(result.stdout, /review=REVIEW_REQUIRED checks=pass/);
  assert.match(result.stdout, /action-required reasons=feedback_present/);
});

test('CLI writes state files and quiet suppresses unchanged snapshots', () => {
  const fixture = makeFixture();
  const stateFile = join(fixture.dir, 'state', 'pr-monitor.json');
  const env = { PR_MONITOR_COMMAND_LOG: fixture.logFile };

  const first = runMonitor(['--once', '--json', '--state-file', stateFile, '--pr', '42'], {
    fakeBin: fixture.fakeBin,
    env,
  });
  assert.equal(first.status, 0);
  assert.match(first.stdout, /"prNumber":42/);

  const second = runMonitor(['--once', '--quiet', '--state-file', stateFile, '--pr', '42'], {
    fakeBin: fixture.fakeBin,
    env,
  });
  assert.equal(second.status, 0);
  assert.equal(second.stdout, '');

  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(state.prNumber, 42);
  assert.equal(state.checks.bucket, 'pass');
});

test('CLI treats gh no-checks-reported failures as an empty check list', () => {
  const fixture = makeFixture();
  const stateFile = join(fixture.dir, 'state', 'pr-monitor.json');
  const result = runMonitor(['--once', '--json', '--state-file', stateFile, '--pr', '5'], {
    fakeBin: fixture.fakeBin,
    env: {
      PR_MONITOR_COMMAND_LOG: fixture.logFile,
      PR_MONITOR_SCENARIO: 'no-checks',
    },
  });

  assert.equal(result.status, 0);
  assert.match(result.stderr, /pr-monitor start/);
  assert.match(result.stderr, /pr-monitor poll/);
  assert.match(result.stderr, /pr-monitor gh checks normalized empty:/);
  assert.match(result.stderr, /pr-monitor decision write-state-and-evaluate/);
  assert.match(result.stderr, /pr-monitor decision exit-once/);
  const report = JSON.parse(result.stdout);
  assert.equal(report.checks.bucket, 'unknown');
  assert.equal(report.checks.total, 0);
  assert.deepEqual(report.checkResults, []);

  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(state.checks.total, 0);
  assert.deepEqual(state.checkResults, []);
});

test('CLI emits stderr diagnostics when gh no-checks is normalized', () => {
  const fixture = makeFixture();
  const result = runMonitor(['--once', '--json', '--pr', '5'], {
    fakeBin: fixture.fakeBin,
    env: {
      PR_MONITOR_COMMAND_LOG: fixture.logFile,
      PR_MONITOR_SCENARIO: 'no-checks',
    },
  });

  assert.equal(result.status, 0);
  assert.match(result.stderr, /pr-monitor start/);
  assert.match(result.stderr, /pr-monitor poll/);
  assert.match(result.stderr, /pr-monitor gh checks normalized empty:/);
  assert.match(result.stderr, /pr-monitor decision write-state-and-evaluate/);
  assert.match(result.stderr, /pr-monitor decision exit-once/);
});

test('CLI notification mode sends for feedback-only reviews with passing checks', () => {
  const fixture = makeFixture();
  const stateFile = join(fixture.dir, 'state', 'pr-monitor.json');
  const result = runMonitor(['--pr', '42', '--state-file', stateFile, '--notify-target', 'issue-orchestrator'], {
    fakeBin: fixture.fakeBin,
    timeoutMs: 1500,
    env: {
      PR_MONITOR_COMMAND_LOG: fixture.logFile,
      PR_MONITOR_SCENARIO: 'pass',
    },
  });

  assert.equal(result.status, null);
  assert.equal(result.error?.code, 'ETIMEDOUT');
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /pr-monitor start/);
  assert.match(result.stderr, /pr-monitor poll/);
  assert.match(result.stderr, /reasons=feedback_present/);
  assert.match(result.stderr, /actionRequired=true/);
  assert.match(result.stderr, /pr-monitor decision notify-ready target=issue-orchestrator/);
  assert.match(result.stderr, /pr-monitor decision notify target=issue-orchestrator/);
  assert.match(result.stderr, /pr-monitor decision sent-return pane=pane-1/);

  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(state.actionRequired, true);
  assert.deepEqual(state.reasons, ['feedback_present']);
  assert.equal(state.notifiedFingerprint, state.fingerprint);

  const herdrCommands = readCommands(fixture.logFile).filter((command) => command.cmd === 'herdr');
  assert.equal(herdrCommands.length, 3);
  assert.deepEqual(herdrCommands[0].args, ['agent', 'get', 'issue-orchestrator']);
  assert.deepEqual(herdrCommands[1].args.slice(0, 3), ['agent', 'send', 'issue-orchestrator']);
  assert.deepEqual(herdrCommands[2].args, ['pane', 'send-keys', 'pane-1', 'Return']);
});

test('CLI notify mode does not resend a duplicate actionable snapshot from the loaded state file', () => {
  const fixture = makeFixture();
  const stateFile = join(fixture.dir, 'state', 'pr-monitor.json');

  const seed = runMonitor(['--pr', '42', '--state-file', stateFile, '--notify-target', 'issue-orchestrator'], {
    fakeBin: fixture.fakeBin,
    timeoutMs: 1500,
    env: {
      PR_MONITOR_COMMAND_LOG: fixture.logFile,
      PR_MONITOR_SCENARIO: 'pass',
    },
  });

  assert.equal(seed.status, null);
  assert.equal(seed.error?.code, 'ETIMEDOUT');
  const seededState = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(seededState.notifiedFingerprint, seededState.fingerprint);

  writeFileSync(fixture.logFile, '');

  const result = runMonitor(['--interval', '0.05', '--pr', '42', '--state-file', stateFile, '--notify-target', 'issue-orchestrator'], {
    fakeBin: fixture.fakeBin,
    timeoutMs: 500,
    env: {
      PR_MONITOR_COMMAND_LOG: fixture.logFile,
      PR_MONITOR_SCENARIO: 'pass',
    },
  });

  assert.equal(result.status, null);
  assert.equal(result.error?.name, 'Error');
  assert.equal(result.error?.code, 'ETIMEDOUT');
  assert.match(result.stderr, /pr-monitor start/);
  assert.match(result.stderr, /pr-monitor poll/);
  assert.match(result.stderr, /reasons=feedback_present/);
  assert.match(result.stderr, /actionRequired=true/);
  assert.match(result.stderr, /duplicate-actionable continue/);

  const commands = readCommands(fixture.logFile);
  assert.equal(commands.filter((command) => command.cmd === 'herdr').length, 0);
});

test('CLI notify mode sends again when a later actionable fingerprint changes', () => {
  const fixture = makeFixture();
  const stateFile = join(fixture.dir, 'state', 'pr-monitor.json');
  const result = runMonitor(['--interval', '0.05', '--pr', '42', '--state-file', stateFile, '--notify-target', 'issue-orchestrator'], {
    fakeBin: fixture.fakeBin,
    timeoutMs: 900,
    env: {
      PR_MONITOR_COMMAND_LOG: fixture.logFile,
      PR_MONITOR_SCENARIO_SEQUENCE: 'pass,changes',
    },
  });

  assert.equal(result.status, null);
  assert.equal(result.error?.code, 'ETIMEDOUT');
  assert.match(result.stderr, /pr-monitor decision notify-ready target=issue-orchestrator/);

  const commands = readCommands(fixture.logFile).filter((command) => command.cmd === 'herdr');
  const sends = commands.filter((command) => command.args[0] === 'agent' && command.args[1] === 'send');
  assert.equal(sends.length, 2);
  assert.match(sends[0].args[3], /Reason: feedback_present/);
  assert.match(sends[1].args[3], /Reason: changes_requested/);

  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(state.reviewDecision, 'CHANGES_REQUESTED');
  assert.equal(state.notifiedFingerprint, state.fingerprint);
});

test('CLI notify mode retries after Herdr send fails before notified marker is written', () => {
  const fixture = makeFixture();
  const stateFile = join(fixture.dir, 'state', 'pr-monitor.json');

  const first = runMonitor(['--pr', '42', '--state-file', stateFile, '--notify-target', 'issue-orchestrator'], {
    fakeBin: fixture.fakeBin,
    env: {
      PR_MONITOR_COMMAND_LOG: fixture.logFile,
      PR_MONITOR_SCENARIO: 'pass',
      PR_MONITOR_HERDR_SEND_FAIL: '1',
    },
  });

  assert.equal(first.status, 1);
  assert.match(first.stderr, /herdr send failed/);

  const firstState = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(firstState.notifiedFingerprint, undefined);

  writeFileSync(fixture.logFile, '');

  const second = runMonitor(['--pr', '42', '--state-file', stateFile, '--notify-target', 'issue-orchestrator'], {
    fakeBin: fixture.fakeBin,
    timeoutMs: 1500,
    env: {
      PR_MONITOR_COMMAND_LOG: fixture.logFile,
      PR_MONITOR_SCENARIO: 'pass',
    },
  });

  assert.equal(second.status, null);
  assert.equal(second.error?.code, 'ETIMEDOUT');
  const commands = readCommands(fixture.logFile).filter((command) => command.cmd === 'herdr');
  assert.equal(commands.length, 3);
  assert.deepEqual(commands[0].args, ['agent', 'get', 'issue-orchestrator']);
  assert.deepEqual(commands[1].args.slice(0, 3), ['agent', 'send', 'issue-orchestrator']);
});

test('CLI --once exits after terminal merged snapshots', () => {
  const fixture = makeFixture();
  const result = runMonitor(['--once', '--json', '--pr', '42'], {
    fakeBin: fixture.fakeBin,
    env: {
      PR_MONITOR_COMMAND_LOG: fixture.logFile,
      PR_MONITOR_SCENARIO: 'merged',
    },
  });

  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.terminal, true);
  assert.deepEqual(report.reasons, ['merged']);
});

test('CLI notification mode exits after notifying for terminal merged snapshots', () => {
  const fixture = makeFixture();
  const stateFile = join(fixture.dir, 'state', 'pr-monitor.json');
  const result = runMonitor(['--pr', '42', '--state-file', stateFile, '--notify-target', 'issue-orchestrator'], {
    fakeBin: fixture.fakeBin,
    env: {
      PR_MONITOR_COMMAND_LOG: fixture.logFile,
      PR_MONITOR_SCENARIO: 'merged',
    },
  });

  assert.equal(result.status, 0);
  assert.match(result.stderr, /pr-monitor decision notify-ready target=issue-orchestrator/);
  assert.match(result.stderr, /pr-monitor decision exit-terminal/);

  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(state.terminal, true);
  assert.deepEqual(state.reasons, ['merged']);
  assert.equal(state.notifiedFingerprint, state.fingerprint);

  const commands = readCommands(fixture.logFile).filter((command) => command.cmd === 'herdr');
  assert.equal(commands.length, 3);
  assert.deepEqual(commands[0].args, ['agent', 'get', 'issue-orchestrator']);
  assert.deepEqual(commands[1].args.slice(0, 3), ['agent', 'send', 'issue-orchestrator']);
  assert.deepEqual(commands[2].args, ['pane', 'send-keys', 'pane-1', 'Return']);
});

test('CLI notification mode exits after notifying for terminal closed snapshots', () => {
  const fixture = makeFixture();
  const stateFile = join(fixture.dir, 'state', 'pr-monitor.json');
  const result = runMonitor(['--pr', '42', '--state-file', stateFile, '--notify-target', 'issue-orchestrator'], {
    fakeBin: fixture.fakeBin,
    env: {
      PR_MONITOR_COMMAND_LOG: fixture.logFile,
      PR_MONITOR_SCENARIO: 'closed',
    },
  });

  assert.equal(result.status, 0);
  assert.match(result.stderr, /pr-monitor decision notify-ready target=issue-orchestrator/);
  assert.match(result.stderr, /pr-monitor decision exit-terminal/);

  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(state.terminal, true);
  assert.deepEqual(state.reasons, ['closed']);
  assert.equal(state.notifiedFingerprint, state.fingerprint);
});

test('CLI notification mode writes state, sends one Herdr message, and presses Return', () => {
  const fixture = makeFixture();
  const stateFile = join(fixture.dir, 'state', 'pr-monitor.json');
  const result = runMonitor(['--pr', '42', '--state-file', stateFile, '--notify-target', 'issue-orchestrator'], {
    fakeBin: fixture.fakeBin,
    timeoutMs: 1500,
    env: {
      PR_MONITOR_COMMAND_LOG: fixture.logFile,
      PR_MONITOR_SCENARIO: 'fail',
    },
  });

  assert.equal(result.status, null);
  assert.equal(result.error?.code, 'ETIMEDOUT');
  assert.equal(result.stdout, '');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(state.actionRequired, true);
  assert.deepEqual(state.reasons, ['failing_checks', 'feedback_present']);

  const herdrCommands = readCommands(fixture.logFile).filter((command) => command.cmd === 'herdr');
  assert.equal(herdrCommands.length, 3);
  assert.deepEqual(herdrCommands[0].args, ['agent', 'get', 'issue-orchestrator']);
  assert.deepEqual(herdrCommands[1].args.slice(0, 3), ['agent', 'send', 'issue-orchestrator']);
  assert.match(herdrCommands[1].args[3], /Reason: failing_checks/);
  assert.deepEqual(herdrCommands[2].args, ['pane', 'send-keys', 'pane-1', 'Return']);
});

for (const [name, payload] of [
  ['null', 'null'],
  ['array', '[]'],
  ['missing pane id', '{"result":{"agent":{}}}'],
  ['non-string pane id', '{"result":{"agent":{"pane_id":123}}}'],
  ['shell pane', '{"result":{"agent":{"pane_id":"pane-1"}}}'],
] as const) {
  test(`CLI notification mode rejects malformed herdr agent get JSON: ${name}`, () => {
    const fixture = makeFixture();
    const result = runMonitor(['--pr', '42', '--notify-target', 'issue-orchestrator'], {
      fakeBin: fixture.fakeBin,
      env: {
        PR_MONITOR_COMMAND_LOG: fixture.logFile,
        PR_MONITOR_SCENARIO: 'fail',
        PR_MONITOR_HERDR_GET_JSON: payload,
      },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /herdr send target issue-orchestrator does not resolve to a Codex agent/);
    const commands = readCommands(fixture.logFile).filter((command) => command.cmd === 'herdr');
    assert.equal(commands.length, 1);
    assert.deepEqual(commands[0].args, ['agent', 'get', 'issue-orchestrator']);
  });
}
