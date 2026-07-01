import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
import { normalizeWorkflow } from './workflow.ts';

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

function agentWorkflowFixture(reuse = true, promptTemplate = 'implement.md'): Record<string, unknown> {
  return {
    name: 'agent-workflow',
    version: 1,
    type: 'herdr.issue',
    start: 'setup',
    roleDefaults: {
      agent: 'codex',
      approval: 'on-request',
      sandbox: 'workspace-write',
      reuse,
    },
    roles: {
      implementer: {
        label: 'implementer',
        agentNameTemplate: 'issue-{{ issue.number }}-implementer',
        model: 'gpt-5.4-mini',
      },
    },
    phases: {
      setup: {
        type: 'herdr-worktree',
        on: { success: 'implement' },
      },
      implement: {
        type: 'agent',
        role: 'implementer',
        promptTemplate,
        on: { complete: 'fix' },
      },
      fix: {
        type: 'agent',
        role: 'implementer',
        promptTemplate: 'fix.md',
        on: { complete: 'done' },
      },
      done: {
        type: 'terminal',
        status: 'complete',
      },
    },
  };
}

function completionWorkflowFixture(): Record<string, unknown> {
  return {
    name: 'completion-workflow',
    version: 1,
    type: 'herdr.issue',
    start: 'setup',
    roleDefaults: {
      agent: 'codex',
      approval: 'on-request',
      sandbox: 'workspace-write',
      reuse: true,
    },
    roles: {
      implementer: {
        label: 'implementer',
        agentNameTemplate: 'issue-{{ issue.number }}-implementer',
        model: 'gpt-5.4-mini',
      },
    },
    phases: {
      setup: {
        type: 'terminal',
        status: 'complete',
      },
      implement: {
        type: 'agent',
        role: 'implementer',
        promptTemplate: 'implement.md',
        resultSchema: 'implementer-result-v1',
        on: { complete: 'next', blocked: 'blocked' },
      },
      next: {
        type: 'terminal',
        status: 'complete',
      },
      blocked: {
        type: 'terminal',
        status: 'blocked',
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
    pendingAgentRun: null,
    acceptedAgentRuns: {},
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
    roleAgents: {},
    createdAt: '2026-06-30T12:00:00.000Z',
    updatedAt: '2026-06-30T12:00:00.000Z',
  };
}

function agentWorkflowStateFixture(worktreePath: string, issueNumber: number, currentPhase = 'setup', reuse = true) {
  const workflowPath = join(worktreePath, '.agent/herdr-workflow.yaml');
  return {
    schemaVersion: 1 as const,
    issue: {
      input: `#${issueNumber}`,
      number: issueNumber,
      url: null,
      canonical: `#${issueNumber}`,
    },
    workflowPath,
    workflow: normalizeWorkflow(agentWorkflowFixture(reuse)) as never,
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
    pendingAgentRun: null,
    acceptedAgentRuns: {},
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

function completionWorkflowStateFixture(worktreePath: string, issueNumber: number, currentPhase = 'implement') {
  const workflowPath = join(worktreePath, '.agent/herdr-workflow.yaml');
  return {
    schemaVersion: 1 as const,
    issue: {
      input: `#${issueNumber}`,
      number: issueNumber,
      url: null,
      canonical: `#${issueNumber}`,
    },
    workflowPath,
    workflow: normalizeWorkflow(completionWorkflowFixture()) as never,
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
    pendingAgentRun: null,
    acceptedAgentRuns: {},
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

async function makeAgentWorkflowFixture(worktreePath: string, reuse = true): Promise<void> {
  await makeWorktreeFixture(worktreePath);
  await mkdir(join(worktreePath, '.agent/prompts'), { recursive: true });
  await mkdir(join(worktreePath, 'skills/herdr-implement/prompts'), { recursive: true });
  writeFileSync(join(worktreePath, '.agent/herdr-workflow.yaml'), JSON.stringify(agentWorkflowFixture(reuse), null, 2), 'utf8');
  writeFileSync(
    join(worktreePath, '.agent/prompts/implement.md'),
    'PROJECT prompt for {{ runId }} / {{ phaseId }} / {{ roleId }} / {{ resultPath }} / {{ notifyTarget }} / {{ requiredOutcome }} / {{ optionalCapture }} / {{ completionUtility }}\n',
    'utf8',
  );
  writeFileSync(
    join(worktreePath, 'skills/herdr-implement/prompts/implement.md'),
    'SKILL prompt for {{ runId }}\n',
    'utf8',
  );
  writeFileSync(
    join(worktreePath, 'skills/herdr-implement/prompts/fix.md'),
    'SKILL fix prompt for {{ runId }}\n',
    'utf8',
  );
}

async function makeCompletionWorkflowFixture(worktreePath: string): Promise<void> {
  await makeWorktreeFixture(worktreePath);
  await mkdir(join(worktreePath, '.agent/prompts'), { recursive: true });
  writeFileSync(join(worktreePath, '.agent/herdr-workflow.yaml'), JSON.stringify(completionWorkflowFixture(), null, 2), 'utf8');
  writeFileSync(
    join(worktreePath, '.agent/prompts/implement.md'),
    'PROJECT completion prompt for {{ runId }} / {{ phaseId }} / {{ roleId }} / {{ resultPath }} / {{ notifyTarget }} / {{ requiredOutcome }} / {{ optionalCapture }} / {{ completionUtility }}\n',
    'utf8',
  );
}

function expectedAgentPrompt(input: {
  runId: string;
  phaseId: string;
  roleId: string;
  completionRole?: 'implementer' | 'reviewer';
  resultPath: string;
  notifyTarget: string;
  requiredOutcome: string;
  body: string;
}): string {
  const completionRole = input.completionRole ?? 'implementer';
  return [
    'Agent run metadata:',
    `- Run id: ${input.runId}`,
    `- Phase id: ${input.phaseId}`,
    `- Role id: ${input.roleId}`,
    `- Completion role: ${completionRole}`,
    `- Result path: ${input.resultPath}`,
    `- Notify target: ${input.notifyTarget}`,
    `- Required outcome: ${input.requiredOutcome}`,
    '- Optional capture: optional capture value if needed',
    '',
    'When complete, write the result artifact and invoke:',
    '',
    '```bash',
    `node skills/herdr-worktree-flow/scripts/agent-run-complete.ts --run-id ${input.runId} --role ${completionRole} --phase ${input.phaseId} --result ${input.resultPath} --notify-target ${input.notifyTarget}`,
    '```',
    '',
    input.body,
  ].join('\n');
}

function expectedRewritePrompt(input: {
  runId: string;
  phaseId: string;
  roleId: string;
  completionRole?: 'implementer' | 'reviewer';
  resultPath: string;
  reason: string;
}): string {
  const completionRole = input.completionRole ?? 'implementer';
  return [
    `The result artifact at ${input.resultPath} is invalid.`,
    `Reason: ${input.reason}`,
    `Run id: ${input.runId}`,
    `Phase id: ${input.phaseId}`,
    `Role id: ${input.roleId}`,
    `Completion role: ${completionRole}`,
    'Expected outcome must be one of: complete, blocked',
    'Rewrite the JSON result artifact at the recorded path and then rerun the completion utility.',
  ].join('\n');
}

function writeResultArtifact(path: string, artifact: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}

function pendingCompletionRun(worktreePath: string, issueNumber = 18) {
  const runId = `issue-${issueNumber}-implement-implementer-1`;
  return {
    runId,
    phaseId: 'implement',
    roleId: 'implementer',
    completionRole: 'implementer' as const,
    roleLabel: 'implementer',
    agentName: `issue-${issueNumber}-implementer`,
    resultSchema: 'implementer-result-v1',
    resultPath: join(worktreePath, '.agent/runs', runId, 'result.json'),
    notifyTarget: `issue-${issueNumber}-orchestrator`,
    attemptNumber: 1,
    startedAt: '2026-06-30T12:00:00.000Z',
    status: 'pending' as const,
  };
}

function validCompletionArtifact(run = pendingCompletionRun('/tmp/worktree')) {
  return {
    schemaVersion: 1,
    runId: run.runId,
    phase: run.phaseId,
    role: run.roleId,
    resultSchema: 'implementer-result-v1',
    status: 'complete',
    outcome: 'complete',
    summary: 'implemented completion routing',
    capture: { reviewFindings: 'none' },
    payload: { changedFiles: ['skills/herdr-implement/scripts/runtime.ts'] },
  };
}

function completionHandleState(worktreePath: string, issueNumber = 18) {
  return {
    ...handleStateFixture(worktreePath, issueNumber, 'tab-daemon', 'pane-daemon'),
    roleAgents: {
      implementer: {
        roleId: 'implementer',
        roleLabel: 'implementer',
        agentName: `issue-${issueNumber}-implementer`,
        tabId: 'tab-impl',
        paneId: 'pane-impl',
        terminalId: 'term-impl',
        createdAt: '2026-06-30T12:00:00.000Z',
        updatedAt: '2026-06-30T12:00:00.000Z',
      },
    },
  };
}

function agentGetResult(status: string, issueNumber = 18): HerdrCommandResult {
  return {
    stdout: `${JSON.stringify({
      result: {
        agent: {
          name: `issue-${issueNumber}-implementer`,
          pane_id: 'pane-impl',
          tab_id: 'tab-impl',
          terminal_id: 'term-impl',
          agent_status: status,
        },
      },
    })}\n`,
    stderr: '',
    status: 0,
  };
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

test('bootstrap recovery accepts snake-case Herdr workspace ids', async () => {
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
          { workspace_id: 'w16', worktreePath, branch: 'issue-16-herdr-implement' },
        ])}\n`,
        stderr: '',
        status: 0,
      },
    },
  ]);

  const result = bootstrap({ cwd: repo, issue: '#16', runner });

  assert.equal(result.workspaceId, 'w16');
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

test('bootstrap reports invalid Herdr JSON with command context', async () => {
  const repo = await makeRepo();
  const repoRoot = realpathSync(repo);

  const runner = createRunner([
    {
      args: ['worktree', 'list', '--cwd', repoRoot, '--json'],
      result: { stdout: '{not-json}\n', stderr: '', status: 0 },
    },
  ]);

  assert.throws(
    () => bootstrap({ cwd: repo, issue: '#16', runner }),
    /herdr worktree list --cwd .* --json returned invalid JSON/,
  );
});

test('bootstrap rejects malformed Herdr worktree list output', async () => {
  const repo = await makeRepo();
  const repoRoot = realpathSync(repo);

  const runner = createRunner([
    {
      args: ['worktree', 'list', '--cwd', repoRoot, '--json'],
      result: { stdout: '{"worktrees":{"branch":"issue-16-herdr-implement"}}\n', stderr: '', status: 0 },
    },
  ]);

  assert.throws(
    () => bootstrap({ cwd: repo, issue: '#16', runner }),
    /herdr worktree list output validation failed: worktree list.worktrees must be an array when present/,
  );
});

test('bootstrap rejects malformed Herdr pane output before recording daemon handles', async () => {
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
      result: { stdout: '{"tabId":17}\n', stderr: '', status: 0 },
    },
  ]);

  assert.throws(
    () => bootstrap({ cwd: repo, issue: '#16', runner }),
    /herdr tab create output validation failed: tab create.tabId must be a string when present/,
  );
  assert.equal(readDaemonHandleState(join(worktreePath, '.agent/herdr-implement.json'))?.daemonPaneId, null);
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

test('daemon step lazily starts a role agent and records a pending run', async () => {
  const repo = await makeRepo();
  const worktreePath = join(repo, 'issue-worktree');
  await makeAgentWorkflowFixture(worktreePath);
  const runStatePath = join(worktreePath, '.agent/herdr-workflow-run.json');
  const handleStatePath = join(worktreePath, '.agent/herdr-implement.json');
  writeWorkflowRunState(runStatePath, agentWorkflowStateFixture(worktreePath, 17, 'implement'));
  writeDaemonHandleState(handleStatePath, handleStateFixture(worktreePath, 17, 'tab-1', 'pane-1'));

  const resultPath = join(worktreePath, '.agent/runs/issue-17-implement-implementer-1/result.json');
  const expectedPrompt = expectedAgentPrompt({
    runId: 'issue-17-implement-implementer-1',
    phaseId: 'implement',
    roleId: 'implementer',
    resultPath,
    notifyTarget: 'issue-17-orchestrator',
    requiredOutcome: 'complete',
    body: `PROJECT prompt for issue-17-implement-implementer-1 / implement / implementer / ${resultPath} / issue-17-orchestrator / complete / optional capture value if needed / node skills/herdr-worktree-flow/scripts/agent-run-complete.ts\n`,
  });
  const runner = createRunner([
    {
      args: [
        'agent',
        'start',
        'issue-17-implementer',
        '--cwd',
        worktreePath,
        '--workspace',
        'w17',
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
          id: 'cli:agent:start',
          result: {
            agent: {
              name: 'issue-17-implementer',
              pane_id: 'pane-impl',
              tab_id: 'tab-source',
              terminal_id: 'term-impl',
            },
          },
        })}\n`,
        stderr: '',
        status: 0,
      },
    },
    {
      args: ['pane', 'move', 'pane-impl', '--new-tab', '--workspace', 'w17', '--label', 'implementer', '--focus'],
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
      args: ['agent', 'send', 'issue-17-implementer', expectedPrompt],
      result: { stdout: '', stderr: '', status: 0 },
    },
    {
      args: ['pane', 'send-keys', 'pane-impl', 'Return'],
      result: { stdout: '', stderr: '', status: 0 },
    },
  ]);

  const result = daemonStep({
    cwd: worktreePath,
    statePath: '.agent/herdr-workflow-run.json',
    handleStatePath: '.agent/herdr-implement.json',
    runner,
    now: () => new Date('2026-06-30T12:34:56.000Z'),
  });

  assert.equal(result.status, 'sleep');
  assert.match(result.reason ?? '', /waiting for agent run issue-17-implement-implementer-1/);

  const runState = readWorkflowRunState(runStatePath);
  assert.equal(runState?.pendingAgentRun?.status, 'pending');
  assert.equal(runState?.pendingAgentRun?.phaseId, 'implement');
  assert.equal(runState?.pendingAgentRun?.roleId, 'implementer');
  assert.equal(runState?.pendingAgentRun?.resultPath, resultPath);
  assert.equal(runState?.pendingAgentRun?.notifyTarget, 'issue-17-orchestrator');
  assert.equal(runState?.pendingAgentRun?.attemptNumber, 1);

  const handleState = readDaemonHandleState(handleStatePath);
  assert.equal(handleState?.roleAgents.implementer.agentName, 'issue-17-implementer');
  assert.equal(handleState?.roleAgents.implementer.tabId, 'tab-impl');
  assert.equal(handleState?.roleAgents.implementer.paneId, 'pane-impl');
  assert.equal(handleState?.roleAgents.implementer.terminalId, 'term-impl');
});

