import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runPostWorktreeSetup } from './post-worktree-setup.ts';

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'post-worktree-setup-'));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test User']);
  writeFileSync(join(dir, '.gitignore'), '.agent\n');
  writeFileSync(join(dir, 'README.md'), 'fixture\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'initial']);
  await mkdir(join(dir, '.agent'), { recursive: true });
  return dir;
}

function writeHook(repo: string, contents: string, mode = 0o755): string {
  const hookPath = join(repo, '.agent', 'herdr-post-worktree-setup');
  writeFileSync(hookPath, contents);
  chmodSync(hookPath, mode);
  return hookPath;
}

test('skips setup when hook is missing', async () => {
  const repo = await makeRepo();
  const result = await runPostWorktreeSetup(repo);

  assert.equal(result.status, 'skipped');
  assert.match(result.message, /No post-worktree setup hook/);
});

test('runs executable hook from the worktree root and writes full log', async () => {
  const repo = await makeRepo();
  writeHook(
    repo,
    `#!/usr/bin/env bash
set -euo pipefail
printf 'cwd=%s\\n' "$PWD"
printf 'stderr-line\\n' >&2
`,
  );

  const result = await runPostWorktreeSetup(repo);

  assert.equal(result.status, 'succeeded');
  assert.equal(result.exitCode, 0);
  const log = readFileSync(join(repo, '.agent', 'post-worktree-setup.log'), 'utf8');
  assert.match(log, new RegExp(`cwd=.*${basename(repo)}`));
  assert.match(log, /stderr-line/);
});

test('blocks when hook exists but is not executable', async () => {
  const repo = await makeRepo();
  writeHook(repo, '#!/usr/bin/env bash\n', 0o644);

  const result = await runPostWorktreeSetup(repo);

  assert.equal(result.status, 'blocked');
  assert.equal(result.blockerReason, 'not_executable');
  assert.match(readFileSync(join(repo, '.agent', 'post-worktree-setup.log'), 'utf8'), /not executable/);
});

test('blocks on non-zero hook exit and records output', async () => {
  const repo = await makeRepo();
  writeHook(
    repo,
    `#!/usr/bin/env bash
echo before-failure
echo failure-detail >&2
exit 17
`,
  );

  const result = await runPostWorktreeSetup(repo);

  assert.equal(result.status, 'blocked');
  assert.equal(result.blockerReason, 'non_zero_exit');
  assert.equal(result.exitCode, 17);
  const log = readFileSync(join(repo, '.agent', 'post-worktree-setup.log'), 'utf8');
  assert.match(log, /before-failure/);
  assert.match(log, /failure-detail/);
});

test('blocks when hook exceeds timeout', async () => {
  const repo = await makeRepo();
  writeHook(repo, "#!/usr/bin/env bash\ntrap '' TERM\nsleep 5\n");

  const result = await runPostWorktreeSetup(repo, { timeoutMs: 100 });

  assert.equal(result.status, 'blocked');
  assert.equal(result.blockerReason, 'timeout');
  assert.equal(result.timedOut, true);
  assert.match(readFileSync(join(repo, '.agent', 'post-worktree-setup.log'), 'utf8'), /timed out/);
});

test('blocks when successful hook leaves non-ignored untracked files', async () => {
  const repo = await makeRepo();
  writeHook(repo, '#!/usr/bin/env bash\nprintf dirty > generated.txt\n');

  const result = await runPostWorktreeSetup(repo);

  assert.equal(result.status, 'blocked');
  assert.equal(result.blockerReason, 'dirty_worktree');
  assert.match(result.dirtyStatus ?? '', /\?\? generated\.txt/);
});
