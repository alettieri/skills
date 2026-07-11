import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFakeRunner, createHerdrAdapter, type HerdrCommandResult, type RepositoryInfo } from '../src/herdr-adapter.ts';

function createRunner(expectations: Array<{ args: readonly string[]; result: HerdrCommandResult }>) {
  return createFakeRunner(expectations);
}

async function tempRepo(): Promise<RepositoryInfo> {
  const rootPath = await mkdtemp(join(tmpdir(), 'herdr-adapter-test-'));
  await mkdir(join(rootPath, '.agent'), { recursive: true });
  await mkdir(join(rootPath, 'skills/herdr-implement/workflows'), { recursive: true });
  await writeFile(
    join(rootPath, 'skills/herdr-implement/workflows/default.yaml'),
    JSON.stringify({
      name: 'default',
      version: 1,
      type: 'herdr.issue',
      start: 'ready',
      roles: {},
      phases: { ready: { type: 'terminal', status: 'complete' } },
    }),
    'utf8',
  );

  return {
    rootPath,
    remoteUrl: null,
    currentBranch: 'main',
    baseBranch: 'main',
  };
}

test('ensureWorktree normalizes existing and created worktree outputs', async () => {
  const repo = await tempRepo();
  const adapter = createHerdrAdapter(
    createRunner([
      {
        args: ['worktree', 'list', '--cwd', repo.rootPath, '--json'],
        result: {
          stdout: `${JSON.stringify([{ workspace_id: 'w1', path: '/tmp/worktree-1', branch: 'issue-1-herdr-implement' }])}\n`,
          stderr: '',
          status: 0,
        },
      },
      {
        args: ['worktree', 'list', '--cwd', repo.rootPath, '--json'],
        result: {
          stdout: '[]\n',
          stderr: '',
          status: 0,
        },
      },
      {
        args: [
          'worktree',
          'create',
          '--cwd',
          repo.rootPath,
          '--branch',
          'issue-2-herdr-implement',
          '--base',
          'main',
          '--label',
          'issue-2',
          '--focus',
          '--json',
        ],
        result: {
          stdout: `${JSON.stringify({ workspaceId: 'w2', worktreePath: '/tmp/worktree-2', branch: 'issue-2-herdr-implement' })}\n`,
          stderr: '',
          status: 0,
        },
      },
      {
        args: ['worktree', 'list', '--cwd', repo.rootPath, '--json'],
        result: {
          stdout: `${JSON.stringify([
            { workspaceId: 'w2', worktreePath: '/tmp/worktree-2', branch: 'issue-2-herdr-implement' },
          ])}\n`,
          stderr: '',
          status: 0,
        },
      },
    ]),
  );

  const existing = adapter.ensureWorktree(repo, 'issue-1-herdr-implement', 'issue-1');
  assert.deepEqual(existing, {
    workspaceId: 'w1',
    worktreePath: '/tmp/worktree-1',
    branchName: 'issue-1-herdr-implement',
  });

  const created = adapter.ensureWorktree(repo, 'issue-2-herdr-implement', 'issue-2');
  assert.deepEqual(created, {
    workspaceId: 'w2',
    worktreePath: '/tmp/worktree-2',
    branchName: 'issue-2-herdr-implement',
  });
});

