import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  bootstrap,
  daemonStep,
  readDaemonHandleState,
  readWorkflowRunState,
  writeDaemonHandleState,
  writeWorkflowRunState,
} from './runtime.ts';

type HerdrCommandResult = {
  stdout: string;
  stderr: string;
  status: number | null;
};

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function workflowFixture(): Record<string, unknown> {
  return {
    name: 'default',
    version: 1,
    type: 'herdr.issue',
    start: 'setup',
    roles: {},
    phases: {
      setup: {
        type: 'herdr-worktree',
        on: { success: 'ready' },
      },
      ready: {
        type: 'terminal',
        status: 'complete',
      },
      done: {
        type: 'terminal',
        status: 'complete',
      },
    },
  };
}

function workflowStateFixture(worktreePath: string, issueNumber: number, currentPhase = 'setup') {
  return {
    schemaVersion: 1 as const,
    issue: {
      input: `#${issueNumber}`,
      number: issueNumber,
      url: null,
      canonical: `#${issueNumber}`,
    },
    workflowPath: join(worktreePath, 'skills/herdr-implement/workflows/default.yaml'),
    workflow: {
      ...workflowFixture(),
      roleDefaults: {},
      roles: {},
      phases: {
        setup: { type: 'herdr-worktree', on: { success: 'ready' } },
        ready: { type: 'terminal', status: 'complete' },
        done: { type: 'terminal', status: 'complete' },
      },
      transitions: [{ from: 'setup', outcome: 'success', to: 'ready' }],
    } as never,
    sourceRepo: {
      rootPath: worktreePath,
      remoteUrl: null,
      currentBranch: 'main',
      baseBranch: 'main',
    },
    branchName: `issue-${issueNumber}-herdr-implement`,
    worktreePath,
    workspaceId: `w${issueNumber}`,
    currentPhase,
    context: {},
    createdAt: '2026-06-30T12:00:00.000Z',
    updatedAt: '2026-06-30T12:00:00.000Z',
    daemonHandlePath: join(worktreePath, '.agent/herdr-implement.json'),
    daemon: {
      tabId: null,
      paneId: null,
      command: null,
      startedAt: null,
    },
  };
}

function handleStateFixture(worktreePath: string, issueNumber: number, daemonTabId: string | null, daemonPaneId: string | null) {
  return {
    schemaVersion: 1 as const,
    runStatePath: join(worktreePath, '.agent/herdr-workflow-run.json'),
    workspaceId: `w${issueNumber}`,
    worktreePath,
    daemonTabId,
    daemonPaneId,
    daemonCommand: 'node skills/herdr-implement/scripts/daemon.ts',
    createdAt: '2026-06-30T12:00:00.000Z',
    updatedAt: '2026-06-30T12:00:00.000Z',
  };
}

function normalizeArg(value: string): string {
  if (value.startsWith('/') && existsSync(value)) {
    return realpathSync(value);
  }
  return value;
}

function normalizeArgs(args: string[]): string[] {
  return args.map(normalizeArg);
}

function createRunner(expectations: Array<{ args: string[]; result: HerdrCommandResult }>) {
  let index = 0;
  return {
    run(args: string[]): HerdrCommandResult {
      assert.equal(index < expectations.length, true, `unexpected herdr command: ${args.join(' ')}`);
      const expected = expectations[index];
      index += 1;
      assert.deepEqual(normalizeArgs(args), normalizeArgs(expected.args));
      return expected.result;
    },
  };
}

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-implement-runtime-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test User']);
  await mkdir(join(dir, '.agent'), { recursive: true });
  await mkdir(join(dir, 'skills/herdr-implement/workflows'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), 'fixture\n', 'utf8');
  writeFileSync(join(dir, 'skills/herdr-implement/workflows/default.yaml'), JSON.stringify(workflowFixture(), null, 2), 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'initial']);
  return dir;
}

