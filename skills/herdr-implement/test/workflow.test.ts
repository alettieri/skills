import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { loadWorkflow, normalizeWorkflow, WorkflowValidationError } from '../src/workflow.ts';
import { resolveNextPhase } from '../src/workflow-transition.ts';

test('loads the default workflow', () => {
  const source = loadWorkflow();

  assert.equal(source.path.endsWith('skills/herdr-implement/workflows/default.yaml'), true);
  assert.equal(source.workflow.type, 'herdr.issue');
  assert.equal(source.workflow.start, 'setup');
  assert.equal(source.workflow.roleDefaults.reuse, true);
  assert.deepEqual(source.workflow.roleDefaults.codex, {
    approval: 'on-request',
    sandbox: 'workspace-write',
  });
  assert.equal(source.workflow.phases.implement.type, 'agent');
  assert.equal(source.workflow.phases.implement.promptTemplate, 'implement.md');
  assert.equal(source.workflow.phases.simplify.role, 'simplifier');
  assert.equal(source.workflow.phases.verify.type, 'agent');
  assert.equal(source.workflow.phases.run_checks.type, 'script');
  assert.equal(source.workflow.phases.commit_changes.type, 'script');
  assert.equal(source.workflow.phases.push_branch.type, 'script');
  assert.equal(source.workflow.phases.create_pr.type, 'script');
  assert.equal(source.workflow.phases.await_review.type, 'poll');
  assert.equal(source.workflow.phases.await_merge.type, 'poll');
  assert.deepEqual(source.workflow.roles.implementer.resultSchemas, ['implementer-result-v1']);
  assert.deepEqual(source.workflow.roles.simplifier.resultSchemas, ['simplifier-result-v1']);
  assert.deepEqual(source.workflow.roles.reviewer.resultSchemas, ['reviewer-result-v1']);
  assert.deepEqual(source.workflow.roles.verifier.resultSchemas, ['verifier-result-v1']);
  assert.equal(resolveNextPhase(source.workflow, 'run_checks', 'no_checks'), 'commit_changes');
});

test('project workflow fully replaces the default when present', async () => {
  const cwd = await tempProject();
  await writeFile(
    join(cwd, '.agent/herdr-workflow.yaml'),
    JSON.stringify({
      name: 'project-workflow',
      version: 1,
      type: 'herdr.issue',
      start: 'only',
      roleDefaults: { reuse: true, model: 'default-model' },
      roles: { custom: { model: 'project-model' } },
      phases: { only: { type: 'terminal', status: 'complete' } },
    }),
    'utf8',
  );

  const source = loadWorkflow(cwd);

  assert.equal(source.path, join(cwd, '.agent/herdr-workflow.yaml'));
  assert.equal(source.workflow.name, 'project-workflow');
  assert.deepEqual(Object.keys(source.workflow.phases), ['only']);
});

test('start is required and must reference an existing phase', () => {
  assert.throws(
    () =>
      normalizeWorkflow({
        name: 'bad-start',
        version: 1,
        type: 'herdr.issue',
        roles: {},
        phases: { only: { type: 'terminal' } },
      }),
    /start must be a non-empty string/,
  );

  assert.throws(
    () =>
      normalizeWorkflow({
        name: 'bad-start',
        version: 1,
        type: 'herdr.issue',
        start: 'missing',
        roles: {},
        phases: { only: { type: 'terminal' } },
      }),
    /start references unknown phase: missing/,
  );
});

test('role defaults are inherited into roles', () => {
  const workflow = normalizeWorkflow({
    name: 'roles',
    version: 1,
    type: 'herdr.issue',
    start: 'done',
    roleDefaults: {
      agent: 'codex',
      reuse: true,
      model: 'default-model',
      codex: {
        approval: 'on-request',
        sandbox: 'workspace-write',
      },
    },
    roles: {
      implementer: {
        model: 'gpt-5.4-mini',
        codex: {
          sandbox: 'danger-full-access',
        },
      },
    },
    phases: {
      done: { type: 'terminal' },
    },
  });

  assert.deepEqual(workflow.roles.implementer, {
    agent: 'codex',
    reuse: true,
    model: 'gpt-5.4-mini',
    codex: {
      approval: 'on-request',
      sandbox: 'danger-full-access',
    },
  });
});

