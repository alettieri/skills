import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { normalizeWorkflow } from './workflow.ts';
import {
  DAEMON_HANDLE_STATE_PATH,
  WORKFLOW_RUN_STATE_PATH,
  readDaemonHandleState,
  readWorkflowRunState,
  writeDaemonHandleState,
  writeWorkflowRunState,
  type DaemonHandleState,
  type WorkflowRunState,
} from './workflow-state-store.ts';

function workflowFixture(): Record<string, unknown> {
  return {
    name: 'store-workflow',
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
    },
  };
}

function makeWorkflowRunState(worktreePath: string): WorkflowRunState {
  return {
    schemaVersion: 1,
    issue: {
      input: '#1',
      number: 1,
      url: null,
      canonical: '#1',
    },
    workflowPath: join(worktreePath, '.agent/herdr-workflow.yaml'),
    workflow: normalizeWorkflow(workflowFixture()) as never,
    sourceRepo: {
      rootPath: worktreePath,
      remoteUrl: null,
      currentBranch: 'main',
      baseBranch: 'main',
    },
    branchName: 'issue-1-herdr-implement',
    worktreePath,
    workspaceId: 'w1',
    currentPhase: 'setup',
    context: {},
    pendingAgentRun: null,
    acceptedAgentRuns: {},
    scriptRuns: {},
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
    daemonHandlePath: join(worktreePath, DAEMON_HANDLE_STATE_PATH),
    daemon: {
      tabId: null,
      paneId: null,
      command: null,
      startedAt: null,
    },
  };
}

function makeDaemonHandleState(worktreePath: string): DaemonHandleState {
  return {
    schemaVersion: 1,
    runStatePath: join(worktreePath, WORKFLOW_RUN_STATE_PATH),
    workspaceId: 'w1',
    worktreePath,
    daemonTabId: null,
    daemonPaneId: null,
    daemonCommand: 'node skills/herdr-implement/scripts/daemon.ts',
    roleAgents: {},
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
  };
}

