import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function tempWorktree(): string {
  const worktreePath = mkdtempSync(join(tmpdir(), 'herdr-workflow-scripts-'));
  mkdirSync(join(worktreePath, '.agent'), { recursive: true });
  return worktreePath;
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, `${body.trimEnd()}\n`, 'utf8');
  chmodSync(path, 0o755);
}

function runScript(scriptName: string, cwd: string, env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bash', [join(process.cwd(), 'skills/herdr-implement/workflow-scripts', scriptName), cwd], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
    },
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function initGitRepo(repoPath: string): void {
  const init = spawnSync('git', ['init'], { cwd: repoPath, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const branch = spawnSync('git', ['checkout', '-b', 'main'], { cwd: repoPath, encoding: 'utf8' });
  assert.equal(branch.status, 0, branch.stderr);
  const configEmail = spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath, encoding: 'utf8' });
  assert.equal(configEmail.status, 0, configEmail.stderr);
  const configName = spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: repoPath, encoding: 'utf8' });
  assert.equal(configName.status, 0, configName.stderr);
}

test('post-worktree-setup emits parseable skipped and blocked outcomes', () => {
  const worktreePath = tempWorktree();
  initGitRepo(worktreePath);
  const missing = runScript('post-worktree-setup.sh', worktreePath);
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(missing.stdout.trim(), 'skipped');

  writeExecutable(
    join(worktreePath, '.agent', 'herdr-post-worktree-setup'),
    `#!/usr/bin/env bash
set -euo pipefail
printf generated > generated.txt
`,
  );

  const blocked = runScript('post-worktree-setup.sh', worktreePath);
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(blocked.stdout.trim(), 'blocked');
  assert.match(readFileSync(join(worktreePath, '.agent', 'post-worktree-setup.log'), 'utf8'), /hook left worktree dirty/);
});