async function makeWorktreeFixture(worktreePath: string): Promise<void> {
  await mkdir(join(worktreePath, '.agent'), { recursive: true });
  await mkdir(join(worktreePath, 'skills/herdr-implement/workflows'), { recursive: true });
  writeFileSync(join(worktreePath, 'skills/herdr-implement/workflows/default.yaml'), JSON.stringify(workflowFixture(), null, 2), 'utf8');
}

test('bootstrap creates worktree-local state and a daemon command that daemon.ts accepts', async () => {
  const repo = await makeRepo();
  const repoRoot = realpathSync(repo);
  const worktreePath = join(repo, 'issue-worktree');
  await makeWorktreeFixture(worktreePath);

  const runner = createRunner([
    {
      args: ['worktree', 'list', '--cwd', repoRoot, '--json'],
      result: { stdout: '[]\n', stderr: '', status: 0 },
    },
    {
      args: [
        'worktree',
        'create',
        '--cwd',
        repoRoot,
        '--branch',
        'issue-16-herdr-implement',
        '--base',
        'main',
        '--label',
        'issue-16',
        '--focus',
        '--json',
      ],
      result: {
        stdout: `${JSON.stringify({
          workspaceId: 'w16',
          worktreePath,
          branch: 'issue-16-herdr-implement',
        })}\n`,
        stderr: '',
        status: 0,
      },
    },
    {
      args: ['worktree', 'list', '--cwd', repoRoot, '--json'],
      result: {
        stdout: `${JSON.stringify([
          { workspaceId: 'w16', worktreePath, branch: 'issue-16-herdr-implement' },
        ])}\n`,
        stderr: '',
        status: 0,
      },
    },
    {
      args: ['tab', 'create', '--workspace', 'w16', '--cwd', worktreePath, '--label', 'herdr-implement-daemon', '--focus'],
      result: { stdout: 'tab-1\n', stderr: '', status: 0 },
    },
    {
      args: ['pane', 'current', '--current'],
      result: { stdout: 'pane-1\n', stderr: '', status: 0 },
    },
    {
      args: [
        'pane',
        'run',
        'pane-1',
        `node skills/herdr-implement/scripts/daemon.ts --worktree ${JSON.stringify(
          worktreePath,
        )} --state .agent/herdr-workflow-run.json --handles .agent/herdr-implement.json`,
      ],
      result: { stdout: '', stderr: '', status: 0 },
    },
  ]);

  const result = bootstrap({ cwd: repo, issue: '#16', runner, now: () => new Date('2026-06-30T12:00:00.000Z') });

  assert.equal(result.workspaceId, 'w16');
  assert.equal(result.worktreePath, worktreePath);
  assert.equal(result.runStatePath, join(worktreePath, '.agent/herdr-workflow-run.json'));
  assert.equal(result.handleStatePath, join(worktreePath, '.agent/herdr-implement.json'));
  assert.equal(readWorkflowRunState(result.runStatePath)?.worktreePath, worktreePath);
  assert.equal(readDaemonHandleState(result.handleStatePath)?.daemonPaneId, 'pane-1');

  const daemonCli = spawnSync(
    process.execPath,
    [
      join(process.cwd(), 'skills/herdr-implement/scripts/daemon.ts'),
      '--worktree',
      worktreePath,
      '--state',
      '.agent/herdr-workflow-run.json',
      '--handles',
      '.agent/herdr-implement.json',
      '--once',
    ],
    {
      cwd: repo,
      encoding: 'utf8',
    },
  );

  assert.equal(daemonCli.status, 0, daemonCli.stderr);
  assert.match(daemonCli.stdout, /"status": "continue"/);
  assert.equal(readWorkflowRunState(result.runStatePath)?.currentPhase, 'ready');
});

