import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPrHostProvider } from './pr-host-provider.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'pr-host-provider-'));
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

function makeFixture(): { binDir: string } {
  const root = tempDir();
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeExecutable(
    join(binDir, 'gh'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '-R') {
  args.splice(0, 2);
}
if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({
    number: 42,
    url: 'https://github.com/acme/repo/pull/42',
    state: 'OPEN',
    reviewDecision: 'APPROVED',
    comments: [{ createdAt: '2026-07-05T00:00:00Z' }],
    reviews: [{ submittedAt: '2026-07-05T01:00:00Z' }],
  }));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'checks') {
  switch (process.env.PR_HOST_PROVIDER_SCENARIO) {
    case 'no-checks':
      process.stderr.write('no checks reported on this branch');
      process.exit(1);
    case 'exit8':
      process.stdout.write(JSON.stringify([{ bucket: 'pass', workflow: 'ci', name: 'test' }]));
      process.exit(8);
    default:
      process.stdout.write(JSON.stringify([{ bucket: 'pass', workflow: 'ci', name: 'test' }]));
      process.exit(0);
  }
}
process.stderr.write('unexpected gh args');
process.exit(2);
`,
  );

  return { binDir };
}

function withProviderEnv<T>(binDir: string, scenario: string | undefined, fn: () => T): T {
  const originalPath = process.env.PATH;
  const originalScenario = process.env.PR_HOST_PROVIDER_SCENARIO;
  process.env.PATH = `${binDir}:${originalPath ?? ''}`;
  if (scenario === undefined) {
    delete process.env.PR_HOST_PROVIDER_SCENARIO;
  } else {
    process.env.PR_HOST_PROVIDER_SCENARIO = scenario;
  }

  try {
    return fn();
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalScenario === undefined) {
      delete process.env.PR_HOST_PROVIDER_SCENARIO;
    } else {
      process.env.PR_HOST_PROVIDER_SCENARIO = originalScenario;
    }
  }
}

test('createPrHostProvider resolves github by default and by name', () => {
  assert.equal(createPrHostProvider().name, 'github');
  assert.equal(createPrHostProvider('github').name, 'github');
});

test('createPrHostProvider rejects unknown providers', () => {
  assert.throws(() => createPrHostProvider('gitlab'), /Unknown PR host provider: gitlab/);
});

test('github provider fetches normalized pull request payloads', () => {
  const fixture = makeFixture();
  withProviderEnv(fixture.binDir, undefined, () => {
    const provider = createPrHostProvider();
    assert.deepEqual(provider.fetchPullRequest('42', 'acme/repo'), {
      number: 42,
      url: 'https://github.com/acme/repo/pull/42',
      state: 'OPEN',
      mergedAt: undefined,
      closedAt: undefined,
      reviewDecision: 'APPROVED',
      updatedAt: undefined,
      title: undefined,
      comments: [{ createdAt: '2026-07-05T00:00:00Z' }],
      reviews: [{ submittedAt: '2026-07-05T01:00:00Z' }],
    });
  });
});

test('github provider fetches checks and tolerates no-checks and exit-8 results', () => {
  const fixture = makeFixture();
  withProviderEnv(fixture.binDir, undefined, () => {
    const provider = createPrHostProvider();
    assert.deepEqual(provider.fetchChecks('42', 'acme/repo'), [
      { bucket: 'pass', workflow: 'ci', name: 'test' },
    ]);
  });

  withProviderEnv(fixture.binDir, 'no-checks', () => {
    const provider = createPrHostProvider();
    assert.deepEqual(provider.fetchChecks('42', 'acme/repo'), []);
  });

  withProviderEnv(fixture.binDir, 'exit8', () => {
    const provider = createPrHostProvider();
    assert.deepEqual(provider.fetchChecks('42', 'acme/repo'), [
      { bucket: 'pass', workflow: 'ci', name: 'test' },
    ]);
  });
});
