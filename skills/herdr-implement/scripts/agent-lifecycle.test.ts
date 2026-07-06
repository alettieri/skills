import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { advanceAgentWorkOnce, type AgentLifecycleOptions } from './agent-lifecycle.ts';
import type { HerdrAdapter } from './herdr-adapter.ts';
import { normalizeWorkflow } from './workflow.ts';
import type { DaemonHandleState, WorkflowRunState } from './runtime.ts';

function workflowFixture(): Record<string, unknown> {
  return {
    name: 'agent-lifecycle',
    version: 1,
    type: 'herdr.issue',
    start: 'implement',
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
      implement: {
        type: 'agent',
        role: 'implementer',
        promptTemplate: 'implement.md',
        resultSchema: 'implementer-result-v1',
        on: { complete: 'done', blocked: 'blocked' },
      },
      done: { type: 'terminal', status: 'complete' },
      blocked: { type: 'terminal', status: 'blocked' },
    },
  };
}

function baseState(worktreePath: string): WorkflowRunState {
  return {
    schemaVersion: 1,
    issue: {
      input: '#21',
      number: 21,
      url: null,
      canonical: '#21',
    },
    workflowPath: join(worktreePath, '.agent/herdr-workflow.yaml'),
    workflow: normalizeWorkflow(workflowFixture()) as never,
    sourceRepo: {
      rootPath: worktreePath,
      remoteUrl: null,
      currentBranch: 'main',
      baseBranch: 'main',
    },
    branchName: 'issue-21-herdr-implement',
    worktreePath,
    workspaceId: 'w21',
    currentPhase: 'implement',
    context: {},
    pendingAgentRun: null,
    acceptedAgentRuns: {},
    scriptRuns: {},
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
    daemonHandlePath: join(worktreePath, '.agent/herdr-implement.json'),
    daemon: {
      tabId: null,
      paneId: null,
      command: null,
      startedAt: null,
    },
  };
}

function baseHandleState(worktreePath: string): DaemonHandleState {
  return {
    schemaVersion: 1,
    runStatePath: join(worktreePath, '.agent/herdr-workflow-run.json'),
    workspaceId: 'w21',
    worktreePath,
    daemonTabId: null,
    daemonPaneId: null,
    daemonCommand: 'node skills/herdr-implement/scripts/daemon.ts',
    roleAgents: {},
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
  };
}

function createAdapter(overrides: Partial<HerdrAdapter> = {}): HerdrAdapter {
  return {
    ensureWorktree() {
      throw new Error('not used');
    },
    createDaemonPane() {
      throw new Error('not used');
    },
    runPaneCommand() {},
    launchRoleAgent() {
      return {
        tabId: 'tab-1',
        paneId: 'pane-1',
        terminalId: 'term-1',
      };
    },
    sendPrompt() {},
    submitPrompt() {},
    getAgentStatus() {
      return {
        agentName: 'issue-21-implementer',
        paneId: 'pane-1',
        tabId: 'tab-1',
        terminalId: 'term-1',
        status: 'working',
        rawStatus: null,
        failure: null,
      };
    },
    readAgentTranscript() {
      return '';
    },
    ...overrides,
  };
}

async function tempWorktree(): Promise<string> {
  const worktreePath = await mkdtemp(join(tmpdir(), 'herdr-agent-lifecycle-'));
  await mkdir(join(worktreePath, '.agent/prompts'), { recursive: true });
  await mkdir(join(worktreePath, '.agent/runs'), { recursive: true });
  await writeFile(join(worktreePath, '.agent/herdr-workflow.yaml'), JSON.stringify(workflowFixture(), null, 2), 'utf8');
  await writeFile(
    join(worktreePath, '.agent/prompts/implement.md'),
    'Prompt for {{ runId }} at {{ resultPath }} with {{ completionUtility }}\n',
    'utf8',
  );
  return worktreePath;
}

function invoke(options: Omit<AgentLifecycleOptions, 'cwd'> & { cwd: string }): ReturnType<typeof advanceAgentWorkOnce> {
  return advanceAgentWorkOnce(options);
}