function tempWorktree(): string {
  return mkdtempSync(join(tmpdir(), 'herdr-workflow-state-store-'));
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

test('read helpers return null for missing state files', () => {
  const worktreePath = tempWorktree();

  assert.equal(readWorkflowRunState(join(worktreePath, WORKFLOW_RUN_STATE_PATH)), null);
  assert.equal(readDaemonHandleState(join(worktreePath, DAEMON_HANDLE_STATE_PATH)), null);
});

test('read helpers reject malformed JSON and invalid schema versions', () => {
  const worktreePath = tempWorktree();
  const runStatePath = join(worktreePath, WORKFLOW_RUN_STATE_PATH);
  const handleStatePath = join(worktreePath, DAEMON_HANDLE_STATE_PATH);

  mkdirSync(dirname(runStatePath), { recursive: true });
  writeFileSync(runStatePath, '{"schemaVersion":1', 'utf8');
  assert.throws(() => readWorkflowRunState(runStatePath), /JSON|Unexpected token/i);

  mkdirSync(dirname(handleStatePath), { recursive: true });
  writeFileSync(handleStatePath, JSON.stringify({ schemaVersion: 2 }), 'utf8');
  assert.throws(() => readDaemonHandleState(handleStatePath), /invalid daemon handle state/);
});

test('readWorkflowRunState normalizes compatibility fields, context defaults, and script runs', () => {
  const worktreePath = tempWorktree();
  const runStatePath = join(worktreePath, WORKFLOW_RUN_STATE_PATH);
  const rawState = {
    schemaVersion: 1,
    issue: {
      input: '#7',
      number: 7,
      url: null,
      canonical: '#7',
    },
    workflowPath: join(worktreePath, '.agent/herdr-workflow.yaml'),
    workflow: normalizeWorkflow(workflowFixture()),
    sourceRepo: {
      rootPath: worktreePath,
      remoteUrl: null,
      currentBranch: 'main',
      baseBranch: 'main',
    },
    branchName: 'issue-7-herdr-implement',
    worktreePath,
    workspaceId: 'w7',
    currentPhase: 'setup',
    pendingAgentRun: {
      runId: 'issue-7-implement-implementer-1',
      phaseId: 'implement',
      roleId: 'implementer',
      roleLabel: 'implementer',
      agentName: 'issue-7-implementer',
      resultSchema: 'implementer-result-v1',
      resultPath: join(worktreePath, '.agent/runs/issue-7-implement-implementer-1/result.json'),
      notifyTarget: 'issue-7-orchestrator',
      attemptNumber: 1,
      startedAt: '2026-07-05T00:00:00.000Z',
      status: 'pending',
    },
    acceptedAgentRuns: {
      'issue-7-implement-implementer-0': {
        runId: 'issue-7-implement-implementer-0',
        phaseId: 'implement',
        roleId: 'implementer',
        roleLabel: 'implementer',
        agentName: 'issue-7-implementer',
        resultSchema: null,
        resultPath: join(worktreePath, '.agent/runs/issue-7-implement-implementer-0/result.json'),
        acceptedAt: '2026-07-05T00:00:00.000Z',
        status: 'complete',
        outcome: 'complete',
        summary: 'done',
        capture: { pr_number: '1' },
      },
    },
    scriptRuns: {
      setup: {
        phaseId: 'setup',
        runId: 'issue-7-setup-script',
        command: 'scripts/setup.sh',
        resolvedCommandPath: join(worktreePath, 'scripts/setup.sh'),
        args: ['7'],
        cwd: worktreePath,
        env: {},
        timeoutSeconds: 30,
        startedAt: '2026-07-05T00:00:00.000Z',
        finishedAt: '2026-07-05T00:00:01.000Z',
        durationMs: 1000,
        timedOut: false,
        exitCode: 0,
        signal: null,
        status: 'complete',
        outcome: 'success',
        capture: { greeting: 'hello' },
        stdout: 'ok\n',
        stderr: '',
        retryable: true,
        stdoutPath: join(worktreePath, '.agent/runs/issue-7-setup-script/stdout.log'),
        stderrPath: join(worktreePath, '.agent/runs/issue-7-setup-script/stderr.log'),
        rawOutputPath: join(worktreePath, '.agent/runs/issue-7-setup-script/raw.log'),
      },
    },
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
    daemonHandlePath: join(worktreePath, DAEMON_HANDLE_STATE_PATH),
    daemon: {
      tabId: null,
      paneId: null,
      command: null,
      startedAt: null,
    },
  };

  writeJsonFile(runStatePath, rawState);

  const state = readWorkflowRunState(runStatePath);
  assert.equal(state?.context && Object.keys(state.context).length, 0);
  assert.equal(state?.pendingAgentRun?.completionRole, 'implementer');
  assert.equal(state?.acceptedAgentRuns['issue-7-implement-implementer-0']?.summary, 'done');
  assert.equal(state?.scriptRuns.setup.outcome, 'success');
  assert.equal(state?.scriptRuns.setup.capture?.greeting, 'hello');
});

test('readWorkflowRunState rejects persisted script runs with invalid non-null exit codes', () => {
  const worktreePath = tempWorktree();
  const runStatePath = join(worktreePath, WORKFLOW_RUN_STATE_PATH);
  const rawState = {
    schemaVersion: 1,
    issue: {
      input: '#7',
      number: 7,
      url: null,
      canonical: '#7',
    },
    workflowPath: join(worktreePath, '.agent/herdr-workflow.yaml'),
    workflow: normalizeWorkflow(workflowFixture()),
    sourceRepo: {
      rootPath: worktreePath,
      remoteUrl: null,
      currentBranch: 'main',
      baseBranch: 'main',
    },
    branchName: 'issue-7-herdr-implement',
    worktreePath,
    workspaceId: 'w7',
    currentPhase: 'setup',
    pendingAgentRun: null,
    acceptedAgentRuns: {},
    scriptRuns: {
      setup: {
        phaseId: 'setup',
        runId: 'issue-7-setup-script',
        command: 'scripts/setup.sh',
        resolvedCommandPath: join(worktreePath, 'scripts/setup.sh'),
        args: ['7'],
        cwd: worktreePath,
        env: {},
        timeoutSeconds: 30,
        startedAt: '2026-07-05T00:00:00.000Z',
        finishedAt: '2026-07-05T00:00:01.000Z',
        durationMs: 1000,
        timedOut: false,
        exitCode: '1',
        signal: null,
        status: 'failed',
        outcome: 'failure',
        capture: null,
        stdout: 'failed\n',
        stderr: '',
        retryable: true,
        stdoutPath: join(worktreePath, '.agent/runs/issue-7-setup-script/stdout.log'),
        stderrPath: join(worktreePath, '.agent/runs/issue-7-setup-script/stderr.log'),
        rawOutputPath: join(worktreePath, '.agent/runs/issue-7-setup-script/raw.log'),
      },
    },
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
    daemonHandlePath: join(worktreePath, DAEMON_HANDLE_STATE_PATH),
    daemon: {
      tabId: null,
      paneId: null,
      command: null,
      startedAt: null,
    },
  };

  writeJsonFile(runStatePath, rawState);

  const state = readWorkflowRunState(runStatePath);
  assert.equal(state?.scriptRuns.setup, undefined);
});

test('readDaemonHandleState normalizes role agent maps', () => {
  const worktreePath = tempWorktree();
  const handleStatePath = join(worktreePath, DAEMON_HANDLE_STATE_PATH);
  const rawState = {
    schemaVersion: 1,
    runStatePath: join(worktreePath, WORKFLOW_RUN_STATE_PATH),
    workspaceId: 'w1',
    worktreePath,
    daemonTabId: 'tab-1',
    daemonPaneId: 'pane-1',
    daemonCommand: 'node skills/herdr-implement/scripts/daemon.ts',
    roleAgents: {
      implementer: {
        roleId: 'implementer',
        roleLabel: 'implementer',
        agentName: 'issue-1-implementer',
        tabId: 'tab-a',
        paneId: 'pane-a',
        terminalId: null,
        createdAt: '2026-07-05T00:00:00.000Z',
        updatedAt: '2026-07-05T00:00:01.000Z',
      },
      invalid: {
        roleId: 'invalid',
        agentName: 'missing-label',
      },
    },
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
  };

  writeJsonFile(handleStatePath, rawState);

  const state = readDaemonHandleState(handleStatePath);
  assert.equal(state?.daemonPaneId, 'pane-1');
  assert.equal(state?.roleAgents.implementer.roleLabel, 'implementer');
  assert.equal(state && Object.keys(state.roleAgents).length, 1);
});

test('write helpers round trip workflow and daemon handle state', () => {
  const worktreePath = tempWorktree();
  const runStatePath = join(worktreePath, WORKFLOW_RUN_STATE_PATH);
  const handleStatePath = join(worktreePath, DAEMON_HANDLE_STATE_PATH);
  const runState = makeWorkflowRunState(worktreePath);
  const handleState = makeDaemonHandleState(worktreePath);

  writeWorkflowRunState(runStatePath, runState);
  writeDaemonHandleState(handleStatePath, handleState);

  assert.deepEqual(readWorkflowRunState(runStatePath), runState);
  assert.deepEqual(readDaemonHandleState(handleStatePath), handleState);
});