test('bootstrap recovery reuses existing worktree-local state for the requested issue', async () => {
  const repo = await makeRepo();
  const repoRoot = realpathSync(repo);
  const worktreePath = join(repo, 'issue-worktree');
  await makeWorktreeFixture(worktreePath);
  writeWorkflowRunState(join(worktreePath, '.agent/herdr-workflow-run.json'), workflowStateFixture(worktreePath, 16));
  writeDaemonHandleState(join(worktreePath, '.agent/herdr-implement.json'), handleStateFixture(worktreePath, 16, 'tab-1', 'pane-1'));

  const runner = createRunner([
    {
      args: ['worktree', 'list', '--cwd', repoRoot, '--json'],
      result: {
        stdout: `${JSON.stringify([
          { workspaceId: 'w16', worktreePath, branch: 'issue-16-herdr-implement' },
        ])}\n`,
        stderr: '',
        status: 0,
      },
    },
  ]);

  const result = bootstrap({ cwd: repo, issue: '#16', runner });

  assert.equal(result.createdRunState, false);
  assert.equal(result.createdHandleState, false);
  assert.equal(result.daemonPaneId, 'pane-1');
});

test('bootstrap does not reuse an unrelated Herdr worktree', async () => {
  const repo = await makeRepo();
  const repoRoot = realpathSync(repo);
  const requestedWorktreePath = join(repo, 'requested-worktree');
  const unrelatedWorktreePath = join(repo, 'unrelated-worktree');
  await makeWorktreeFixture(requestedWorktreePath);
  await makeWorktreeFixture(unrelatedWorktreePath);

  const runner = createRunner([
    {
      args: ['worktree', 'list', '--cwd', repoRoot, '--json'],
      result: {
        stdout: `${JSON.stringify([
          { workspaceId: 'w99', worktreePath: unrelatedWorktreePath, branch: 'issue-99-herdr-implement' },
        ])}\n`,
        stderr: '',
        status: 0,
      },
    },
    {
      args: [
        'worktree',
        'create',
        '--cwd',
        repoRoot,
        '--branch',
        'issue-16-herdr-implement',
        '--base',
        'main',
        '--label',
        'issue-16',
        '--focus',
        '--json',
      ],
      result: {
        stdout: `${JSON.stringify({
          workspaceId: 'w16',
          worktreePath: requestedWorktreePath,
          branch: 'issue-16-herdr-implement',
        })}\n`,
        stderr: '',
        status: 0,
      },
    },
    {
      args: ['worktree', 'list', '--cwd', repoRoot, '--json'],
      result: {
        stdout: `${JSON.stringify([
          { workspaceId: 'w16', worktreePath: requestedWorktreePath, branch: 'issue-16-herdr-implement' },
        ])}\n`,
        stderr: '',
        status: 0,
      },
    },
    {
      args: ['tab', 'create', '--workspace', 'w16', '--cwd', requestedWorktreePath, '--label', 'herdr-implement-daemon', '--focus'],
      result: { stdout: 'tab-1\n', stderr: '', status: 0 },
    },
    {
      args: ['pane', 'current', '--current'],
      result: { stdout: 'pane-1\n', stderr: '', status: 0 },
    },
    {
      args: [
        'pane',
        'run',
        'pane-1',
        `node skills/herdr-implement/scripts/daemon.ts --worktree ${JSON.stringify(
          requestedWorktreePath,
        )} --state .agent/herdr-workflow-run.json --handles .agent/herdr-implement.json`,
      ],
      result: { stdout: '', stderr: '', status: 0 },
    },
  ]);

  const result = bootstrap({ cwd: repo, issue: '#16', runner });

  assert.equal(result.worktreePath, requestedWorktreePath);
  assert.equal(result.workspaceId, 'w16');
});