test('daemon step reuses a recorded role agent when reuse is true', async () => {
  const repo = await makeRepo();
  const worktreePath = join(repo, 'issue-worktree');
  await makeAgentWorkflowFixture(worktreePath);
  const runStatePath = join(worktreePath, '.agent/herdr-workflow-run.json');
  const handleStatePath = join(worktreePath, '.agent/herdr-implement.json');
  writeWorkflowRunState(runStatePath, agentWorkflowStateFixture(worktreePath, 17, 'fix'));
  writeDaemonHandleState(handleStatePath, {
    ...handleStateFixture(worktreePath, 17, 'tab-1', 'pane-1'),
    roleAgents: {
      implementer: {
        roleId: 'implementer',
        roleLabel: 'implementer',
        agentName: 'issue-17-implementer',
        tabId: 'tab-impl',
        paneId: 'pane-impl',
        terminalId: 'term-impl',
        createdAt: '2026-06-30T12:00:00.000Z',
        updatedAt: '2026-06-30T12:00:00.000Z',
      },
    },
  });

  const resultPath = join(worktreePath, '.agent/runs/issue-17-fix-implementer-1/result.json');
  const expectedPrompt = expectedAgentPrompt({
    runId: 'issue-17-fix-implementer-1',
    phaseId: 'fix',
    roleId: 'implementer',
    resultPath,
    notifyTarget: 'issue-17-orchestrator',
    requiredOutcome: 'complete',
    body: 'SKILL fix prompt for issue-17-fix-implementer-1\n',
  });
  const runner = createRunner([
    {
      args: ['agent', 'send', 'issue-17-implementer', expectedPrompt],
      result: { stdout: '', stderr: '', status: 0 },
    },
    {
      args: ['pane', 'send-keys', 'pane-impl', 'Return'],
      result: { stdout: '', stderr: '', status: 0 },
    },
  ]);

  daemonStep({
    cwd: worktreePath,
    statePath: '.agent/herdr-workflow-run.json',
    handleStatePath: '.agent/herdr-implement.json',
    runner,
    now: () => new Date('2026-06-30T12:34:56.000Z'),
  });

  const runState = readWorkflowRunState(runStatePath);
  assert.equal(runState?.pendingAgentRun?.runId, 'issue-17-fix-implementer-1');
  assert.equal(runState?.pendingAgentRun?.resultPath, resultPath);
});