test('advanceAgentWorkOnce launches a role agent and records a pending run', async () => {
  const worktreePath = await tempWorktree();
  const calls: Array<{ type: string; args: unknown[] }> = [];
  const result = invoke({
    cwd: worktreePath,
    state: baseState(worktreePath),
    handleState: baseHandleState(worktreePath),
    adapter: createAdapter({
      launchRoleAgent(...args: Parameters<HerdrAdapter['launchRoleAgent']>) {
        calls.push({ type: 'launchRoleAgent', args });
        return { tabId: 'tab-2', paneId: 'pane-2', terminalId: 'term-2' };
      },
      sendPrompt(agentName: string, prompt: string) {
        calls.push({ type: 'sendPrompt', args: [agentName, prompt] });
      },
      submitPrompt(paneId: string) {
        calls.push({ type: 'submitPrompt', args: [paneId] });
      },
    }),
    now: () => new Date('2026-07-05T01:00:00.000Z'),
  });

  assert.equal(result.result.status, 'sleep');
  assert.equal(result.state.pendingAgentRun?.runId, 'issue-21-implement-implementer-1');
  assert.equal(result.state.pendingAgentRun?.status, 'pending');
  assert.equal(result.handleState.roleAgents.implementer.agentName, 'issue-21-implementer');
  assert.equal(calls[0]?.type, 'launchRoleAgent');
  assert.equal(calls[1]?.type, 'sendPrompt');
  assert.equal(calls[2]?.type, 'submitPrompt');
});

test('advanceAgentWorkOnce uses a fresh attempt number when revisiting the same agent phase', async () => {
  const worktreePath = await tempWorktree();
  const firstRunId = 'issue-21-implement-implementer-1';
  const secondRunId = 'issue-21-implement-implementer-2';
  const resultPath = join(worktreePath, '.agent/runs', secondRunId, 'result.json');
  await mkdir(join(worktreePath, '.agent/runs', secondRunId), { recursive: true });

  const calls: Array<{ type: string; args: unknown[] }> = [];
  // Pretend the first visit already completed so the second visit must move
  // forward to a new run id instead of reusing the accepted one.
  const firstResult = invoke({
    cwd: worktreePath,
    state: {
      ...baseState(worktreePath),
      acceptedAgentRuns: {
        [firstRunId]: {
          runId: firstRunId,
          phaseId: 'implement',
          roleId: 'implementer',
          roleLabel: 'implementer',
          agentName: 'issue-21-implementer',
          resultSchema: 'implementer-result-v1',
          resultPath: join(worktreePath, '.agent/runs', firstRunId, 'result.json'),
          acceptedAt: '2026-07-05T01:00:00.000Z',
          status: 'complete',
          outcome: 'complete',
          summary: 'first visit complete',
          capture: null,
        },
      },
    },
    handleState: baseHandleState(worktreePath),
    adapter: createAdapter({
      launchRoleAgent(...args: Parameters<HerdrAdapter['launchRoleAgent']>) {
        calls.push({ type: 'launchRoleAgent', args });
        return { tabId: 'tab-2', paneId: 'pane-2', terminalId: 'term-2' };
      },
      sendPrompt(agentName: string, prompt: string) {
        calls.push({ type: 'sendPrompt', args: [agentName, prompt] });
      },
      submitPrompt(paneId: string) {
        calls.push({ type: 'submitPrompt', args: [paneId] });
      },
      getAgentStatus() {
        throw new Error('not expected during dispatch');
      },
    }),
    now: () => new Date('2026-07-05T01:30:00.000Z'),
  });

  assert.equal(firstResult.state.pendingAgentRun?.runId, secondRunId);
  assert.equal(firstResult.state.pendingAgentRun?.attemptNumber, 2);
  assert.match(String(calls[1]?.args[1] ?? ''), /issue-21-implement-implementer-2/);

  await writeFile(
    resultPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        runId: secondRunId,
        role: 'implementer',
        phase: 'implement',
        resultSchema: 'implementer-result-v1',
        status: 'blocked',
        outcome: 'blocked',
        summary: 'second visit blocked',
      },
      null,
      2,
    ),
    'utf8',
  );

  const secondResult = invoke({
    cwd: worktreePath,
    state: firstResult.state,
    handleState: firstResult.handleState,
    adapter: createAdapter({
      getAgentStatus() {
        throw new Error('not expected when artifact exists');
      },
    }),
    now: () => new Date('2026-07-05T01:45:00.000Z'),
  });

  assert.equal(secondResult.result.status, 'continue');
  assert.equal(secondResult.result.nextPhase, 'blocked');
  assert.equal(secondResult.state.acceptedAgentRuns[secondRunId].outcome, 'blocked');
  assert.equal(secondResult.state.pendingAgentRun, null);
});