test('bootstrap rejects durable state that belongs to a different issue', async () => {
  const repo = await makeRepo();
  const repoRoot = realpathSync(repo);
  const worktreePath = join(repo, 'issue-worktree');
  await makeWorktreeFixture(worktreePath);
  writeWorkflowRunState(join(worktreePath, '.agent/herdr-workflow-run.json'), workflowStateFixture(worktreePath, 15));
  writeDaemonHandleState(join(worktreePath, '.agent/herdr-implement.json'), handleStateFixture(worktreePath, 15, 'tab-1', 'pane-1'));

  const runner = createRunner([
    {
      args: ['worktree', 'list', '--cwd', repoRoot, '--json'],
      result: {
        stdout: `${JSON.stringify([
          { workspaceId: 'w15', worktreePath, branch: 'issue-16-herdr-implement' },
        ])}\n`,
        stderr: '',
        status: 0,
      },
    },
  ]);

  assert.throws(() => bootstrap({ cwd: repo, issue: '#16', runner }), /existing run state belongs to #15, not #16/);
});

test('bootstrap fails when pane run fails before recording started handles', async () => {
  const repo = await makeRepo();
  const repoRoot = realpathSync(repo);
  const worktreePath = join(repo, 'issue-worktree');
  await makeWorktreeFixture(worktreePath);

  const runner = createRunner([
    {
      args: ['worktree', 'list', '--cwd', repoRoot, '--json'],
      result: { stdout: '[]\n', stderr: '', status: 0 },
    },
    {
      args: [
        'worktree',
        'create',
        '--cwd',
        repoRoot,
        '--branch',
        'issue-16-herdr-implement',
        '--base',
        'main',
        '--label',
        'issue-16',
        '--focus',
        '--json',
      ],
      result: {
        stdout: `${JSON.stringify({
          workspaceId: 'w16',
          worktreePath,
          branch: 'issue-16-herdr-implement',
        })}\n`,
        stderr: '',
        status: 0,
      },
    },
    {
      args: ['worktree', 'list', '--cwd', repoRoot, '--json'],
      result: {
        stdout: `${JSON.stringify([
          { workspaceId: 'w16', worktreePath, branch: 'issue-16-herdr-implement' },
        ])}\n`,
        stderr: '',
        status: 0,
      },
    },
    {
      args: ['tab', 'create', '--workspace', 'w16', '--cwd', worktreePath, '--label', 'herdr-implement-daemon', '--focus'],
      result: { stdout: 'tab-1\n', stderr: '', status: 0 },
    },
    {
      args: ['pane', 'current', '--current'],
      result: { stdout: 'pane-1\n', stderr: '', status: 0 },
    },
    {
      args: [
        'pane',
        'run',
        'pane-1',
        `node skills/herdr-implement/scripts/daemon.ts --worktree ${JSON.stringify(
          worktreePath,
        )} --state .agent/herdr-workflow-run.json --handles .agent/herdr-implement.json`,
      ],
      result: { stdout: '', stderr: 'daemon failed', status: 1 },
    },
  ]);

  assert.throws(() => bootstrap({ cwd: repo, issue: '#16', runner }), /herdr pane run failed/);
  assert.equal(readDaemonHandleState(join(worktreePath, '.agent/herdr-implement.json'))?.daemonPaneId, null);
  assert.equal(readDaemonHandleState(join(worktreePath, '.agent/herdr-implement.json'))?.daemonTabId, null);
});

test('daemon step stops immediately on a terminal phase', async () => {
  const repo = await makeRepo();
  const worktreePath = join(repo, 'issue-worktree');
  await makeWorktreeFixture(worktreePath);
  const runStatePath = join(worktreePath, '.agent/herdr-workflow-run.json');
  const handleStatePath = join(worktreePath, '.agent/herdr-implement.json');
  writeWorkflowRunState(runStatePath, workflowStateFixture(worktreePath, 16, 'done'));
  writeDaemonHandleState(handleStatePath, handleStateFixture(worktreePath, 16, 'tab-1', 'pane-1'));

  const result = daemonStep({
    cwd: worktreePath,
    statePath: '.agent/herdr-workflow-run.json',
    handleStatePath: '.agent/herdr-implement.json',
  });

  assert.equal(result.status, 'stop');
  assert.equal(result.currentPhase, 'done');
  assert.match(result.reason ?? '', /terminal phase/);
});