test('custom roles are supported by agent phases', () => {
  const workflow = normalizeWorkflow({
    name: 'custom',
    version: 1,
    type: 'herdr.issue',
    start: 'custom_phase',
    roleDefaults: {
      agent: 'codex',
      reuse: true,
      codex: { approval: 'on-request', sandbox: 'workspace-write' },
    },
    roles: {
      planner: { model: 'gpt-5.5', resultSchemas: ['implementer-result-v1'] },
    },
    phases: {
      custom_phase: {
        type: 'agent',
        role: 'planner',
        promptTemplate: 'planner.md',
        resultSchema: 'implementer-result-v1',
        on: { complete: 'done' },
      },
      done: { type: 'terminal' },
    },
  });

  assert.equal(workflow.roles.planner.model, 'gpt-5.5');
  assert.equal((workflow.roles.planner.codex as { approval: string }).approval, 'on-request');
  assert.equal(workflow.phases.custom_phase.role, 'planner');
});

test('flat Codex launch fields are rejected', () => {
  assert.throws(
    () =>
      normalizeWorkflow({
        name: 'flat-defaults',
        version: 1,
        type: 'herdr.issue',
        start: 'done',
        roleDefaults: {
          agent: 'codex',
          reuse: true,
          approval: 'on-request',
          sandbox: 'workspace-write',
        },
        roles: {},
        phases: {
          done: { type: 'terminal' },
        },
      }),
    /roleDefaults\.approval is not supported; move Codex launch settings under roleDefaults\.codex/,
  );

  assert.throws(
    () =>
      normalizeWorkflow({
        name: 'flat-role',
        version: 1,
        type: 'herdr.issue',
        start: 'done',
        roleDefaults: {
          agent: 'codex',
          reuse: true,
          codex: { approval: 'on-request', sandbox: 'workspace-write' },
        },
        roles: {
          implementer: {
            model: 'gpt-5.4-mini',
            permissionMode: 'workspace-write',
          },
        },
        phases: {
          done: { type: 'terminal' },
        },
      }),
    /roles\.implementer\.permissionMode is not supported; move Codex launch settings under roles\.implementer\.codex/,
  );
});

test('unknown role result schemas are rejected', () => {
  assert.throws(
    () =>
      normalizeWorkflow({
        name: 'bad-role-schema',
        version: 1,
        type: 'herdr.issue',
        start: 'done',
        roles: {
          implementer: {
            resultSchemas: ['missing-result-schema'],
          },
        },
        phases: {
          done: { type: 'terminal' },
        },
      }),
    /roles\.implementer\.resultSchemas references unknown result schema: missing-result-schema/,
  );
});

test('phase result schema must be allowed by the role', () => {
  assert.throws(
    () =>
      normalizeWorkflow({
        name: 'bad-phase-schema',
        version: 1,
        type: 'herdr.issue',
        start: 'implement',
        roles: {
          implementer: {
            resultSchemas: ['implementer-result-v1'],
          },
        },
        phases: {
          implement: {
            type: 'agent',
            role: 'implementer',
            promptTemplate: 'implement.md',
            resultSchema: 'reviewer-result-v1',
            on: { complete: 'done' },
          },
          done: { type: 'terminal' },
        },
      }),
    /phase implement resultSchema reviewer-result-v1 is not allowed by role implementer/,
  );
});

test('invalid role references are rejected', () => {
  assert.throws(
    () =>
      normalizeWorkflow({
        name: 'bad-role',
        version: 1,
        type: 'herdr.issue',
        start: 'implement',
        roles: {},
        phases: {
          implement: { type: 'agent', role: 'missing', promptTemplate: 'implement.md', on: { complete: 'done' } },
          done: { type: 'terminal' },
        },
      }),
    /phase implement references unknown role: missing/,
  );
});

test('invalid transition targets are rejected', () => {
  assert.throws(
    () =>
      normalizeWorkflow({
        name: 'bad-transition',
        version: 1,
        type: 'herdr.issue',
        start: 'one',
        roles: {},
        phases: {
          one: { type: 'script', on: { success: 'missing' } },
        },
      }),
    /phase one outcome success references unknown phase: missing/,
  );
});

test('unsupported workflow types are rejected', () => {
  assert.throws(
    () =>
      normalizeWorkflow({
        name: 'bad-type',
        version: 1,
        type: 'herdr.task',
        start: 'done',
        roles: {},
        phases: { done: { type: 'terminal' } },
      }),
    /unsupported workflow type: herdr.task/,
  );
});

