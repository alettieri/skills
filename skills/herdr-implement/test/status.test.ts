import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { normalizeWorkflow } from '../src/workflow.ts';
import { formatLiveRunStatus, readLiveRunStatus } from '../src/status.ts';
import {
  WORKFLOW_RUN_STATE_PATH,
  writeWorkflowRunState,
  type WorkflowRunState,
} from '../src/workflow-state-store.ts';

function workflowFixture(): Record<string, unknown> {
  return {
    name: 'status-workflow',
    version: 1,
    type: 'herdr.issue',
    start: 'implement',
    roleDefaults: {
      agent: 'codex',
      reuse: true,
      codex: {
        approval: 'on-request',
        sandbox: 'workspace-write',
      },
    },
    roles: {
      implementer: {
        label: 'implementer',
        agentNameTemplate: 'issue-{{ issue.slug }}-implementer',
        model: 'gpt-5.4-mini',
      },
    },
    phases: {
      implement: {
        type: 'agent',
        role: 'implementer',
        promptTemplate: 'implement.md',
        on: { complete: 'build' },
      },
      build: {
        type: 'script',
        command: 'workflow-scripts/build.sh',
        on: { success: 'watch' },
      },
      watch: {
        type: 'poll',
        command: 'workflow-scripts/watch.sh',
        intervalSeconds: 10,
        timeoutSeconds: 60,
        on: { success: 'done' },
      },
      done: {
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
      input: '#72',
      url: null,
      canonical: '#72',
      slug: '72',
    },
    workflowPath: join(worktreePath, '.agent/herdr-workflow.yaml'),
    workflow: normalizeWorkflow(workflowFixture()) as never,
    sourceRepo: {
      rootPath: worktreePath,
      remoteUrl: null,
      currentBranch: 'main',
      baseBranch: 'main',
    },
    branchName: 'issue-72-herdr-implement',
    worktreePath,
    workspaceId: 'w72',
    currentPhase: 'implement',
    context: {},
    pendingAgentRun: {
      runId: 'issue-72-implement-implementer-1',
      phaseId: 'implement',
      roleId: 'implementer',
      completionRole: 'implementer',
      roleLabel: 'implementer',
      agentName: 'issue-72-implementer',
      resultSchema: null,
      resultPath: join(worktreePath, '.agent/runs/issue-72-implement-implementer-1/result.json'),
      notifyTarget: 'issue-72-orchestrator',
      attemptNumber: 2,
      startedAt: '2026-07-12T12:00:00.000Z',
      status: 'pending',
    },
    acceptedAgentRuns: {
      'issue-72-implement-implementer-0': {
        runId: 'issue-72-implement-implementer-0',
        phaseId: 'implement',
        roleId: 'implementer',
        roleLabel: 'implementer',
        agentName: 'issue-72-implementer',
        resultSchema: null,
        resultPath: join(worktreePath, '.agent/runs/issue-72-implement-implementer-0/result.json'),
        acceptedAt: '2026-07-12T11:00:00.000Z',
        status: 'complete',
        outcome: 'complete',
        summary: 'implemented completion routing',
        capture: { pr_number: '72' },
      },
    },
    scriptRuns: {
      build: {
        phaseId: 'build',
        runId: 'issue-72-build-script',
        command: 'workflow-scripts/build.sh',
        resolvedCommandPath: join(worktreePath, '.agent/workflow-scripts/build.sh'),
        args: [],
        cwd: worktreePath,
        env: {},
        timeoutSeconds: 30,
        startedAt: '2026-07-12T11:30:00.000Z',
        finishedAt: '2026-07-12T11:31:00.000Z',
        durationMs: 60000,
        timedOut: false,
        exitCode: 0,
        signal: null,
        status: 'complete',
        outcome: 'success',
        capture: { artifact: 'ok' },
        stdout: 'ok\n',
        stderr: '',
        retryable: true,
        stdoutPath: join(worktreePath, '.agent/runs/issue-72-build-script/stdout.log'),
        stderrPath: join(worktreePath, '.agent/runs/issue-72-build-script/stderr.log'),
        rawOutputPath: join(worktreePath, '.agent/runs/issue-72-build-script/raw.log'),
      },
    },
    pollRuns: {
      watch: {
        runId: 'issue-72-watch-poll',
        phaseId: 'watch',
        command: 'workflow-scripts/watch.sh',
        resolvedCommandPath: join(worktreePath, '.agent/workflow-scripts/watch.sh'),
        args: [],
        cwd: worktreePath,
        env: {},
        intervalSeconds: 10,
        timeoutSeconds: 60,
        createdAt: '2026-07-12T11:40:00.000Z',
        startedAt: '2026-07-12T11:40:00.000Z',
        finishedAt: '2026-07-12T11:41:00.000Z',
        durationMs: 60000,
        nextWakeAt: '2026-07-12T11:50:00.000Z',
        tickCount: 3,
        timedOut: false,
        exitCode: null,
        signal: null,
        status: 'waiting',
        outcome: 'pending',
        capture: null,
        observation: null,
        fingerprint: 'abc123',
        stdout: '',
        stderr: '',
        stdoutPath: join(worktreePath, '.agent/runs/issue-72-watch-poll/stdout.log'),
        stderrPath: join(worktreePath, '.agent/runs/issue-72-watch-poll/stderr.log'),
        rawOutputPath: join(worktreePath, '.agent/runs/issue-72-watch-poll/raw.log'),
      },
    },
    createdAt: '2026-07-12T11:00:00.000Z',
    updatedAt: '2026-07-12T11:40:00.000Z',
    daemonHandlePath: join(worktreePath, '.agent/herdr-implement.json'),
    daemon: {
      tabId: 'tab-72',
      paneId: 'pane-72',
      command: 'node skills/herdr-implement/bin/daemon.ts',
      startedAt: '2026-07-12T11:05:00.000Z',
    },
  };
}

test('status command prints live run details from the workflow state store', () => {
  const worktreePath = mkdtempSync(join(tmpdir(), 'herdr-status-'));
  const runStatePath = join(worktreePath, WORKFLOW_RUN_STATE_PATH);
  writeWorkflowRunState(runStatePath, makeWorkflowRunState(worktreePath));

  const status = readLiveRunStatus(worktreePath);
  const output = formatLiveRunStatus(status);

  assert.match(output, /Issue: #72/);
  assert.match(output, /Current phase: implement \(agent\)/);
  assert.match(output, /Phase summary: issue-72-implement-implementer-1 role=implementer phase=implement status=pending attempt=2/);
  assert.match(output, /Accepted runs:/);
  assert.match(output, /- issue-72-implement-implementer-0 phase=implement role=implementer status=complete outcome=complete summary=implemented completion routing/);
  assert.match(output, /Script runs:/);
  assert.match(output, /- build status=complete outcome=success capture=yes/);
  assert.match(output, /Poll runs:/);
  assert.match(output, /- watch status=waiting outcome=pending/);
  assert.match(output, /Daemon tab: tab-72/);
  assert.match(output, /Daemon pane: pane-72/);
});

test('status entrypoint accepts --worktree and prints the live summary', () => {
  const worktreePath = mkdtempSync(join(tmpdir(), 'herdr-status-cli-'));
  const runStatePath = join(worktreePath, WORKFLOW_RUN_STATE_PATH);
  writeWorkflowRunState(runStatePath, makeWorkflowRunState(worktreePath));

  const cli = spawnSync(
    process.execPath,
    [join(process.cwd(), 'skills/herdr-implement/bin/status.ts'), '--worktree', worktreePath],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  );

  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /Issue: #72/);
  assert.match(cli.stdout, /Worktree: /);
  assert.match(cli.stdout, /Accepted runs:/);
  assert.match(cli.stdout, /Poll runs:/);
});
