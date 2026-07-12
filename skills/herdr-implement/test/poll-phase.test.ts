import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { daemonStep, readWorkflowRunState, writeDaemonHandleState, writeWorkflowRunState, type WorkflowRunState } from '../src/runtime.ts';
import { normalizeWorkflow } from '../src/workflow.ts';
import type { DaemonHandleState } from '../src/workflow-state-store.ts';

function tempWorktree(): string {
  const worktreePath = mkdtempSync(join(tmpdir(), 'herdr-poll-phase-'));
  mkdirSync(join(worktreePath, '.agent'), { recursive: true });
  mkdirSync(join(worktreePath, '.agent/workflow-scripts'), { recursive: true });
  return worktreePath;
}

function writeExecutableScript(path: string, body: string): void {
  writeFileSync(path, `${body.trimEnd()}\n`, 'utf8');
  chmodSync(path, 0o755);
}

function pollWorkflowFixture(start: 'await_review' | 'await_merge' = 'await_review'): Record<string, unknown> {
  return {
    name: 'poll-workflow',
    version: 1,
    type: 'herdr.issue',
    start,
    roles: {},
    phases: {
      await_review: {
        type: 'poll',
        command: 'workflow-scripts/check-pr-review.sh',
        args: ['{{ context.pr_url }}', '{{ context.pr_number }}'],
        intervalSeconds: 60,
        timeoutSeconds: 30,
        on: {
          approved: 'approved',
          changes_requested: 'changes_requested',
          checks_failed: 'checks_failed',
          feedback: 'feedback',
          waiting: 'await_review',
          closed: 'closed',
          timeout: 'timeout',
          failure: 'failed',
        },
      },
      await_merge: {
        type: 'poll',
        command: 'workflow-scripts/check-pr-merged.sh',
        args: ['{{ context.pr_url }}', '{{ context.pr_number }}'],
        intervalSeconds: 60,
        timeoutSeconds: 30,
        on: {
          merged: 'merged',
          feedback: 'feedback',
          checks_failed: 'checks_failed',
          waiting: 'await_merge',
          closed: 'closed',
          timeout: 'timeout',
          failure: 'failed',
        },
      },
      approved: { type: 'terminal', status: 'complete' },
      changes_requested: { type: 'terminal', status: 'blocked' },
      checks_failed: { type: 'terminal', status: 'failed' },
      feedback: { type: 'terminal', status: 'blocked' },
      merged: { type: 'terminal', status: 'complete' },
      closed: { type: 'terminal', status: 'closed' },
      timeout: { type: 'terminal', status: 'blocked' },
      failed: { type: 'terminal', status: 'failed' },
    },
  };
}