test('run-checks emits success, checks_failed, and no_checks outcomes', () => {
  const worktreePath = tempWorktree();
  writeFileSync(
    join(worktreePath, 'package.json'),
    JSON.stringify(
      {
        name: 'fixture',
        private: true,
        scripts: {
          typecheck: 'typecheck-fixture',
          test: 'test-fixture',
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  const binDir = join(worktreePath, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeExecutable(
    join(binDir, 'pnpm'),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'noisy stdout from pnpm %s\\n' "$1"
printf 'noisy stderr from pnpm %s\\n' "$1" >&2
printf '%s %s\\n' "$1" "\${2:-}" >> .agent/pnpm-calls.log
if [[ "\${FAIL_STEP:-}" == "$1" ]]; then
  exit 1
fi
exit 0
`,
  );

  const success = runScript('run-checks.sh', worktreePath, {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
  });
  assert.equal(success.status, 0, success.stderr);
  assert.equal(success.stdout.trim(), 'success');
  assert.match(success.stderr, /noisy stdout from pnpm typecheck/);
  assert.match(success.stderr, /noisy stderr from pnpm typecheck/);
  assert.match(readFileSync(join(worktreePath, '.agent', 'pnpm-calls.log'), 'utf8'), /typecheck/);
  assert.match(readFileSync(join(worktreePath, '.agent', 'pnpm-calls.log'), 'utf8'), /test/);

  const failing = runScript('run-checks.sh', worktreePath, {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    FAIL_STEP: 'test',
  });
  assert.equal(failing.status, 0, failing.stderr);
  assert.equal(failing.stdout.trim(), 'checks_failed');
  assert.match(failing.stderr, /noisy stdout from pnpm test/);

  const emptyWorktree = tempWorktree();
  writeFileSync(join(emptyWorktree, 'package.json'), JSON.stringify({ name: 'empty', private: true }, null, 2), 'utf8');
  const noChecks = runScript('run-checks.sh', emptyWorktree, { PATH: `${binDir}:${process.env.PATH ?? ''}` });
  assert.equal(noChecks.status, 0, noChecks.stderr);
  assert.equal(noChecks.stdout.trim(), 'no_checks');
});

test('commit-changes emits success and no_changes outcomes', () => {
  const worktreePath = tempWorktree();
  initGitRepo(worktreePath);
  writeFileSync(join(worktreePath, 'README.md'), 'initial\n', 'utf8');
  const initialCommit = spawnSync('git', ['add', 'README.md'], { cwd: worktreePath, encoding: 'utf8' });
  assert.equal(initialCommit.status, 0, initialCommit.stderr);
  const commit = spawnSync('git', ['commit', '-m', 'initial'], { cwd: worktreePath, encoding: 'utf8' });
  assert.equal(commit.status, 0, commit.stderr);

  writeFileSync(join(worktreePath, 'README.md'), 'updated\n', 'utf8');
  const result = runScript('commit-changes.sh', worktreePath, { HERDR_ISSUE_CANONICAL: '#21' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'success');
  assert.match(spawnSync('git', ['log', '-1', '--pretty=%s'], { cwd: worktreePath, encoding: 'utf8' }).stdout, /Issue #21: herdr workflow changes/);

  const clean = runScript('commit-changes.sh', worktreePath);
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(clean.stdout.trim(), 'no_changes');
});

test('push-branch emits a parseable success outcome', () => {
  const worktreePath = tempWorktree();
  const binDir = join(worktreePath, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeExecutable(
    join(binDir, 'git'),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "-C" ]]; then
  shift 2
fi
case "$1 $2" in
  "branch --show-current")
    printf 'feature-branch\\n'
    ;;
  "rev-parse HEAD")
    printf 'abc123\\n'
    ;;
  "ls-remote --heads")
    printf '\\n'
    ;;
  "rev-parse --verify")
    exit 1
    ;;
  "push --set-upstream")
    printf '%s %s %s %s\\n' "$1" "$2" "$3" "$4" >> .agent/push-calls.log
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
`,
  );

  const result = runScript('push-branch.sh', worktreePath, {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'success');
  assert.match(readFileSync(join(worktreePath, '.agent', 'push-calls.log'), 'utf8'), /push --set-upstream origin feature-branch/);
});

test('push-branch skips pushing an already-up-to-date remote branch without upstream config', () => {
  const worktreePath = tempWorktree();
  const binDir = join(worktreePath, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeExecutable(
    join(binDir, 'git'),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "-C" ]]; then
  shift 2
fi
if [[ "$1" == "branch" && "$2" == "--show-current" ]]; then
  printf 'feature-branch\\n'
  exit 0
fi
if [[ "$1" == "rev-parse" && "$2" == "HEAD" ]]; then
  printf 'abc123\\n'
  exit 0
fi
if [[ "$1" == "ls-remote" && "$2" == "--heads" && "$3" == "origin" && "$4" == "feature-branch" ]]; then
  printf 'abc123\\trefs/heads/feature-branch\\n'
  exit 0
fi
if [[ "$1" == "rev-parse" && "$2" == "--verify" && "$3" == "--quiet" && "$4" == "feature-branch@{u}" ]]; then
  exit 1
fi
if [[ "$1" == "push" && "$2" == "--set-upstream" && "$3" == "origin" && "$4" == "feature-branch" ]]; then
  printf 'unexpected push\\n' >> .agent/push-calls.log
  exit 1
fi
exit 1
`,
  );

  const result = runScript('push-branch.sh', worktreePath, {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'success');
  assert.equal(existsSync(join(worktreePath, '.agent', 'push-calls.log')), false);
});

test('create-pr emits JSON capture for pr_number and pr_url', () => {
  const worktreePath = tempWorktree();
  const binDir = join(worktreePath, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeExecutable(
    join(binDir, 'git'),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "-C" ]]; then
  shift 2
fi
case "$1 $2" in
  "branch --show-current")
    printf 'feature-branch\\n'
    ;;
  *)
    exit 1
    ;;
esac
`,
  );
  writeExecutable(
    join(binDir, 'gh'),
    `#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  "pr view")
    if [[ -f .agent/pr-created ]]; then
      printf '%s\n' '{"pr_number": 41, "pr_url": "https://example.test/pull/41"}'
      exit 0
    fi
    exit 1
    ;;
  "pr create")
    mkdir -p .agent
    : > .agent/pr-created
    printf 'created\\n'
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
`,
  );

  const result = runScript('create-pr.sh', worktreePath, {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HERDR_BASE_BRANCH: 'main',
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.outcome, 'success');
  assert.deepEqual(parsed.capture, {
    pr_number: 41,
    pr_url: 'https://example.test/pull/41',
  });
});

test('create-pr returns an existing outcome when the branch already has a PR', () => {
  const worktreePath = tempWorktree();
  const binDir = join(worktreePath, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeExecutable(
    join(binDir, 'git'),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "-C" ]]; then
  shift 2
fi
case "$1 $2" in
  "branch --show-current")
    printf 'feature-branch\\n'
    ;;
  *)
    exit 1
    ;;
esac
`,
  );
  writeExecutable(
    join(binDir, 'gh'),
    `#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  "pr view")
    printf '%s\n' '{"pr_number": 41, "pr_url": "https://example.test/pull/41"}'
    exit 0
    ;;
  "pr create")
    printf 'unexpected create\\n' >&2
    exit 1
    ;;
  *)
    exit 1
    ;;
esac
`,
  );

  const result = runScript('create-pr.sh', worktreePath, {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HERDR_BASE_BRANCH: 'main',
  });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.outcome, 'existing');
  assert.deepEqual(parsed.capture, {
    pr_number: 41,
    pr_url: 'https://example.test/pull/41',
  });
});

test('cleanup-worktree is idempotent', () => {
  const worktreePath = tempWorktree();
  mkdirSync(join(worktreePath, '.agent', 'runs', 'run-1'), { recursive: true });
  writeFileSync(join(worktreePath, '.agent', 'runs', 'run-1', 'result.json'), '{}', 'utf8');

  const first = runScript('cleanup-worktree.sh', worktreePath);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout.trim(), 'success');
  assert.equal(existsSync(join(worktreePath, '.agent', 'runs')), false);

  const second = runScript('cleanup-worktree.sh', worktreePath);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout.trim(), 'success');
});