test('adapter owns daemon pane launch, pane commands, and role agent launching', async () => {
  const repo = await tempRepo();
  const adapter = createHerdrAdapter(
    createRunner([
      {
        args: ['tab', 'create', '--workspace', 'w1', '--cwd', repo.rootPath, '--label', 'herdr-implement-daemon', '--focus'],
        result: {
          stdout: `${JSON.stringify({ result: { tab_id: 'tab-daemon' } })}\n`,
          stderr: '',
          status: 0,
        },
      },
      {
        args: ['pane', 'current', '--current'],
        result: {
          stdout: 'pane-current\n',
          stderr: '',
          status: 0,
        },
      },
      {
        args: ['pane', 'get', 'pane-daemon'],
        result: {
          stdout: `${JSON.stringify({ result: { pane: { pane_id: 'pane-daemon', tab_id: 'tab-daemon', terminal_id: 'term-daemon' } } })}\n`,
          stderr: '',
          status: 0,
        },
      },
      {
        args: ['pane', 'run', 'pane-current', 'node daemon.js'],
        result: { stdout: '', stderr: '', status: 0 },
      },
      {
        args: [
          'agent',
          'start',
          'issue-1-implementer',
          '--cwd',
          repo.rootPath,
          '--workspace',
          'w1',
          '--focus',
          '--',
          'codex',
          '-a',
          'on-request',
          '-m',
          'gpt-5.4-mini',
          '-s',
          'workspace-write',
        ],
        result: {
          stdout: `${JSON.stringify({
            result: {
              agent: {
                name: 'issue-1-implementer',
                pane_id: 'pane-impl',
                tab_id: 'tab-start',
                terminal_id: 'term-impl',
              },
            },
          })}\n`,
          stderr: '',
          status: 0,
        },
      },
      {
        args: ['pane', 'move', 'pane-impl', '--new-tab', '--workspace', 'w1', '--label', 'implementer', '--focus'],
        result: {
          stdout: `${JSON.stringify({
            result: {
              move_result: {
                created_tab: { tab_id: 'tab-impl' },
                pane: { pane_id: 'pane-impl', tab_id: 'tab-impl', terminal_id: 'term-impl' },
              },
            },
          })}\n`,
          stderr: '',
          status: 0,
        },
      },
      {
        args: ['agent', 'send', 'issue-1-implementer', 'prompt text'],
        result: { stdout: '', stderr: '', status: 0 },
      },
      {
        args: ['pane', 'send-keys', 'pane-impl', 'Return'],
        result: { stdout: '', stderr: '', status: 0 },
      },
    ]),
  );

  assert.deepEqual(adapter.createDaemonPane('w1', repo.rootPath), {
    tabId: 'tab-daemon',
    paneId: 'pane-current',
    terminalId: null,
  });
  assert.deepEqual(adapter.getPaneInfo('pane-daemon'), {
    paneId: 'pane-daemon',
    tabId: 'tab-daemon',
    terminalId: 'term-daemon',
  });
  adapter.runPaneCommand('pane-current', 'node daemon.js');
  assert.deepEqual(
    adapter.launchRoleAgent(
      repo.rootPath,
      'w1',
      { agent: 'codex', codex: { approval: 'on-request', sandbox: 'workspace-write' }, model: 'gpt-5.4-mini' },
      'implementer',
      'issue-1-implementer',
    ),
    {
      tabId: 'tab-impl',
      paneId: 'pane-impl',
      terminalId: 'term-impl',
    },
  );
  adapter.sendPrompt('issue-1-implementer', 'prompt text');
  adapter.submitPrompt('pane-impl');
});

test('getAgentStatus returns missing with command failure details and accepts output variants', async () => {
  const adapter = createHerdrAdapter(
    createRunner([
      {
        args: ['agent', 'get', 'missing-agent'],
        result: { stdout: '', stderr: 'not found', status: 1 },
      },
      {
        args: ['agent', 'get', 'issue-1-implementer'],
        result: {
          stdout: `${JSON.stringify({ result: { agent: { agent_name: 'issue-1-implementer', pane_id: 'pane-1', agent_status: 'working' } } })}\n`,
          stderr: '',
          status: 0,
        },
      },
      {
        args: ['agent', 'read', 'issue-1-implementer'],
        result: { stdout: 'transcript text\n', stderr: '', status: 0 },
      },
    ]),
  );

  const missing = adapter.getAgentStatus('missing-agent');
  assert.equal(missing.status, 'missing');
  assert.equal(missing.failure?.kind, 'command-failed');
  assert.equal(missing.failure?.exitCode, 1);

  const status = adapter.getAgentStatus('issue-1-implementer');
  assert.equal(status.status, 'working');
  assert.equal(status.agentName, 'issue-1-implementer');
  assert.equal(status.paneId, 'pane-1');

  assert.equal(adapter.readAgentTranscript('issue-1-implementer'), 'transcript text');
});