function pollStateFixture(
  worktreePath: string,
  currentPhase: 'await_review' | 'await_merge' = 'await_review',
): WorkflowRunState {
  return {
    schemaVersion: 1,
    issue: {
      input: '#42',
      url: null,
      canonical: '#42',
      slug: '42',
    },
    workflowPath: join(worktreePath, '.agent/herdr-workflow.yaml'),
    workflow: normalizeWorkflow(pollWorkflowFixture(currentPhase)) as never,
    sourceRepo: {
      rootPath: worktreePath,
      remoteUrl: null,
      currentBranch: 'main',
      baseBranch: 'main',
    },
    branchName: 'issue-42-herdr-implement',
    worktreePath,
    workspaceId: 'w42',
    currentPhase,
    context: {
      pr_url: 'https://github.com/acme/repo/pull/42',
      pr_number: '42',
    },
    pendingAgentRun: null,
    acceptedAgentRuns: {},
    scriptRuns: {},
    pollRuns: {},
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

function handleStateFixture(worktreePath: string): DaemonHandleState {
  return {
    schemaVersion: 1,
    runStatePath: join(worktreePath, '.agent/herdr-workflow-run.json'),
    workspaceId: 'w42',
    worktreePath,
    daemonTabId: null,
    daemonPaneId: null,
    daemonCommand: 'node skills/herdr-implement/bin/daemon.ts',
    roleAgents: {},
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
  };
}

function installPollScript(worktreePath: string, name: string, body: string): string {
  const scriptPath = join(worktreePath, '.agent/workflow-scripts', name);
  writeExecutableScript(scriptPath, body);
  return scriptPath;
}

function writeState(worktreePath: string, state: WorkflowRunState): void {
  const runStatePath = join(worktreePath, '.agent/herdr-workflow-run.json');
  const handleStatePath = join(worktreePath, '.agent/herdr-implement.json');
  writeWorkflowRunState(runStatePath, state);
  writeDaemonHandleState(handleStatePath, handleStateFixture(worktreePath));
}

test('poll phases wait, reschedule, and recover unchanged observations', () => {
  const worktreePath = tempWorktree();
  installPollScript(
    worktreePath,
    'check-pr-review.sh',
    `#!/bin/sh
set -eu
count_file=".agent/poll-count.txt"
count=0
if [ -f "$count_file" ]; then
  count=$(cat "$count_file")
fi
count=$((count + 1))
printf '%s\n' "$count" > "$count_file"
printf 'waiting\n'
`,
  );
  writeState(worktreePath, pollStateFixture(worktreePath));

  const first = daemonStep({
    cwd: worktreePath,
    statePath: '.agent/herdr-workflow-run.json',
    handleStatePath: '.agent/herdr-implement.json',
    now: () => new Date('2026-07-05T00:00:00.000Z'),
  });

  assert.equal(first.status, 'sleep');
  assert.equal(first.currentPhase, 'await_review');
  assert.equal(readFileSync(join(worktreePath, '.agent/poll-count.txt'), 'utf8').trim(), '1');

  const firstState = readWorkflowRunState(join(worktreePath, '.agent/herdr-workflow-run.json'));
  assert.equal(firstState?.pollRuns?.await_review.status, 'waiting');
  assert.equal(firstState?.pollRuns?.await_review.tickCount, 1);
  assert.equal(firstState?.currentPhase, 'await_review');

  const second = daemonStep({
    cwd: worktreePath,
    statePath: '.agent/herdr-workflow-run.json',
    handleStatePath: '.agent/herdr-implement.json',
    now: () => new Date('2026-07-05T00:00:10.000Z'),
  });

  assert.equal(second.status, 'sleep');
  assert.equal(second.currentPhase, 'await_review');
  assert.equal(readFileSync(join(worktreePath, '.agent/poll-count.txt'), 'utf8').trim(), '1');

  const delayed = daemonStep({
    cwd: worktreePath,
    statePath: '.agent/herdr-workflow-run.json',
    handleStatePath: '.agent/herdr-implement.json',
    now: () => new Date('2026-07-05T00:01:01.000Z'),
  });

  assert.equal(delayed.status, 'sleep');
  assert.equal(delayed.currentPhase, 'await_review');
  assert.equal(readFileSync(join(worktreePath, '.agent/poll-count.txt'), 'utf8').trim(), '2');

  const delayedState = readWorkflowRunState(join(worktreePath, '.agent/herdr-workflow-run.json'));
  assert.equal(delayedState?.pollRuns?.await_review.tickCount, 2);
  assert.equal(delayedState?.pollRuns?.await_review.fingerprint, firstState?.pollRuns?.await_review.fingerprint);
});

test('poll review outcomes route through named transitions and merge capture', () => {
  const cases = [
    {
      name: 'approved',
      output: `#!/bin/sh
set -eu
printf '%s\n' '{"outcome":"approved","capture":{"pr_url":"https://example.test/pr/42","pr_number":"42","review_decision":"APPROVED"}}'
`,
      expectedPhase: 'approved',
      expectedOutcome: 'approved',
    },
    {
      name: 'changes_requested',
      output: `#!/bin/sh
set -eu
printf 'changes_requested\n'
`,
      expectedPhase: 'changes_requested',
      expectedOutcome: 'changes_requested',
    },
    {
      name: 'checks_failed',
      output: `#!/bin/sh
set -eu
printf 'checks_failed\n'
`,
      expectedPhase: 'checks_failed',
      expectedOutcome: 'checks_failed',
    },
    {
      name: 'feedback',
      output: `#!/bin/sh
set -eu
printf 'feedback\n'
`,
      expectedPhase: 'feedback',
      expectedOutcome: 'feedback',
    },
    {
      name: 'closed',
      output: `#!/bin/sh
set -eu
printf 'closed\n'
`,
      expectedPhase: 'closed',
      expectedOutcome: 'closed',
    },
  ] as const;

  for (const currentCase of cases) {
    const worktreePath = tempWorktree();
    installPollScript(worktreePath, 'check-pr-review.sh', currentCase.output);
    writeState(worktreePath, pollStateFixture(worktreePath));

    const result = daemonStep({
      cwd: worktreePath,
      statePath: '.agent/herdr-workflow-run.json',
      handleStatePath: '.agent/herdr-implement.json',
      now: () => new Date('2026-07-05T00:00:00.000Z'),
    });

    assert.equal(result.status, 'continue');
    assert.equal(result.nextPhase, currentCase.expectedPhase);
    const state = readWorkflowRunState(join(worktreePath, '.agent/herdr-workflow-run.json'));
    assert.equal(state?.currentPhase, currentCase.expectedPhase);
    assert.equal(state?.pollRuns?.await_review.outcome, currentCase.expectedOutcome);
    if (currentCase.name === 'approved') {
      assert.equal(state?.context.pr_url, 'https://example.test/pr/42');
      assert.equal(state?.context.pr_number, '42');
      assert.equal(state?.context.review_decision, 'APPROVED');
    }
  }
});

test('poll review handles malformed JSON and invalid capture as failures', () => {
  const cases = [
    {
      name: 'invalid-json',
      output: `#!/bin/sh
set -eu
printf '%s\n' '{not-json}'
`,
    },
    {
      name: 'invalid-capture',
      output: `#!/bin/sh
set -eu
printf '%s\n' '{"outcome":"approved","capture":[]}'
`,
    },
  ] as const;

  for (const currentCase of cases) {
    const worktreePath = tempWorktree();
    installPollScript(worktreePath, 'check-pr-review.sh', currentCase.output);
    writeState(worktreePath, pollStateFixture(worktreePath));

    const result = daemonStep({
      cwd: worktreePath,
      statePath: '.agent/herdr-workflow-run.json',
      handleStatePath: '.agent/herdr-implement.json',
      now: () => new Date('2026-07-05T00:00:00.000Z'),
    });

    assert.equal(result.status, 'continue');
    assert.equal(result.nextPhase, 'failed');
    const state = readWorkflowRunState(join(worktreePath, '.agent/herdr-workflow-run.json'));
    assert.equal(state?.currentPhase, 'failed');
    assert.equal(state?.pollRuns?.await_review.status, 'failed');
  }
});

test('poll review times out when the command exceeds the configured timeout', () => {
  const worktreePath = tempWorktree();
  const timeoutWorkflow = pollWorkflowFixture() as { phases: Record<string, unknown> } & Record<string, unknown>;
  installPollScript(
    worktreePath,
    'check-pr-review.sh',
    `#!/bin/sh
set -eu
while :; do
  :
done
`,
  );
  writeState(worktreePath, {
    ...pollStateFixture(worktreePath),
    workflow: normalizeWorkflow({
      ...timeoutWorkflow,
      phases: {
        ...(timeoutWorkflow.phases as Record<string, unknown>),
        await_review: {
          ...((timeoutWorkflow.phases.await_review as Record<string, unknown>) ?? {}),
          timeoutSeconds: 0.05,
        },
      },
    }) as never,
  });

  const result = daemonStep({
    cwd: worktreePath,
    statePath: '.agent/herdr-workflow-run.json',
    handleStatePath: '.agent/herdr-implement.json',
    now: () => new Date('2026-07-05T00:00:00.000Z'),
  });

  assert.equal(result.status, 'continue');
  assert.equal(result.nextPhase, 'timeout');
  const state = readWorkflowRunState(join(worktreePath, '.agent/herdr-workflow-run.json'));
  assert.equal(state?.currentPhase, 'timeout');
  assert.equal(state?.pollRuns?.await_review.status, 'timeout');
  assert.equal(state?.pollRuns?.await_review.timedOut, true);
});

test('poll merge outcomes distinguish merged and closed terminals', () => {
  const worktreePath = tempWorktree();
  installPollScript(
    worktreePath,
    'check-pr-merged.sh',
    `#!/bin/sh
set -eu
printf '%s\n' '{"outcome":"merged","capture":{"pr_url":"https://example.test/pr/42","merged_at":"2026-07-05T00:00:00Z"}}'
`,
  );
  writeState(worktreePath, pollStateFixture(worktreePath, 'await_merge'));

  const merged = daemonStep({
    cwd: worktreePath,
    statePath: '.agent/herdr-workflow-run.json',
    handleStatePath: '.agent/herdr-implement.json',
    now: () => new Date('2026-07-05T00:00:00.000Z'),
  });

  assert.equal(merged.status, 'continue');
  assert.equal(merged.nextPhase, 'merged');
  assert.equal(readWorkflowRunState(join(worktreePath, '.agent/herdr-workflow-run.json'))?.currentPhase, 'merged');

  const closedWorktreePath = tempWorktree();
  installPollScript(
    closedWorktreePath,
    'check-pr-merged.sh',
    `#!/bin/sh
set -eu
printf 'closed\n'
`,
  );
  writeState(closedWorktreePath, pollStateFixture(closedWorktreePath, 'await_merge'));

  const closed = daemonStep({
    cwd: closedWorktreePath,
    statePath: '.agent/herdr-workflow-run.json',
    handleStatePath: '.agent/herdr-implement.json',
    now: () => new Date('2026-07-05T00:00:00.000Z'),
  });

  assert.equal(closed.status, 'continue');
  assert.equal(closed.nextPhase, 'closed');
  assert.equal(readWorkflowRunState(join(closedWorktreePath, '.agent/herdr-workflow-run.json'))?.currentPhase, 'closed');
});