test('generic transition fields are rejected', () => {
  assert.throws(
    () =>
      normalizeWorkflow({
        name: 'bad-transition-style',
        version: 1,
        type: 'herdr.issue',
        start: 'one',
        roles: {},
        phases: {
          one: { type: 'script', onSuccess: 'done' },
          done: { type: 'terminal' },
        },
      }),
    /phase one must use named on transitions/,
  );
});

test('poll phases require a command, interval, and string args', () => {
  assert.throws(
    () =>
      normalizeWorkflow({
        name: 'bad-poll',
        version: 1,
        type: 'herdr.issue',
        start: 'poll',
        roles: {},
        phases: {
          poll: {
            type: 'poll',
            intervalSeconds: 30,
            on: { waiting: 'poll' },
          },
        },
      }),
    /phases\.poll\.command must be a non-empty string/,
  );

  assert.throws(
    () =>
      normalizeWorkflow({
        name: 'bad-poll',
        version: 1,
        type: 'herdr.issue',
        start: 'poll',
        roles: {},
        phases: {
          poll: {
            type: 'poll',
            command: 'workflow-scripts/check-pr-review.sh',
            intervalSeconds: 0,
            on: { waiting: 'poll' },
          },
        },
      }),
    /phases\.poll\.intervalSeconds must be a positive number/,
  );

  assert.throws(
    () =>
      normalizeWorkflow({
        name: 'bad-poll',
        version: 1,
        type: 'herdr.issue',
        start: 'poll',
        roles: {},
        phases: {
          poll: {
            type: 'poll',
            command: 'workflow-scripts/check-pr-review.sh',
            args: [1],
            intervalSeconds: 30,
            on: { waiting: 'poll' },
          },
        },
      }),
    /phases\.poll\.args must be an array of strings/,
  );
});

async function tempProject(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'herdr-implement-test-'));
  await mkdir(join(cwd, '.agent'), { recursive: true });
  await mkdir(join(cwd, 'skills/herdr-implement/workflows'), { recursive: true });
  await writeFile(
    join(cwd, 'skills/herdr-implement/workflows/default.yaml'),
    JSON.stringify({
      name: 'default',
      version: 1,
      type: 'herdr.issue',
      start: 'default_phase',
      roles: {},
      phases: { default_phase: { type: 'terminal', status: 'complete' } },
    }),
    'utf8',
  );
  return cwd;
}

test('validation errors use the workflow validation error type', () => {
  assert.throws(
    () => normalizeWorkflow(null),
    (error: unknown) => error instanceof WorkflowValidationError && /workflow must be an object/.test(error.message),
  );
});

test('dry-run requires an issue number or GitHub issue URL', () => {
  const result = spawnSync(process.execPath, ['skills/herdr-implement/bin/dry-run.ts', '--issue', 'not-an-issue'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--issue must be an issue number, #number, or GitHub issue URL/);
});

test('dry-run prints selected workflow details and transition graph', () => {
  const result = spawnSync(process.execPath, ['skills/herdr-implement/bin/dry-run.ts', '--issue', '#15'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Workflow: .*skills\/herdr-implement\/workflows\/default\.yaml/);
  assert.match(result.stdout, /Normalized roles:/);
  assert.match(result.stdout, /- implementer: .*"reuse":true/);
  assert.match(result.stdout, /Phases:/);
  assert.match(result.stdout, /- implement: type=agent role=implementer/);
  assert.match(result.stdout, /Named outcome transitions:/);
  assert.match(result.stdout, /- review\.approved -> verify/);
  assert.match(result.stdout, /Transition graph:/);
  assert.match(result.stdout, /- run_checks -> .*success:commit_changes/);
});

test('dry-run rejects malformed project workflow before side effects', async () => {
  const cwd = await tempProject();
  await writeFile(
    join(cwd, '.agent/herdr-workflow.yaml'),
    JSON.stringify({
      name: 'bad-project-workflow',
      version: 1,
      type: 'herdr.issue',
      start: 'missing',
      roles: {},
      phases: { only: { type: 'terminal' } },
    }),
    'utf8',
  );

  const result = spawnSync(process.execPath, [join(process.cwd(), 'skills/herdr-implement/bin/dry-run.ts'), '--issue', '15'], {
    cwd,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Workflow validation failed: start references unknown phase: missing/);
});
