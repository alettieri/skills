import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'herdr-pr-poll-helper-'));
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

function runHelper(scenario: string): { status: number | null; stdout: string; stderr: string } {
  const tempRoot = tempDir();
  const binDir = join(tempRoot, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeExecutable(
    join(binDir, 'gh'),
    `#!/bin/sh
set -eu
case "$*" in
  *"pr view"*)
    cat <<'JSON'
{"number":42,"url":"https://github.com/acme/repo/pull/42","state":"OPEN","reviewDecision":"APPROVED","comments":[],"reviews":[{"submittedAt":"2026-07-05T00:00:00Z"}]}
JSON
    ;;
  *"pr checks"*)
    case "\${SCENARIO:-}" in
      approved-pass)
        cat <<'JSON'
[{"bucket":"pass"}]
JSON
        ;;
      approved-pending)
        cat <<'JSON'
[{"bucket":"pending"}]
JSON
        ;;
      approved-none)
        printf '[]\n'
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  *)
    exit 1
    ;;
esac
`,
  );

  const result = spawnSync(
    process.execPath,
    ['skills/herdr-implement/scripts/pr-poll-helper.mjs', 'review', '42'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        SCENARIO: scenario,
      },
    },
  );

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test('approved PRs wait until checks pass instead of routing to feedback', () => {
  const pending = runHelper('approved-pending');
  assert.equal(pending.status, 0, pending.stderr);
  assert.deepEqual(JSON.parse(pending.stdout), {
    outcome: 'waiting',
    capture: {
      pr_number: 42,
      pr_url: 'https://github.com/acme/repo/pull/42',
      pr_state: 'OPEN',
      merged_at: null,
      closed_at: null,
      review_decision: 'APPROVED',
      comment_count: 0,
      review_count: 1,
      latest_comment_at: null,
      latest_review_at: '2026-07-05T00:00:00.000Z',
      checks_bucket: 'pending',
      checks_total: 1,
      checks_failing: 0,
      checks_pending: 1,
      checks_canceled: 0,
      checks_skipped: 0,
      checks_passing: 0,
      feedback_present: true,
    },
  });

  const none = runHelper('approved-none');
  assert.equal(none.status, 0, none.stderr);
  assert.deepEqual(JSON.parse(none.stdout).outcome, 'waiting');

  const pass = runHelper('approved-pass');
  assert.equal(pass.status, 0, pass.stderr);
  assert.deepEqual(JSON.parse(pass.stdout).outcome, 'approved');
});