test('adapter throws on malformed JSON and invalid shapes', async () => {
  const repo = await tempRepo();
  const adapter = createHerdrAdapter(
    createRunner([
      {
        args: ['worktree', 'list', '--cwd', repo.rootPath, '--json'],
        result: { stdout: '{not-json}\n', stderr: '', status: 0 },
      },
      {
        args: ['tab', 'create', '--workspace', 'w1', '--cwd', repo.rootPath, '--label', 'herdr-implement-daemon', '--focus'],
        result: { stdout: '{"tabId":17}\n', stderr: '', status: 0 },
      },
    ]),
  );

  assert.throws(() => adapter.ensureWorktree(repo, 'issue-1-herdr-implement', 'issue-1'), /returned invalid JSON/);
  assert.throws(() => adapter.createDaemonPane('w1', repo.rootPath), /tab create.tabId must be a string when present/);
});

test('adapter throws when successful worktree output omits required fields', async () => {
  const repo = await tempRepo();
  const adapter = createHerdrAdapter(
    createRunner([
      {
        args: ['worktree', 'list', '--cwd', repo.rootPath, '--json'],
        result: {
          stdout: `${JSON.stringify([{ branch: 'issue-1-herdr-implement', path: '/tmp/worktree-1' }])}\n`,
          stderr: '',
          status: 0,
        },
      },
    ]),
  );

  assert.throws(() => adapter.ensureWorktree(repo, 'issue-1-herdr-implement', 'issue-1'), /did not include a workspace id/);
});

test('adapter throws when successful agent get output is shape-invalid', async () => {
  for (const stdout of ['[]\n', '{}\n', `${JSON.stringify({ result: {} })}\n`]) {
    const adapter = createHerdrAdapter(
      createRunner([
        {
          args: ['agent', 'get', 'issue-1-implementer'],
          result: { stdout, stderr: '', status: 0 },
        },
      ]),
    );

    assert.throws(() => adapter.getAgentStatus('issue-1-implementer'), /must be an object|did not include an agent object/);
  }
});

test('adapter throws when pane move succeeds without required handles', async () => {
  const repo = await tempRepo();
  const adapter = createHerdrAdapter(
    createRunner([
      {
        args: [
          'agent',
          'start',
          'issue-1-implementer',
          '--cwd',
          repo.rootPath,
          '--workspace',
          'w1',
          '--focus',
          '--',
          'codex',
          '-a',
          'on-request',
          '-m',
          'gpt-5.4-mini',
          '-s',
          'workspace-write',
        ],
        result: {
          stdout: `${JSON.stringify({
            result: {
              agent: {
                name: 'issue-1-implementer',
                pane_id: 'pane-impl',
                tab_id: 'tab-start',
                terminal_id: 'term-start',
              },
            },
          })}\n`,
          stderr: '',
          status: 0,
        },
      },
      {
        args: ['pane', 'move', 'pane-impl', '--new-tab', '--workspace', 'w1', '--label', 'implementer', '--focus'],
        result: {
          stdout: `${JSON.stringify({ result: { move_result: { pane: { pane_id: 'pane-impl' } } } })}\n`,
          stderr: '',
          status: 0,
        },
      },
    ]),
  );

  assert.throws(
    () =>
      adapter.launchRoleAgent(
        repo.rootPath,
        'w1',
        { agent: 'codex', codex: { approval: 'on-request', sandbox: 'workspace-write' }, model: 'gpt-5.4-mini' },
        'implementer',
        'issue-1-implementer',
      ),
    /did not include a tab id|did not include a terminal id/,
  );
});
