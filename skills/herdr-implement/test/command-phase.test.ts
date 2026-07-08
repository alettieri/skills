import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildCommandEnvironment,
  buildCommandRunPaths,
  commandLogContents,
  parseCommandOutcome,
  renderCommandArgs,
  renderCommandEnv,
  resolveCommandPath,
  writeCommandLogFiles,
  type CommandPhaseWorkflowState,
} from '../src/command-phase.ts';

function tempWorktree(): string {
  const worktreePath = mkdtempSync(join(tmpdir(), 'herdr-command-phase-'));
  mkdirSync(join(worktreePath, '.agent'), { recursive: true });
  mkdirSync(join(worktreePath, '.agent/workflow-scripts'), { recursive: true });
  return worktreePath;
}

function writeExecutableScript(path: string, body: string): void {
  writeFileSync(path, `${body.trimEnd()}\n`, 'utf8');
  chmodSync(path, 0o755);
}

function commandStateFixture(worktreePath: string): CommandPhaseWorkflowState {
  return {
    issue: {
      input: '#17',
      number: 17,
      url: null,
      canonical: '#17',
    },
    workflowPath: join(worktreePath, '.agent/herdr-workflow.yaml'),
    workflow: {
      name: 'command-phase',
      version: '1',
      type: 'herdr.issue',
      start: 'setup',
      roleDefaults: {},
      roles: {},
      phases: {
        setup: {
          type: 'script',
          command: 'workflow-scripts/echo.sh',
          on: {},
        },
      },
      transitions: [],
    },
    branchName: 'issue-17-herdr-implement',
    worktreePath,
    workspaceId: 'w17',
    currentPhase: 'setup',
    updatedAt: '2026-07-07T00:00:00.000Z',
    context: {
      greeting: 'hello',
      nested: {
        count: 3,
        enabled: true,
      },
    },
  };
}

test('command phase primitives render templates and build runtime metadata', () => {
  const worktreePath = tempWorktree();
  const state = commandStateFixture(worktreePath);
  const runId = 'issue-17-setup-script';

  const args = renderCommandArgs(state, 'setup', ['{{ issue.number }}', '{{ context.greeting }}', '{{ run.id }}'], runId);
  const env = renderCommandEnv(state, 'setup', { GREETING: '{{ context.greeting }}' }, runId);
  const runtimeEnv = buildCommandEnvironment(state, 'setup', env, runId);

  assert.deepEqual(args, ['17', 'hello', runId]);
  assert.equal(env.GREETING, 'hello');
  assert.equal(runtimeEnv.HERDR_RUN_ID, runId);
  assert.equal(runtimeEnv.PWD, worktreePath);
  assert.equal(runtimeEnv.HERDR_ISSUE_NUMBER, '17');
});

test('command phase templates match text-template handling for supported and unsupported placeholders', () => {
  const worktreePath = tempWorktree();
  const baseState = commandStateFixture(worktreePath);
  const state = {
    ...baseState,
    context: {
      ...baseState.context,
      'issue-input': 'from-input',
      issue_name: 'from-name',
      present: {
        key: 'there',
      },
    },
  };
  const runId = 'issue-17-setup-script';

  const rendered = renderCommandArgs(
    state,
    'setup',
    [
      'A {{ issue.number }} / {{ context.issue-input }} / {{ context.issue_name }}',
      'B {{  context.present.key  }} and {{ context.missing.key }}!',
      'C {{ not supported! }} stays',
    ],
    runId,
  );

  assert.deepEqual(rendered, [
    'A 17 / from-input / from-name',
    'B there and !',
    'C {{ not supported! }} stays',
  ]);
});

test('command phase primitives resolve commands and write logs', () => {
  const worktreePath = tempWorktree();
  const state = commandStateFixture(worktreePath);
  const scriptPath = join(worktreePath, '.agent/workflow-scripts', 'echo.sh');
  writeExecutableScript(
    scriptPath,
    `#!/bin/sh
printf 'ok\\n'
`,
  );

  const resolved = resolveCommandPath(worktreePath, state.workflowPath, 'workflow-scripts/echo.sh');
  assert.equal(resolved, scriptPath);

  const paths = buildCommandRunPaths(worktreePath, 'issue-17-setup-script');
  const rawOutput = commandLogContents({
    command: 'workflow-scripts/echo.sh',
    resolvedCommandPath: resolved,
    args: ['one', 'two'],
    cwd: worktreePath,
    env: { A: '1' },
    timeoutSeconds: 30,
    startedAt: '2026-07-07T00:00:00.000Z',
    finishedAt: '2026-07-07T00:00:01.000Z',
    stdout: 'ok\n',
    stderr: '',
  });
  writeCommandLogFiles(paths, 'ok\n', '', rawOutput);

  assert.equal(existsSync(paths.stdoutPath), true);
  assert.equal(existsSync(paths.stderrPath), true);
  assert.equal(existsSync(paths.rawOutputPath), true);
  assert.equal(readFileSync(paths.stdoutPath, 'utf8'), 'ok\n');
  assert.match(readFileSync(paths.rawOutputPath, 'utf8'), /command: workflow-scripts\/echo\.sh/);
});

test('command phase outcome parsing accepts tokens and JSON capture', () => {
  assert.deepEqual(parseCommandOutcome('approved\n'), { outcome: 'approved', capture: null });
  assert.deepEqual(parseCommandOutcome('{"outcome":"success","capture":{"value":"1"}}\n'), {
    outcome: 'success',
    capture: { value: '1' },
  });
});