test('advanceAgentWorkOnce accepts a valid completion artifact and merges capture', async () => {
  const worktreePath = await tempWorktree();
  const runId = 'issue-21-implement-implementer-1';
  const resultPath = join(worktreePath, '.agent/runs', runId, 'result.json');
  await mkdir(join(worktreePath, '.agent/runs', runId), { recursive: true });
  await writeFile(
    resultPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        runId,
        role: 'implementer',
        phase: 'implement',
        resultSchema: 'implementer-result-v1',
        status: 'complete',
        outcome: 'complete',
        summary: 'done',
        capture: { merged: 'yes' },
      },
      null,
      2,
    ),
    'utf8',
  );

  const result = invoke({
    cwd: worktreePath,
    state: {
      ...baseState(worktreePath),
      pendingAgentRun: {
        runId,
        phaseId: 'implement',
        roleId: 'implementer',
        completionRole: 'implementer',
        roleLabel: 'implementer',
        agentName: 'issue-21-implementer',
        resultSchema: 'implementer-result-v1',
        resultPath,
        notifyTarget: 'issue-21-orchestrator',
        attemptNumber: 1,
        startedAt: '2026-07-05T01:00:00.000Z',
        status: 'pending',
      },
    },
    handleState: baseHandleState(worktreePath),
    adapter: createAdapter({
      getAgentStatus() {
        throw new Error('not expected when artifact exists');
      },
    }),
    now: () => new Date('2026-07-05T02:00:00.000Z'),
  });

  assert.equal(result.result.status, 'continue');
  assert.equal(result.result.nextPhase, 'done');
  assert.equal(result.state.pendingAgentRun, null);
  assert.equal(result.state.currentPhase, 'done');
  assert.equal((result.state.context.merged as string), 'yes');
  assert.equal(result.state.acceptedAgentRuns[runId].outcome, 'complete');
});

test('advanceAgentWorkOnce requests rewrite for malformed artifacts', async () => {
  const worktreePath = await tempWorktree();
  const runId = 'issue-21-implement-implementer-1';
  const resultPath = join(worktreePath, '.agent/runs', runId, 'result.json');
  await mkdir(join(worktreePath, '.agent/runs', runId), { recursive: true });
  await writeFile(resultPath, '{not-json}', 'utf8');

  let sentPrompt = '';
  const result = invoke({
    cwd: worktreePath,
    state: {
      ...baseState(worktreePath),
      pendingAgentRun: {
        runId,
        phaseId: 'implement',
        roleId: 'implementer',
        completionRole: 'implementer',
        roleLabel: 'implementer',
        agentName: 'issue-21-implementer',
        resultSchema: 'implementer-result-v1',
        resultPath,
        notifyTarget: 'issue-21-orchestrator',
        attemptNumber: 1,
        startedAt: '2026-07-05T01:00:00.000Z',
        status: 'pending',
      },
    },
    handleState: baseHandleState(worktreePath),
    adapter: createAdapter({
      sendPrompt(_agentName: string, prompt: string) {
        sentPrompt = prompt;
      },
      submitPrompt() {},
    }),
    now: () => new Date('2026-07-05T03:00:00.000Z'),
  });

  assert.equal(result.result.status, 'sleep');
  assert.match(sentPrompt, /result artifact at .* is invalid/);
  assert.equal((result.state.context.lastArtifactRewriteRequest as Record<string, unknown>).runId, runId);
});