test('daemon step starts fresh one-off role agents when reuse is false', async () => {
  const repo = await makeRepo();
  const worktreePath = join(repo, 'issue-worktree');
  await makeAgentWorkflowFixture(worktreePath, false);
  const runStatePath = join(worktreePath, '.agent/herdr-workflow-run.json');
  const handleStatePath = join(worktreePath, '.agent/herdr-implement.json');
  writeWorkflowRunState(runStatePath, agentWorkflowStateFixture(worktreePath, 17, 'fix', false));
  writeDaemonHandleState(handleStatePath, {
    ...handleStateFixture(worktreePath, 17, 'tab-1', 'pane-1'),
    roleAgents: {
      implementer: {
        roleId: 'implementer',
        roleLabel: 'implementer',
        agentName: 'old-agent',
        tabId: 'old-tab',
        paneId: 'old-pane',
        terminalId: 'old-term',
        createdAt: '2026-06-30T12:00:00.000Z',
        updatedAt: '2026-06-30T12:00:00.000Z',
      },
    },
  });

  const runner = createRunner([
    {
      args: [
        'agent',
        'start',
        'issue-17-implementer-issue-17-fix-implementer-1',
        '--cwd',
        worktreePath,
        '--workspace',
        'w17',
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
              name: 'issue-17-implementer-issue-17-fix-implementer-1',
              pane_id: 'new-pane',
              terminal_id: 'new-term',
            },
          },
        })}\n`,
        stderr: '',
        status: 0,
      },
    },
    {
      args: ['pane', 'move', 'new-pane', '--new-tab', '--workspace', 'w17', '--label', 'implementer', '--focus'],
      result: {
        stdout: `${JSON.stringify({
          result: {
            move_result: {
              created_tab: { tab_id: 'new-tab' },
              pane: { pane_id: 'new-pane', terminal_id: 'new-term' },
            },
          },
        })}\n`,
        stderr: '',
        status: 0,
      },
    },
    {
      args: [
        'agent',
        'send',
        'issue-17-implementer-issue-17-fix-implementer-1',
        expectedAgentPrompt({
          runId: 'issue-17-fix-implementer-1',
          phaseId: 'fix',
          roleId: 'implementer',
          resultPath: join(worktreePath, '.agent/runs/issue-17-fix-implementer-1/result.json'),
          notifyTarget: 'issue-17-orchestrator',
          requiredOutcome: 'complete',
          body: 'SKILL fix prompt for issue-17-fix-implementer-1\n',
        }),
      ],
      result: { stdout: '', stderr: '', status: 0 },
    },
    {
      args: ['pane', 'send-keys', 'new-pane', 'Return'],
      result: { stdout: '', stderr: '', status: 0 },
    },
  ]);

  daemonStep({
    cwd: worktreePath,
    statePath: '.agent/herdr-workflow-run.json',
    handleStatePath: '.agent/herdr-implement.json',
    runner,
    now: () => new Date('2026-06-30T12:34:56.000Z'),
  });

  const handleState = readDaemonHandleState(handleStatePath);
  assert.equal(handleState?.roleAgents.implementer.paneId, 'new-pane');
  assert.equal(handleState?.roleAgents.implementer.agentName, 'issue-17-implementer-issue-17-fix-implementer-1');
});

test('daemon step does not dispatch a duplicate pending agent run after recovery', async () => {
  const repo = await makeRepo();
  const worktreePath = join(repo, 'issue-worktree');
  await makeAgentWorkflowFixture(worktreePath);
  const runStatePath = join(worktreePath, '.agent/herdr-workflow-run.json');
  const handleStatePath = join(worktreePath, '.agent/herdr-implement.json');
  writeWorkflowRunState(runStatePath, {
    ...agentWorkflowStateFixture(worktreePath, 17, 'implement'),
    pendingAgentRun: {
      runId: 'issue-17-implement-implementer-1',
      phaseId: 'implement',
      roleId: 'implementer',
      completionRole: 'implementer',
      roleLabel: 'implementer',
      agentName: 'issue-17-implementer',
      resultSchema: null,
      resultPath: join(worktreePath, '.agent/runs/issue-17-implement-implementer-1/result.json'),
      notifyTarget: 'issue-17-orchestrator',
      attemptNumber: 1,
      startedAt: '2026-06-30T12:00:00.000Z',
      status: 'pending',
    },
  });
  writeDaemonHandleState(handleStatePath, handleStateFixture(worktreePath, 17, 'tab-1', 'pane-1'));

  const result = daemonStep({
    cwd: worktreePath,
    statePath: '.agent/herdr-workflow-run.json',
    handleStatePath: '.agent/herdr-implement.json',
    runner: createRunner([
      {
        args: ['agent', 'get', 'issue-17-implementer'],
        result: agentGetResult('working', 17),
      },
    ]),
    now: () => new Date('2026-06-30T12:34:56.000Z'),
  });

  assert.equal(result.status, 'sleep');
  assert.match(result.reason ?? '', /waiting on agent run issue-17-implement-implementer-1/);
  assert.equal(readWorkflowRunState(runStatePath)?.pendingAgentRun?.runId, 'issue-17-implement-implementer-1');
});

test('daemon step accepts a valid result artifact and routes by outcome', async () => {
  const repo = await makeRepo();
  const worktreePath = join(repo, 'issue-worktree');
  await makeCompletionWorkflowFixture(worktreePath);
  const runStatePath = join(worktreePath, '.agent/herdr-workflow-run.json');
  const handleStatePath = join(worktreePath, '.agent/herdr-implement.json');
  const pendingRun = pendingCompletionRun(worktreePath);
  writeWorkflowRunState(runStatePath, {
    ...completionWorkflowStateFixture(worktreePath, 18),
    pendingAgentRun: pendingRun,
  });
  writeDaemonHandleState(handleStatePath, completionHandleState(worktreePath));
  writeResultArtifact(pendingRun.resultPath, validCompletionArtifact(pendingRun));

  const result = daemonStep({
    cwd: worktreePath,
    statePath: '.agent/herdr-workflow-run.json',
    handleStatePath: '.agent/herdr-implement.json',
    runner: createRunner([]),
    now: () => new Date('2026-06-30T12:34:56.000Z'),
  });

  assert.equal(result.status, 'continue');
  assert.equal(result.currentPhase, 'implement');
  assert.equal(result.nextPhase, 'next');
  const runState = readWorkflowRunState(runStatePath);
  assert.equal(runState?.currentPhase, 'next');
  assert.equal(runState?.pendingAgentRun, null);
  assert.equal(runState?.context.reviewFindings, 'none');
  assert.equal(runState?.acceptedAgentRuns[pendingRun.runId].outcome, 'complete');
  assert.equal(runState?.acceptedAgentRuns[pendingRun.runId].summary, 'implemented completion routing');
});

test('daemon step accepts completion utility roles for custom workflow roles', async () => {
  const repo = await makeRepo();
  const worktreePath = join(repo, 'issue-worktree');
  await makeCompletionWorkflowFixture(worktreePath);
  const runStatePath = join(worktreePath, '.agent/herdr-workflow-run.json');
  const handleStatePath = join(worktreePath, '.agent/herdr-implement.json');
  const workflow = normalizeWorkflow({
    ...completionWorkflowFixture(),
    roles: {
      simplifier: {
        label: 'simplifier',
        agentNameTemplate: 'issue-{{ issue.number }}-simplifier',
        model: 'gpt-5.4-mini',
      },
    },
    phases: {
      setup: { type: 'terminal', status: 'complete' },
      simplify: {
        type: 'agent',
        role: 'simplifier',
        promptTemplate: 'implement.md',
        resultSchema: 'simplifier-result-v1',
        on: { complete: 'next', blocked: 'blocked' },
      },
      next: { type: 'terminal', status: 'complete' },
      blocked: { type: 'terminal', status: 'blocked' },
    },
  });
  const runId = 'issue-18-simplify-simplifier-1';
  const pendingRun = {
    runId,
    phaseId: 'simplify',
    roleId: 'simplifier',
    completionRole: 'implementer' as const,
    roleLabel: 'simplifier',
    agentName: 'issue-18-simplifier',
    resultSchema: 'simplifier-result-v1',
    resultPath: join(worktreePath, '.agent/runs', runId, 'result.json'),
    notifyTarget: 'issue-18-orchestrator',
    attemptNumber: 1,
    startedAt: '2026-06-30T12:00:00.000Z',
    status: 'pending' as const,
  };
  writeWorkflowRunState(runStatePath, {
    ...completionWorkflowStateFixture(worktreePath, 18, 'simplify'),
    workflow: workflow as never,
    pendingAgentRun: pendingRun,
  });
  writeDaemonHandleState(handleStatePath, completionHandleState(worktreePath));
  writeResultArtifact(pendingRun.resultPath, {
    ...validCompletionArtifact(pendingRun),
    role: 'implementer',
    resultSchema: 'simplifier-result-v1',
  });

  const result = daemonStep({
    cwd: worktreePath,
    statePath: '.agent/herdr-workflow-run.json',
    handleStatePath: '.agent/herdr-implement.json',
    runner: createRunner([]),
    now: () => new Date('2026-06-30T12:34:56.000Z'),
  });

  assert.equal(result.status, 'continue');
  assert.equal(result.nextPhase, 'next');
  const runState = readWorkflowRunState(runStatePath);
  assert.equal(runState?.acceptedAgentRuns[runId].roleId, 'simplifier');
  assert.equal(runState?.currentPhase, 'next');
});

test('daemon step rejects malformed result JSON and asks the same role to rewrite it', async () => {
  const repo = await makeRepo();
  const worktreePath = join(repo, 'issue-worktree');
  await makeCompletionWorkflowFixture(worktreePath);
  const runStatePath = join(worktreePath, '.agent/herdr-workflow-run.json');
  const handleStatePath = join(worktreePath, '.agent/herdr-implement.json');
  const pendingRun = pendingCompletionRun(worktreePath);
  writeWorkflowRunState(runStatePath, {
    ...completionWorkflowStateFixture(worktreePath, 18),
    pendingAgentRun: pendingRun,
  });
  writeDaemonHandleState(handleStatePath, completionHandleState(worktreePath));
  mkdirSync(dirname(pendingRun.resultPath), { recursive: true });
  writeFileSync(pendingRun.resultPath, '{not-json}\n', 'utf8');

  const result = daemonStep({
    cwd: worktreePath,
    statePath: '.agent/herdr-workflow-run.json',
    handleStatePath: '.agent/herdr-implement.json',
    runner: createRunner([
      {
        args: [
          'agent',
          'send',
          'issue-18-implementer',
          expectedRewritePrompt({
            runId: pendingRun.runId,
            phaseId: 'implement',
            roleId: 'implementer',
            resultPath: pendingRun.resultPath,
            reason: 'result artifact is not valid JSON: Expected property name or \'}\' in JSON at position 1 (line 1 column 2)',
          }),
        ],
        result: { stdout: '', stderr: '', status: 0 },
      },
      {
        args: ['pane', 'send-keys', 'pane-impl', 'Return'],
        result: { stdout: '', stderr: '', status: 0 },
      },
    ]),
    now: () => new Date('2026-06-30T12:34:56.000Z'),
  });

  assert.equal(result.status, 'sleep');
  assert.match(result.reason ?? '', /requested artifact rewrite/);
  assert.equal(readWorkflowRunState(runStatePath)?.context.lastArtifactRewriteRequest !== undefined, true);
});

const invalidArtifactCases = [
  {
    name: 'schema mismatch',
    artifact: { ...validCompletionArtifact(), resultSchema: 'wrong-schema' },
    reason: 'result artifact schema mismatch: expected implementer-result-v1, found wrong-schema',
  },
  {
    name: 'missing outcome',
    artifact: (() => {
      const artifact = { ...validCompletionArtifact() };
      delete (artifact as Record<string, unknown>).outcome;
      return artifact;
    })(),
    reason: 'result artifact is missing required completion fields',
  },
  {
    name: 'invalid capture',
    artifact: { ...validCompletionArtifact(), capture: ['bad'] },
    reason: 'result artifact capture must be an object with string keys',
  },
];

for (const item of invalidArtifactCases) {
  test(`daemon step rejects result artifacts with ${item.name}`, async () => {
    const repo = await makeRepo();
    const worktreePath = join(repo, 'issue-worktree');
    await makeCompletionWorkflowFixture(worktreePath);
    const runStatePath = join(worktreePath, '.agent/herdr-workflow-run.json');
    const handleStatePath = join(worktreePath, '.agent/herdr-implement.json');
    const pendingRun = pendingCompletionRun(worktreePath);
    writeWorkflowRunState(runStatePath, {
      ...completionWorkflowStateFixture(worktreePath, 18),
      pendingAgentRun: pendingRun,
    });
    writeDaemonHandleState(handleStatePath, completionHandleState(worktreePath));
    writeResultArtifact(pendingRun.resultPath, {
      ...item.artifact,
      runId: pendingRun.runId,
      phase: pendingRun.phaseId,
      role: pendingRun.roleId,
    });

    const result = daemonStep({
      cwd: worktreePath,
      statePath: '.agent/herdr-workflow-run.json',
      handleStatePath: '.agent/herdr-implement.json',
      runner: createRunner([
        {
          args: [
            'agent',
            'send',
            'issue-18-implementer',
            expectedRewritePrompt({
              runId: pendingRun.runId,
              phaseId: 'implement',
              roleId: 'implementer',
              resultPath: pendingRun.resultPath,
              reason: item.reason,
            }),
          ],
          result: { stdout: '', stderr: '', status: 0 },
        },
        {
          args: ['pane', 'send-keys', 'pane-impl', 'Return'],
          result: { stdout: '', stderr: '', status: 0 },
        },
      ]),
      now: () => new Date('2026-06-30T12:34:56.000Z'),
    });

    assert.equal(result.status, 'sleep');
    assert.equal(readWorkflowRunState(runStatePath)?.pendingAgentRun?.runId, pendingRun.runId);
  });
}

test('daemon step waits when the role agent is working and no artifact exists', async () => {
  const repo = await makeRepo();
  const worktreePath = join(repo, 'issue-worktree');
  await makeCompletionWorkflowFixture(worktreePath);
  const runStatePath = join(worktreePath, '.agent/herdr-workflow-run.json');
  const handleStatePath = join(worktreePath, '.agent/herdr-implement.json');
  const pendingRun = pendingCompletionRun(worktreePath);
  writeWorkflowRunState(runStatePath, {
    ...completionWorkflowStateFixture(worktreePath, 18),
    pendingAgentRun: pendingRun,
  });
  writeDaemonHandleState(handleStatePath, completionHandleState(worktreePath));

  const result = daemonStep({
    cwd: worktreePath,
    statePath: '.agent/herdr-workflow-run.json',
    handleStatePath: '.agent/herdr-implement.json',
    runner: createRunner([
      {
        args: ['agent', 'get', 'issue-18-implementer'],
        result: agentGetResult('working'),
      },
    ]),
    now: () => new Date('2026-06-30T12:34:56.000Z'),
  });

  assert.equal(result.status, 'sleep');
  assert.match(result.reason ?? '', /waiting on agent run/);
  assert.equal(readWorkflowRunState(runStatePath)?.pendingAgentRun?.runId, pendingRun.runId);
});

test('daemon step routes blocked when the role agent is blocked without an artifact', async () => {
  const repo = await makeRepo();
  const worktreePath = join(repo, 'issue-worktree');
  await makeCompletionWorkflowFixture(worktreePath);
  const runStatePath = join(worktreePath, '.agent/herdr-workflow-run.json');
  const handleStatePath = join(worktreePath, '.agent/herdr-implement.json');
  const pendingRun = pendingCompletionRun(worktreePath);
  writeWorkflowRunState(runStatePath, {
    ...completionWorkflowStateFixture(worktreePath, 18),
    pendingAgentRun: pendingRun,
  });
  writeDaemonHandleState(handleStatePath, completionHandleState(worktreePath));

  const result = daemonStep({
    cwd: worktreePath,
    statePath: '.agent/herdr-workflow-run.json',
    handleStatePath: '.agent/herdr-implement.json',
    runner: createRunner([
      {
        args: ['agent', 'get', 'issue-18-implementer'],
        result: agentGetResult('blocked'),
      },
    ]),
    now: () => new Date('2026-06-30T12:34:56.000Z'),
  });

  assert.equal(result.status, 'continue');
  assert.equal(result.nextPhase, 'blocked');
  const runState = readWorkflowRunState(runStatePath);
  assert.equal(runState?.currentPhase, 'blocked');
  assert.equal(runState?.pendingAgentRun, null);
  assert.equal((runState?.context.blockedAgentObservation as Record<string, unknown>).agentName, 'issue-18-implementer');
});

test('daemon step inspects an idle agent once and requests the missing artifact', async () => {
  const repo = await makeRepo();
  const worktreePath = join(repo, 'issue-worktree');
  await makeCompletionWorkflowFixture(worktreePath);
  const runStatePath = join(worktreePath, '.agent/herdr-workflow-run.json');
  const handleStatePath = join(worktreePath, '.agent/herdr-implement.json');
  const pendingRun = pendingCompletionRun(worktreePath);
  writeWorkflowRunState(runStatePath, {
    ...completionWorkflowStateFixture(worktreePath, 18),
    pendingAgentRun: pendingRun,
  });
  writeDaemonHandleState(handleStatePath, completionHandleState(worktreePath));

  const result = daemonStep({
    cwd: worktreePath,
    statePath: '.agent/herdr-workflow-run.json',
    handleStatePath: '.agent/herdr-implement.json',
    runner: createRunner([
      {
        args: ['agent', 'get', 'issue-18-implementer'],
        result: agentGetResult('idle'),
      },
      {
        args: ['agent', 'read', 'issue-18-implementer'],
        result: { stdout: 'finished but forgot artifact\n', stderr: '', status: 0 },
      },
      {
        args: [
          'agent',
          'send',
          'issue-18-implementer',
          expectedRewritePrompt({
            runId: pendingRun.runId,
            phaseId: 'implement',
            roleId: 'implementer',
            resultPath: pendingRun.resultPath,
            reason: 'agent is idle without a valid result artifact',
          }),
        ],
        result: { stdout: '', stderr: '', status: 0 },
      },
      {
        args: ['pane', 'send-keys', 'pane-impl', 'Return'],
        result: { stdout: '', stderr: '', status: 0 },
      },
    ]),
    now: () => new Date('2026-06-30T12:34:56.000Z'),
  });

  assert.equal(result.status, 'sleep');
  const runState = readWorkflowRunState(runStatePath);
  assert.equal((runState?.context.idleAgentRecovery as Record<string, unknown>).transcript, 'finished but forgot artifact');
  assert.equal((runState?.context.lastArtifactRewriteRequest as Record<string, unknown>).reason, 'agent is idle without a valid result artifact');
});

test('daemon step routes blocked when an idle agent still has no artifact after transcript recovery', async () => {
  const repo = await makeRepo();
  const worktreePath = join(repo, 'issue-worktree');
  await makeCompletionWorkflowFixture(worktreePath);
  const runStatePath = join(worktreePath, '.agent/herdr-workflow-run.json');
  const handleStatePath = join(worktreePath, '.agent/herdr-implement.json');
  const pendingRun = pendingCompletionRun(worktreePath);
  writeWorkflowRunState(runStatePath, {
    ...completionWorkflowStateFixture(worktreePath, 18),
    pendingAgentRun: pendingRun,
    context: {
      idleAgentRecovery: {
        runId: pendingRun.runId,
        transcript: 'already inspected',
      },
    },
  });
  writeDaemonHandleState(handleStatePath, completionHandleState(worktreePath));

  const result = daemonStep({
    cwd: worktreePath,
    statePath: '.agent/herdr-workflow-run.json',
    handleStatePath: '.agent/herdr-implement.json',
    runner: createRunner([
      {
        args: ['agent', 'get', 'issue-18-implementer'],
        result: agentGetResult('idle'),
      },
    ]),
    now: () => new Date('2026-06-30T12:34:56.000Z'),
  });

  assert.equal(result.status, 'continue');
  assert.equal(result.nextPhase, 'blocked');
  assert.equal(readWorkflowRunState(runStatePath)?.currentPhase, 'blocked');
});

test('daemon step recovers agent targets from handle state before routing missing agents blocked', async () => {
  const repo = await makeRepo();
  const worktreePath = join(repo, 'issue-worktree');
  await makeCompletionWorkflowFixture(worktreePath);
  const runStatePath = join(worktreePath, '.agent/herdr-workflow-run.json');
  const handleStatePath = join(worktreePath, '.agent/herdr-implement.json');
  const pendingRun = {
    ...pendingCompletionRun(worktreePath),
    agentName: null,
  };
  writeWorkflowRunState(runStatePath, {
    ...completionWorkflowStateFixture(worktreePath, 18),
    pendingAgentRun: pendingRun,
  });
  writeDaemonHandleState(handleStatePath, completionHandleState(worktreePath));

  const result = daemonStep({
    cwd: worktreePath,
    statePath: '.agent/herdr-workflow-run.json',
    handleStatePath: '.agent/herdr-implement.json',
    runner: createRunner([
      {
        args: ['agent', 'get', 'issue-18-implementer'],
        result: { stdout: '', stderr: 'missing', status: 1 },
      },
    ]),
    now: () => new Date('2026-06-30T12:34:56.000Z'),
  });

  assert.equal(result.status, 'continue');
  assert.equal(result.nextPhase, 'blocked');
  assert.equal(readWorkflowRunState(runStatePath)?.currentPhase, 'blocked');
});

test('daemon step routes blocked when no agent target can be resolved', async () => {
  const repo = await makeRepo();
  const worktreePath = join(repo, 'issue-worktree');
  await makeCompletionWorkflowFixture(worktreePath);
  const runStatePath = join(worktreePath, '.agent/herdr-workflow-run.json');
  const handleStatePath = join(worktreePath, '.agent/herdr-implement.json');
  const pendingRun = {
    ...pendingCompletionRun(worktreePath),
    agentName: null,
  };
  const state = completionWorkflowStateFixture(worktreePath, 18);
  const workflow = normalizeWorkflow(completionWorkflowFixture());
  delete (workflow.roles.implementer as Record<string, unknown>).agentNameTemplate;
  state.workflow = workflow as never;
  writeWorkflowRunState(runStatePath, {
    ...state,
    pendingAgentRun: pendingRun,
  });
  writeDaemonHandleState(handleStatePath, handleStateFixture(worktreePath, 18, 'tab-daemon', 'pane-daemon'));

  const result = daemonStep({
    cwd: worktreePath,
    statePath: '.agent/herdr-workflow-run.json',
    handleStatePath: '.agent/herdr-implement.json',
    runner: createRunner([]),
    now: () => new Date('2026-06-30T12:34:56.000Z'),
  });

  assert.equal(result.status, 'continue');
  assert.equal(result.nextPhase, 'blocked');
  assert.equal(readWorkflowRunState(runStatePath)?.currentPhase, 'blocked');
});

test('daemon step ignores duplicate completions for an already accepted run', async () => {
  const repo = await makeRepo();
  const worktreePath = join(repo, 'issue-worktree');
  await makeCompletionWorkflowFixture(worktreePath);
  const runStatePath = join(worktreePath, '.agent/herdr-workflow-run.json');
  const handleStatePath = join(worktreePath, '.agent/herdr-implement.json');
  const pendingRun = pendingCompletionRun(worktreePath);
  writeWorkflowRunState(runStatePath, {
    ...completionWorkflowStateFixture(worktreePath, 18),
    pendingAgentRun: pendingRun,
    acceptedAgentRuns: {
      [pendingRun.runId]: {
        runId: pendingRun.runId,
        phaseId: 'implement',
        roleId: 'implementer',
        roleLabel: 'implementer',
        agentName: 'issue-18-implementer',
        resultSchema: 'implementer-result-v1',
        resultPath: pendingRun.resultPath,
        acceptedAt: '2026-06-30T12:01:00.000Z',
        status: 'complete',
        outcome: 'complete',
        summary: 'already accepted',
        capture: null,
      },
    },
  });
  writeDaemonHandleState(handleStatePath, completionHandleState(worktreePath));
  writeResultArtifact(pendingRun.resultPath, validCompletionArtifact(pendingRun));

  const result = daemonStep({
    cwd: worktreePath,
    statePath: '.agent/herdr-workflow-run.json',
    handleStatePath: '.agent/herdr-implement.json',
    runner: createRunner([]),
    now: () => new Date('2026-06-30T12:34:56.000Z'),
  });

  assert.equal(result.status, 'sleep');
  assert.equal(result.nextPhase, 'next');
  assert.match(result.reason ?? '', /duplicate completion ignored/);
  const runState = readWorkflowRunState(runStatePath);
  assert.equal(runState?.pendingAgentRun, null);
  assert.equal(runState?.currentPhase, 'next');
});

test('daemon step rejects stale completions for non-active run ids', async () => {
  const repo = await makeRepo();
  const worktreePath = join(repo, 'issue-worktree');
  await makeCompletionWorkflowFixture(worktreePath);
  const runStatePath = join(worktreePath, '.agent/herdr-workflow-run.json');
  const handleStatePath = join(worktreePath, '.agent/herdr-implement.json');
  const pendingRun = pendingCompletionRun(worktreePath);
  writeWorkflowRunState(runStatePath, {
    ...completionWorkflowStateFixture(worktreePath, 18),
    pendingAgentRun: pendingRun,
  });
  writeDaemonHandleState(handleStatePath, completionHandleState(worktreePath));
  writeResultArtifact(pendingRun.resultPath, {
    ...validCompletionArtifact(pendingRun),
    runId: 'issue-18-old-run-1',
  });

  const result = daemonStep({
    cwd: worktreePath,
    statePath: '.agent/herdr-workflow-run.json',
    handleStatePath: '.agent/herdr-implement.json',
    runner: createRunner([
      {
        args: [
          'agent',
          'send',
          'issue-18-implementer',
          expectedRewritePrompt({
            runId: pendingRun.runId,
            phaseId: 'implement',
            roleId: 'implementer',
            resultPath: pendingRun.resultPath,
            reason: 'result artifact runId mismatch: expected issue-18-implement-implementer-1, found issue-18-old-run-1',
          }),
        ],
        result: { stdout: '', stderr: '', status: 0 },
      },
      {
        args: ['pane', 'send-keys', 'pane-impl', 'Return'],
        result: { stdout: '', stderr: '', status: 0 },
      },
    ]),
    now: () => new Date('2026-06-30T12:34:56.000Z'),
  });

  assert.equal(result.status, 'sleep');
  assert.match(result.reason ?? '', /requested artifact rewrite/);
  assert.equal(readWorkflowRunState(runStatePath)?.pendingAgentRun?.runId, pendingRun.runId);
});

test('daemon step does not persist a pending run when agent send fails', async () => {
  const repo = await makeRepo();
  const worktreePath = join(repo, 'issue-worktree');
  await makeAgentWorkflowFixture(worktreePath);
  const runStatePath = join(worktreePath, '.agent/herdr-workflow-run.json');
  const handleStatePath = join(worktreePath, '.agent/herdr-implement.json');
  writeWorkflowRunState(runStatePath, agentWorkflowStateFixture(worktreePath, 17, 'fix'));
  writeDaemonHandleState(handleStatePath, {
    ...handleStateFixture(worktreePath, 17, 'tab-1', 'pane-1'),
    roleAgents: {
      implementer: {
        roleId: 'implementer',
        roleLabel: 'implementer',
        agentName: 'issue-17-implementer',
        tabId: 'tab-impl',
        paneId: 'pane-impl',
        terminalId: 'term-impl',
        createdAt: '2026-06-30T12:00:00.000Z',
        updatedAt: '2026-06-30T12:00:00.000Z',
      },
    },
  });

  const runner = createRunner([
    {
      args: [
        'agent',
        'send',
        'issue-17-implementer',
        expectedAgentPrompt({
          runId: 'issue-17-fix-implementer-1',
          phaseId: 'fix',
          roleId: 'implementer',
          resultPath: join(worktreePath, '.agent/runs/issue-17-fix-implementer-1/result.json'),
          notifyTarget: 'issue-17-orchestrator',
          requiredOutcome: 'complete',
          body: 'SKILL fix prompt for issue-17-fix-implementer-1\n',
        }),
      ],
      result: { stdout: '', stderr: 'send failed', status: 1 },
    },
  ]);

  assert.throws(
    () =>
      daemonStep({
        cwd: worktreePath,
        statePath: '.agent/herdr-workflow-run.json',
        handleStatePath: '.agent/herdr-implement.json',
        runner,
        now: () => new Date('2026-06-30T12:34:56.000Z'),
      }),
    /herdr agent send failed/,
  );

  assert.equal(readWorkflowRunState(runStatePath)?.pendingAgentRun, null);
});
