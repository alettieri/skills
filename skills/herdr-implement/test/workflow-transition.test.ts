import assert from 'node:assert/strict';
import test from 'node:test';
import { isTerminalPhase, resolveNextPhase } from '../src/workflow-transition.ts';

type WorkflowLike = Parameters<typeof resolveNextPhase>[0];

function workflowFixture(): WorkflowLike {
  return {
    name: 'workflow-transition',
    version: '1',
    type: 'herdr.issue',
    start: 'setup',
    roleDefaults: {},
    roles: {
      implementer: {},
    },
    phases: {
      setup: {
        type: 'herdr-worktree',
        on: { success: 'implement' },
      },
      implement: {
        type: 'agent',
        role: 'implementer',
        promptTemplate: 'implement.md',
        on: { complete: 'done' },
      },
      done: {
        type: 'terminal',
        status: 'complete',
        on: {},
      },
    },
    transitions: [],
  } as WorkflowLike;
}

test('resolveNextPhase returns declared transitions', () => {
  const workflow = workflowFixture();

  assert.equal(resolveNextPhase(workflow, 'setup', 'success'), 'implement');
  assert.equal(resolveNextPhase(workflow, 'implement', 'complete'), 'done');
});

test('resolveNextPhase returns null for missing phases and outcomes', () => {
  const workflow = workflowFixture();

  assert.equal(resolveNextPhase(workflow, 'missing', 'success'), null);
  assert.equal(resolveNextPhase(workflow, 'setup', 'failure'), null);
});

test('isTerminalPhase identifies terminal phases only', () => {
  const workflow = workflowFixture();

  assert.equal(isTerminalPhase(workflow, 'done'), true);
  assert.equal(isTerminalPhase(workflow, 'setup'), false);
  assert.equal(isTerminalPhase(workflow, 'missing'), false);
});
