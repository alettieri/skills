import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  bootstrap,
  BootstrapError,
  daemonStep,
  normalizeIssueReference,
  readDaemonHandleState,
  readWorkflowRunState,
  writeDaemonHandleState,
  writeWorkflowRunState,
} from '../src/runtime.ts';
import { loadWorkflow, normalizeWorkflow } from '../src/workflow.ts';
import type { HerdrAdapter } from '../src/herdr-adapter.ts';
import type { ScriptRunState } from '../src/script-phase.ts';

type HerdrCommandResult = {
  stdout: string;
  stderr: string;
  status: number | null;
};

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

test('normalizeIssueReference extracts canonical identifiers before slugifying', () => {
  assert.deepEqual(normalizeIssueReference('ENG-123'), {
    input: 'ENG-123',
    url: null,
    canonical: 'ENG-123',
    slug: 'eng-123',
  });
  assert.equal(normalizeIssueReference('Linear ticket ENG-123').slug, 'eng-123');
  assert.equal(normalizeIssueReference('Linear ticket ENG-123').canonical, 'ENG-123');
  assert.deepEqual(normalizeIssueReference('64'), {
    input: '64',
    url: null,
    canonical: '#64',
    slug: '64',
  });
});

test('normalizeIssueReference parses tracker URLs and falls back to whole-string slugs', () => {
  assert.deepEqual(normalizeIssueReference('https://github.com/alettieri/skills/issues/64'), {
    input: 'https://github.com/alettieri/skills/issues/64',
    url: 'https://github.com/alettieri/skills/issues/64',
    canonical: '#64',
    slug: '64',
  });
  assert.deepEqual(normalizeIssueReference('https://linear.app/acme/issue/ENG-123/fix-parser'), {
    input: 'https://linear.app/acme/issue/ENG-123/fix-parser',
    url: 'https://linear.app/acme/issue/ENG-123/fix-parser',
    canonical: 'ENG-123',
    slug: 'eng-123',
  });
  assert.equal(normalizeIssueReference('release blocker: slug identity!').slug, 'release-blocker-slug-identity');
});

test('normalizeIssueReference caps slugs at a boundary and rejects degenerate refs', () => {
  assert.equal(
    normalizeIssueReference('alpha beta gamma delta epsilon zeta eta theta iota kappa lambda').slug,
    'alpha-beta-gamma-delta-epsilon-zeta-eta-theta',
  );
  assert.throws(
    () => normalizeIssueReference('!!!'),
    /issue reference must contain at least one letter or number/,
  );
});

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
      reuse,
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
        resultSchemas: ['implementer-result-v1'],
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
        resultSchemas: ['implementer-result-v1'],
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
      url: null,
      canonical: `#${issueNumber}`,
      slug: String(issueNumber),
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
    scriptRuns: {},
    pollRuns: {},
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
    daemonCommand: 'node skills/herdr-implement/bin/daemon.ts',
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
      url: null,
      canonical: `#${issueNumber}`,
      slug: String(issueNumber),
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
    scriptRuns: {},
    pollRuns: {},
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
      url: null,
      canonical: `#${issueNumber}`,
      slug: String(issueNumber),
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
    scriptRuns: {},
    pollRuns: {},
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

function scriptWorkflowFixture(options?: {
  command?: string;
  on?: Record<string, string>;
  timeoutSeconds?: number;
  retryable?: boolean;
}): Record<string, unknown> {
  return {
    name: 'script-workflow',
    version: 1,
    type: 'herdr.issue',
    start: 'run_script',
    roleDefaults: {},
    roles: {},
    phases: {
      run_script: {
        type: 'script',
        command: options?.command ?? 'workflow-scripts/run-script.sh',
        args: ['{{ issue.slug }}', '{{ context.greeting }}', '{{ context.outputPath }}'],
        cwd: '{{ context.customCwd }}',
        env: {
          HERDR_TEST_GREETING: '{{ context.greeting }}',
        },
        timeoutSeconds: options?.timeoutSeconds,
        retryable: options?.retryable,
        on: options?.on ?? { success: 'done', blocked: 'blocked', failure: 'failed', timeout: 'timeout' },
      },
      done: {
        type: 'terminal',
        status: 'complete',
      },
      blocked: {
        type: 'terminal',
        status: 'blocked',
      },
      failed: {
        type: 'terminal',
        status: 'failed',
      },
      timeout: {
        type: 'terminal',
        status: 'blocked',
      },
    },
  };
}

function scriptWorkflowStateFixture(
  worktreePath: string,
  issueNumber: number,
  currentPhase = 'run_script',
  workflowOptions?: Parameters<typeof scriptWorkflowFixture>[0],
) {
  const workflowPath = join(worktreePath, '.agent/herdr-workflow.yaml');
  return {
    schemaVersion: 1 as const,
    issue: {
      input: `#${issueNumber}`,
      url: null,
      canonical: `#${issueNumber}`,
      slug: String(issueNumber),
    },
    workflowPath,
    workflow: normalizeWorkflow(scriptWorkflowFixture(workflowOptions)) as never,
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
    context: {
      greeting: 'hello',
      customCwd: worktreePath,
      outputPath: join(worktreePath, '.agent/script-output.txt'),
    },
    pendingAgentRun: null,
    acceptedAgentRuns: {},
    scriptRuns: {},
    pollRuns: {},
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

async function makeScriptWorkflowFixture(
  worktreePath: string,
  scriptBody: string,
  workflowOptions?: Parameters<typeof scriptWorkflowFixture>[0],
): Promise<void> {
  await mkdir(join(worktreePath, '.agent/workflow-scripts'), { recursive: true });
  await mkdir(join(worktreePath, '.agent'), { recursive: true });
  await writeFileSync(
    join(worktreePath, '.agent/herdr-workflow.yaml'),
    JSON.stringify(scriptWorkflowFixture(workflowOptions), null, 2),
    'utf8',
  );
  const scriptPath = join(worktreePath, '.agent/workflow-scripts/run-script.sh');
  writeFileSync(scriptPath, scriptBody, 'utf8');
  chmodSync(scriptPath, 0o755);
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

function createAdapter(overrides: Partial<HerdrAdapter> = {}): HerdrAdapter {
  return {
    findWorktreeByBranch() {
      return {
        workspaceId: 'w16',
        worktreePath: join('/tmp', 'issue-worktree'),
        branchName: 'issue-16-herdr-implement',
      };
    },
    createWorktree() {
      return {
        workspaceId: 'w16',
        worktreePath: join('/tmp', 'issue-worktree'),
        branchName: 'issue-16-herdr-implement',
      };
    },
    ensureWorktree() {
      return {
        workspaceId: 'w16',
        worktreePath: join('/tmp', 'issue-worktree'),
        branchName: 'issue-16-herdr-implement',
      };
    },
    createDaemonPane() {
      return {
        tabId: 'tab-1',
        paneId: 'pane-1',
        terminalId: null,
      };
    },
    runPaneCommand() {},
    getPaneInfo() {
      return null;
    },
    launchRoleAgent() {
      return {
        tabId: 'tab-impl',
        paneId: 'pane-impl',
        terminalId: 'term-impl',
      };
    },
    sendPrompt() {},
    submitPrompt() {},
    getAgentStatus() {
      return {
        agentName: 'issue-16-implementer',
        paneId: 'pane-impl',
        tabId: 'tab-impl',
        terminalId: 'term-impl',
        status: 'missing',
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

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-implement-runtime-'));
  const origin = mkdtempSync(join(tmpdir(), 'herdr-implement-runtime-origin-'));
  git(origin, ['init', '--bare']);
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test User']);
  git(dir, ['remote', 'add', 'origin', origin]);
  await mkdir(join(dir, '.agent'), { recursive: true });
  await mkdir(join(dir, 'skills/herdr-implement/workflows'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), 'fixture\n', 'utf8');
  writeFileSync(join(dir, 'skills/herdr-implement/workflows/default.yaml'), JSON.stringify(workflowFixture(), null, 2), 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'initial']);
  git(dir, ['push', '-u', 'origin', 'main']);
  git(dir, ['fetch', 'origin', 'main']);
  git(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  return dir;
}

function writeBootstrapCliHerdrScript(binDir: string): string {
  const scriptPath = join(binDir, 'herdr');
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const mode = process.env.HERDR_FAKE_MODE || 'timed-out';
const worktreePath = process.env.HERDR_FAKE_WORKTREE_PATH;
const workspaceId = process.env.HERDR_FAKE_WORKSPACE_ID || 'w16';
if (!worktreePath) {
  process.stderr.write('missing HERDR_FAKE_WORKTREE_PATH\\n');
  process.exit(1);
}
function writeJson(value) {
  process.stdout.write(JSON.stringify(value) + '\\n');
}
function ensureWorktree() {
  fs.mkdirSync(worktreePath, { recursive: true });
}
if (args[0] === 'worktree' && args[1] === 'list') {
  writeJson([]);
  process.exit(0);
}
if (args[0] === 'worktree' && args[1] === 'create') {
  ensureWorktree();
  writeJson({ workspaceId, worktreePath, branch: 'issue-16-herdr-implement' });
  process.exit(0);
}
if (args[0] === 'tab' && args[1] === 'create') {
  writeJson({ result: { tab_id: 'tab-1' } });
  process.exit(0);
}
if (args[0] === 'pane' && args[1] === 'current') {
  process.stdout.write('pane-1\\n');
  process.exit(0);
}
if (args[0] === 'pane' && args[1] === 'run') {
  process.exit(0);
}
if (args[0] === 'pane' && args[1] === 'get') {
  if (mode === 'pane-exited') {
    process.exit(1);
  }
  writeJson({ result: { pane: { pane_id: 'pane-1', tab_id: 'tab-1', terminal_id: 'term-1' } } });
  process.exit(0);
}
process.stderr.write('unexpected command: ' + args.join(' ') + '\\n');
process.exit(1);
`,
    'utf8',
  );
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

async function makeWorktreeFixture(worktreePath: string): Promise<void> {
  await mkdir(join(worktreePath, '.agent'), { recursive: true });
  await mkdir(join(worktreePath, 'skills/herdr-implement/workflows'), { recursive: true });
  writeFileSync(join(worktreePath, 'skills/herdr-implement/workflows/default.yaml'), JSON.stringify(workflowFixture(), null, 2), 'utf8');
}

function installDefaultWorkflowFixture(worktreePath: string): void {
  const defaultWorkflowPath = join(process.cwd(), 'skills/herdr-implement/workflows/default.yaml');
  writeFileSync(
    join(worktreePath, 'skills/herdr-implement/workflows/default.yaml'),
    readFileSync(defaultWorkflowPath, 'utf8'),
    'utf8',
  );
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

function installRecoveryMarkerScripts(worktreePath: string): void {
  const scripts = [
    { name: 'commit-changes.sh', marker: 'commit_changes.ran' },
    { name: 'push-branch.sh', marker: 'push_branch.ran' },
    { name: 'create-pr.sh', marker: 'create_pr.ran' },
    { name: 'cleanup-worktree.sh', marker: 'cleanup.ran' },
  ];

  mkdirSync(join(worktreePath, '.agent', 'workflow-scripts'), { recursive: true });
  for (const script of scripts) {
    writeFileSync(
      join(worktreePath, '.agent', 'workflow-scripts', script.name),
      `#!/usr/bin/env sh
set -eu
printf '%s\n' '${script.marker}' > .agent/${script.marker}
printf 'success\n'
`,
      'utf8',
    );
    chmodSync(join(worktreePath, '.agent', 'workflow-scripts', script.name), 0o755);
  }
}

function scriptNameForPhase(phaseId: string): string {
  switch (phaseId) {
    case 'commit_changes':
      return 'commit-changes.sh';
    case 'push_branch':
      return 'push-branch.sh';
    case 'create_pr':
      return 'create-pr.sh';
    case 'cleanup':
      return 'cleanup-worktree.sh';
    default:
      return `${phaseId}.sh`;
  }
}

function defaultWorkflowRecoveryStateFixture(worktreePath: string, issueNumber: number, currentPhase: string) {
  const workflowPath = join(worktreePath, 'skills/herdr-implement/workflows/default.yaml');
  return {
    schemaVersion: 1 as const,
    issue: {
      input: `#${issueNumber}`,
      url: null,
      canonical: `#${issueNumber}`,
      slug: String(issueNumber),
    },
    workflowPath,
    workflow: loadWorkflow(worktreePath).workflow as never,
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
    scriptRuns: {},
    pollRuns: {},
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

function completedScriptRunFixture(
  worktreePath: string,
  issueNumber: number,
  phaseId: string,
  outcome: string,
): ScriptRunState {
  const runId = `issue-${issueNumber}-${phaseId}-script`;
  const runDir = join(worktreePath, '.agent', 'runs', runId);
  return {
    phaseId,
    runId,
    command: `workflow-scripts/${scriptNameForPhase(phaseId)}`,
    resolvedCommandPath: join(worktreePath, '.agent', 'workflow-scripts', scriptNameForPhase(phaseId)),
    args: [],
    cwd: worktreePath,
    env: {},
    timeoutSeconds: 30,
    startedAt: '2026-06-30T12:00:00.000Z',
    finishedAt: '2026-06-30T12:00:01.000Z',
    durationMs: 1000,
    timedOut: false,
    exitCode: 0,
    signal: null,
    status: 'complete',
    outcome,
    capture: null,
    stdout: `${outcome}\n`,
    stderr: '',
    retryable: false,
    stdoutPath: join(runDir, 'stdout.log'),
    stderrPath: join(runDir, 'stderr.log'),
    rawOutputPath: join(runDir, 'raw.log'),
  };
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
    payload: {
      changedFiles: ['skills/herdr-implement/src/runtime.ts'],
      checksRun: ['node --test skills/herdr-implement/test/*.test.ts'],
      checksDeferred: [],
      blockers: [],
    },
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
  const worktreePath = mkdtempSync(join(tmpdir(), 'herdr-bootstrap-worktree-'));
  await makeWorktreeFixture(worktreePath);

  const baseRunner = createRunner([
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
        `node skills/herdr-implement/bin/daemon.ts --worktree ${JSON.stringify(
          worktreePath,
        )} --state .agent/herdr-workflow-run.json --handles .agent/herdr-implement.json`,
      ],
      result: { stdout: '', stderr: '', status: 0 },
    },
    {
      args: ['pane', 'get', 'pane-1'],
      result: {
        stdout: `${JSON.stringify({ result: { pane: { pane_id: 'pane-1', tab_id: 'tab-1', terminal_id: null } } })}\n`,
        stderr: '',
        status: 0,
      },
    },
  ]);
  const runner = {
    run(args: string[]): HerdrCommandResult {
      const result = baseRunner.run(args);
      if (args[0] === 'pane' && args[1] === 'get') {
        const runStatePath = join(worktreePath, '.agent/herdr-workflow-run.json');
        const runState = readWorkflowRunState(runStatePath);
        if (runState) {
          writeWorkflowRunState(runStatePath, {
            ...runState,
            currentPhase: 'ready',
            updatedAt: '2026-06-30T12:00:01.000Z',
          });
        }
      }
      return result;
    },
  };

  const result = await bootstrap({ cwd: repo, issue: '#16', runner, now: () => new Date('2026-06-30T12:00:00.000Z') });

  assert.equal(result.mode, 'new-run');
  assert.equal(result.health, 'healthy');
  assert.equal(result.currentPhase, 'ready');
  assert.equal(result.nextInspectionCommand, `cat ${JSON.stringify(join(worktreePath, '.agent/herdr-workflow-run.json'))}`);
  assert.equal(result.workspaceId, 'w16');
  assert.equal(result.worktreePath, worktreePath);
  assert.equal(result.runStatePath, join(worktreePath, '.agent/herdr-workflow-run.json'));
  assert.equal(result.handleStatePath, join(worktreePath, '.agent/herdr-implement.json'));
  assert.equal(readWorkflowRunState(result.runStatePath)?.worktreePath, worktreePath);
  assert.equal(readDaemonHandleState(result.handleStatePath)?.daemonPaneId, 'pane-1');

  const daemonCli = spawnSync(
    process.execPath,
    [
      join(process.cwd(), 'skills/herdr-implement/bin/daemon.ts'),
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
  assert.match(daemonCli.stdout, /"status": "stop"/);
  assert.equal(readWorkflowRunState(result.runStatePath)?.currentPhase, 'ready');
});

test('bootstrap accepts wrapped Herdr worktree create output', async () => {
  const repo = await makeRepo();
  const repoRoot = realpathSync(repo);
  const worktreePath = mkdtempSync(join(tmpdir(), 'herdr-bootstrap-worktree-'));
  await makeWorktreeFixture(worktreePath);

  const baseRunner = createRunner([
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
          result: {
            worktree: {
              open_workspace_id: 'w16',
              path: worktreePath,
              branch: 'issue-16-herdr-implement',
            },
          },
        })}\n`,
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
        `node skills/herdr-implement/bin/daemon.ts --worktree ${JSON.stringify(
          worktreePath,
        )} --state .agent/herdr-workflow-run.json --handles .agent/herdr-implement.json`,
      ],
      result: { stdout: '', stderr: '', status: 0 },
    },
    {
      args: ['pane', 'get', 'pane-1'],
      result: {
        stdout: `${JSON.stringify({ result: { pane: { pane_id: 'pane-1', tab_id: 'tab-1', terminal_id: null } } })}\n`,
        stderr: '',
        status: 0,
      },
    },
  ]);
  const runner = {
    run(args: string[]): HerdrCommandResult {
      const result = baseRunner.run(args);
      if (args[0] === 'pane' && args[1] === 'get') {
        const runStatePath = join(worktreePath, '.agent/herdr-workflow-run.json');
        const runState = readWorkflowRunState(runStatePath);
        if (runState) {
          writeWorkflowRunState(runStatePath, {
            ...runState,
            currentPhase: 'ready',
            updatedAt: '2026-06-30T12:00:01.000Z',
          });
        }
      }
      return result;
    },
  };

  const result = await bootstrap({ cwd: repo, issue: '#16', runner, now: () => new Date('2026-06-30T12:00:00.000Z') });

  assert.equal(result.mode, 'new-run');
  assert.equal(result.health, 'healthy');
  assert.equal(result.currentPhase, 'ready');
  assert.equal(result.workspaceId, 'w16');
  assert.equal(result.worktreePath, worktreePath);
  assert.equal(result.runStatePath, join(worktreePath, '.agent/herdr-workflow-run.json'));
  assert.equal(readWorkflowRunState(result.runStatePath)?.worktreePath, worktreePath);
});

test('bootstrap accepts the live tab create payload and records the daemon root pane', async () => {
  const repo = await makeRepo();
  const repoRoot = realpathSync(repo);
  const worktreePath = mkdtempSync(join(tmpdir(), 'herdr-bootstrap-worktree-'));
  await makeWorktreeFixture(worktreePath);

  const baseRunner = createRunner([
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
          result: {
            worktree: {
              open_workspace_id: 'w16',
              path: worktreePath,
              branch: 'issue-16-herdr-implement',
            },
          },
        })}\n`,
        stderr: '',
        status: 0,
      },
    },
    {
      args: ['tab', 'create', '--workspace', 'w16', '--cwd', worktreePath, '--label', 'herdr-implement-daemon', '--focus'],
      result: {
        stdout: `${JSON.stringify({
          id: 'cli:tab:create',
          result: {
            root_pane: {
              pane_id: 'pane-1',
              tab_id: 'tab-1',
              terminal_id: 'term-1',
              cwd: worktreePath,
              focused: true,
              foreground_cwd: worktreePath,
            },
            tab: {
              tab_id: 'tab-1',
            },
          },
        })}\n`,
        stderr: '',
        status: 0,
      },
    },
    {
      args: ['pane', 'run', 'pane-1', `node skills/herdr-implement/bin/daemon.ts --worktree ${JSON.stringify(worktreePath)} --state .agent/herdr-workflow-run.json --handles .agent/herdr-implement.json`],
      result: { stdout: '', stderr: '', status: 0 },
    },
    {
      args: ['pane', 'get', 'pane-1'],
      result: {
        stdout: `${JSON.stringify({ result: { pane: { pane_id: 'pane-1', tab_id: 'tab-1', terminal_id: null } } })}\n`,
        stderr: '',
        status: 0,
      },
    },
  ]);
  const runner = {
    run(args: string[]): HerdrCommandResult {
      const result = baseRunner.run(args);
      if (args[0] === 'pane' && args[1] === 'get') {
        const runStatePath = join(worktreePath, '.agent/herdr-workflow-run.json');
        const runState = readWorkflowRunState(runStatePath);
        if (runState) {
          writeWorkflowRunState(runStatePath, {
            ...runState,
            currentPhase: 'ready',
            updatedAt: '2026-06-30T12:00:01.000Z',
          });
        }
      }
      return result;
    },
  };

  const result = await bootstrap({ cwd: repo, issue: '#16', runner, now: () => new Date('2026-06-30T12:00:00.000Z') });

  assert.equal(result.mode, 'new-run');
  assert.equal(result.health, 'healthy');
  assert.equal(result.currentPhase, 'ready');
  assert.equal(result.workspaceId, 'w16');
  assert.equal(result.worktreePath, worktreePath);
  assert.equal(readWorkflowRunState(result.runStatePath)?.daemon.paneId, 'pane-1');
});

test('bootstrap can be driven through an adapter fake', async () => {
  const repo = await makeRepo();
  const worktreePath = mkdtempSync(join(tmpdir(), 'herdr-bootstrap-worktree-'));
  await makeWorktreeFixture(worktreePath);

  const result = await bootstrap({
    cwd: repo,
    issue: '#16',
    adapter: createAdapter({
      findWorktreeByBranch() {
        return null;
      },
      createWorktree() {
        return {
          workspaceId: 'w16',
          worktreePath,
          branchName: 'issue-16-herdr-implement',
        };
      },
      getPaneInfo(paneId) {
        if (paneId !== 'pane-1') {
          return null;
        }

        const runStatePath = join(worktreePath, '.agent/herdr-workflow-run.json');
        const runState = readWorkflowRunState(runStatePath);
        if (runState) {
          writeWorkflowRunState(runStatePath, {
            ...runState,
            currentPhase: 'ready',
            updatedAt: '2026-06-30T12:00:01.000Z',
          });
        }

        return {
          tabId: 'tab-1',
          paneId: 'pane-1',
          terminalId: null,
        };
      },
      createDaemonPane() {
        return {
          tabId: 'tab-1',
          paneId: 'pane-1',
          terminalId: null,
        };
      },
      runPaneCommand() {},
    }),
    now: () => new Date('2026-06-30T12:00:00.000Z'),
  });

  assert.equal(result.mode, 'new-run');
  assert.equal(result.health, 'healthy');
  assert.equal(result.currentPhase, 'ready');
  assert.equal(result.workspaceId, 'w16');
  assert.equal(result.worktreePath, worktreePath);
  assert.equal(readWorkflowRunState(result.runStatePath)?.daemon.paneId, 'pane-1');
  assert.equal(readDaemonHandleState(result.handleStatePath)?.daemonPaneId, 'pane-1');
});

test('bootstrap recovery reuses existing worktree-local state for the requested issue', async () => {
  const repo = await makeRepo();
  const repoRoot = realpathSync(repo);
  const worktreePath = mkdtempSync(join(tmpdir(), 'herdr-bootstrap-worktree-'));
  await makeWorktreeFixture(worktreePath);
  writeWorkflowRunState(join(worktreePath, '.agent/herdr-workflow-run.json'), workflowStateFixture(worktreePath, 16, 'ready'));
  writeDaemonHandleState(join(worktreePath, '.agent/herdr-implement.json'), handleStateFixture(worktreePath, 16, 'tab-1', 'pane-1'));

  const baseRunner = createRunner([
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
      args: ['pane', 'get', 'pane-1'],
      result: {
        stdout: `${JSON.stringify({ result: { pane: { pane_id: 'pane-1', tab_id: 'tab-1', terminal_id: 'term-1' } } })}\n`,
        stderr: '',
        status: 0,
      },
    },
    {
      args: ['pane', 'get', 'pane-1'],
      result: {
        stdout: `${JSON.stringify({ result: { pane: { pane_id: 'pane-1', tab_id: 'tab-1', terminal_id: 'term-1' } } })}\n`,
        stderr: '',
        status: 0,
      },
    },
  ]);

  const result = await bootstrap({ cwd: repo, issue: '#16', runner: baseRunner });

  assert.equal(result.mode, 'recovery');
  assert.equal(result.health, 'healthy');
  assert.equal(result.createdRunState, false);
  assert.equal(result.createdHandleState, false);
  assert.equal(result.daemonPaneId, 'pane-1');
});

test('bootstrap recovery compares issue identity by slug for noisy non-numeric references', async () => {
  const repo = await makeRepo();
  const worktreePath = mkdtempSync(join(tmpdir(), 'herdr-bootstrap-worktree-'));
  await makeWorktreeFixture(worktreePath);
  writeWorkflowRunState(join(worktreePath, '.agent/herdr-workflow-run.json'), {
    ...workflowStateFixture(worktreePath, 123, 'ready'),
    issue: {
      input: 'ENG-123',
      url: null,
      canonical: 'ENG-123',
      slug: 'eng-123',
    },
    branchName: 'issue-eng-123-herdr-implement',
    workspaceId: 'w-eng',
  });

  const result = await bootstrap({
    cwd: repo,
    issue: 'Linear ticket ENG-123',
    adapter: createAdapter({
      findWorktreeByBranch(_repository, branchName) {
        assert.equal(branchName, 'issue-eng-123-herdr-implement');
        return {
          workspaceId: 'w-eng',
          worktreePath,
          branchName,
        };
      },
      createWorktree() {
        throw new Error('not used');
      },
      getPaneInfo(paneId) {
        return paneId === 'pane-eng'
          ? {
              tabId: 'tab-eng',
              paneId: 'pane-eng',
              terminalId: null,
            }
          : null;
      },
      createDaemonPane(workspaceId) {
        assert.equal(workspaceId, 'w-eng');
        return {
          tabId: 'tab-eng',
          paneId: 'pane-eng',
          terminalId: null,
        };
      },
      runPaneCommand() {},
    }),
  });

  assert.equal(result.mode, 'recovery');
  assert.equal(result.health, 'healthy');
  assert.equal(result.createdRunState, false);
  assert.equal(result.issue.slug, 'eng-123');
  assert.equal(readWorkflowRunState(result.runStatePath)?.issue.canonical, 'ENG-123');
});

test('bootstrap recovery accepts snake-case Herdr workspace ids', async () => {
  const repo = await makeRepo();
  const repoRoot = realpathSync(repo);
  const worktreePath = mkdtempSync(join(tmpdir(), 'herdr-bootstrap-worktree-'));
  await makeWorktreeFixture(worktreePath);
  writeWorkflowRunState(join(worktreePath, '.agent/herdr-workflow-run.json'), workflowStateFixture(worktreePath, 16, 'ready'));
  writeDaemonHandleState(join(worktreePath, '.agent/herdr-implement.json'), handleStateFixture(worktreePath, 16, 'tab-1', 'pane-1'));

  const baseRunner = createRunner([
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
    {
      args: ['pane', 'get', 'pane-1'],
      result: {
        stdout: `${JSON.stringify({ result: { pane: { pane_id: 'pane-1', tab_id: 'tab-1', terminal_id: 'term-1' } } })}\n`,
        stderr: '',
        status: 0,
      },
    },
    {
      args: ['pane', 'get', 'pane-1'],
      result: {
        stdout: `${JSON.stringify({ result: { pane: { pane_id: 'pane-1', tab_id: 'tab-1', terminal_id: 'term-1' } } })}\n`,
        stderr: '',
        status: 0,
      },
    },
  ]);

  const result = await bootstrap({ cwd: repo, issue: '#16', runner: baseRunner });

  assert.equal(result.mode, 'recovery');
  assert.equal(result.health, 'healthy');
  assert.equal(result.workspaceId, 'w16');
  assert.equal(result.daemonPaneId, 'pane-1');
});

test('bootstrap replaces an unhealthy recorded daemon pane before reusing handles', async () => {
  const repo = await makeRepo();
  const repoRoot = realpathSync(repo);
  const worktreePath = mkdtempSync(join(tmpdir(), 'herdr-bootstrap-worktree-'));
  await makeWorktreeFixture(worktreePath);
  writeWorkflowRunState(join(worktreePath, '.agent/herdr-workflow-run.json'), workflowStateFixture(worktreePath, 16, 'ready'));
  writeDaemonHandleState(join(worktreePath, '.agent/herdr-implement.json'), handleStateFixture(worktreePath, 16, 'tab-1', 'pane-1'));

  const baseRunner = createRunner([
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
      args: ['pane', 'get', 'pane-1'],
      result: {
        stdout: '',
        stderr: 'pane missing',
        status: 1,
      },
    },
    {
      args: ['tab', 'create', '--workspace', 'w16', '--cwd', worktreePath, '--label', 'herdr-implement-daemon', '--focus'],
      result: { stdout: 'tab-2\n', stderr: '', status: 0 },
    },
    {
      args: ['pane', 'current', '--current'],
      result: { stdout: 'pane-2\n', stderr: '', status: 0 },
    },
    {
      args: [
        'pane',
        'run',
        'pane-2',
        `node skills/herdr-implement/bin/daemon.ts --worktree ${JSON.stringify(
          worktreePath,
        )} --state .agent/herdr-workflow-run.json --handles .agent/herdr-implement.json`,
      ],
      result: { stdout: '', stderr: '', status: 0 },
    },
    {
      args: ['pane', 'get', 'pane-2'],
      result: {
        stdout: `${JSON.stringify({ result: { pane: { pane_id: 'pane-2', tab_id: 'tab-2', terminal_id: 'term-2' } } })}\n`,
        stderr: '',
        status: 0,
      },
    },
  ]);

  const result = await bootstrap({ cwd: repo, issue: '#16', runner: baseRunner });

  assert.equal(result.mode, 'recovery');
  assert.equal(result.health, 'healthy');
  assert.equal(result.daemonPaneId, 'pane-2');
  assert.equal(readDaemonHandleState(result.handleStatePath)?.daemonPaneId, 'pane-2');
});

test('bootstrap does not reuse an unrelated Herdr worktree', async () => {
  const repo = await makeRepo();
  const repoRoot = realpathSync(repo);
  const requestedWorktreePath = mkdtempSync(join(tmpdir(), 'herdr-requested-worktree-'));
  const unrelatedWorktreePath = mkdtempSync(join(tmpdir(), 'herdr-unrelated-worktree-'));
  await makeWorktreeFixture(requestedWorktreePath);
  await makeWorktreeFixture(unrelatedWorktreePath);

  const baseRunner = createRunner([
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
        `node skills/herdr-implement/bin/daemon.ts --worktree ${JSON.stringify(
          requestedWorktreePath,
        )} --state .agent/herdr-workflow-run.json --handles .agent/herdr-implement.json`,
      ],
      result: { stdout: '', stderr: '', status: 0 },
    },
    {
      args: ['pane', 'get', 'pane-1'],
      result: {
        stdout: `${JSON.stringify({ result: { pane: { pane_id: 'pane-1', tab_id: 'tab-1', terminal_id: null } } })}\n`,
        stderr: '',
        status: 0,
      },
    },
  ]);
  const runner = {
    run(args: string[]): HerdrCommandResult {
      const result = baseRunner.run(args);
      if (args[0] === 'pane' && args[1] === 'get') {
        const runStatePath = join(requestedWorktreePath, '.agent/herdr-workflow-run.json');
        const runState = readWorkflowRunState(runStatePath);
        if (runState) {
          writeWorkflowRunState(runStatePath, {
            ...runState,
            currentPhase: 'ready',
            updatedAt: '2026-06-30T12:00:01.000Z',
          });
        }
      }
      return result;
    },
  };

  const result = await bootstrap({ cwd: repo, issue: '#16', runner });

  assert.equal(result.mode, 'new-run');
  assert.equal(result.health, 'healthy');
  assert.equal(result.worktreePath, requestedWorktreePath);
  assert.equal(result.workspaceId, 'w16');
});

test('bootstrap rejects a dirty checkout before creating a new worktree', async () => {
  const repo = await makeRepo();
  const repoRoot = realpathSync(repo);
  writeFileSync(join(repo, 'dirty.txt'), 'dirty\n', 'utf8');

  const runner = createRunner([
    {
      args: ['worktree', 'list', '--cwd', repoRoot, '--json'],
      result: { stdout: '[]\n', stderr: '', status: 0 },
    },
  ]);

  await assert.rejects(
    bootstrap({ cwd: repo, issue: '#16', runner }),
    /source checkout must be clean before creating a new worktree/,
  );
});

test('bootstrap rejects a new-run when the current branch is not the base branch', async () => {
  const repo = await makeRepo();
  const repoRoot = realpathSync(repo);
  git(repo, ['checkout', '-b', 'feature/bootstrap-test']);

  const runner = createRunner([
    {
      args: ['worktree', 'list', '--cwd', repoRoot, '--json'],
      result: { stdout: '[]\n', stderr: '', status: 0 },
    },
  ]);

  await assert.rejects(
    bootstrap({ cwd: repo, issue: '#16', runner }),
    /current branch must match base branch before creating a new worktree/,
  );
});

test('bootstrap rejects a new-run when local base differs from origin/base', async () => {
  const repo = await makeRepo();
  const repoRoot = realpathSync(repo);
  git(repo, ['commit', '--allow-empty', '-m', 'advance local main']);

  const runner = createRunner([
    {
      args: ['worktree', 'list', '--cwd', repoRoot, '--json'],
      result: { stdout: '[]\n', stderr: '', status: 0 },
    },
  ]);

  await assert.rejects(
    bootstrap({ cwd: repo, issue: '#16', runner }),
    /fetch\/pull latest and retry: local main does not match origin\/main/,
  );
});

test('bootstrap rejects a new-run when origin HEAD cannot be resolved', async () => {
  const repo = await makeRepo();
  const repoRoot = realpathSync(repo);
  git(repo, ['symbolic-ref', '-d', 'refs/remotes/origin/HEAD']);

  const runner = createRunner([
    {
      args: ['worktree', 'list', '--cwd', repoRoot, '--json'],
      result: { stdout: '[]\n', stderr: '', status: 0 },
    },
  ]);

  await assert.rejects(
    bootstrap({ cwd: repo, issue: '#16', runner }),
    /unable to resolve origin\/HEAD; fetch\/pull latest and retry/,
  );
});

test('bootstrap rejects a found worktree with no matching run state', async () => {
  const repo = await makeRepo();
  const repoRoot = realpathSync(repo);
  const worktreePath = mkdtempSync(join(tmpdir(), 'herdr-bootstrap-worktree-'));
  await makeWorktreeFixture(worktreePath);

  const runner = createRunner([
    {
      args: ['worktree', 'list', '--cwd', repoRoot, '--json'],
      result: {
        stdout: `${JSON.stringify([{ workspaceId: 'w16', worktreePath, branch: 'issue-16-herdr-implement' }])}\n`,
        stderr: '',
        status: 0,
      },
    },
  ]);

  await assert.rejects(
    bootstrap({ cwd: repo, issue: '#16', runner }),
    (error) => {
      assert.ok(error instanceof BootstrapError);
      assert.equal(error.diagnostics?.mode, 'recovery');
      assert.equal(error.diagnostics?.worktreePath, worktreePath);
      assert.equal(error.diagnostics?.runStatePath, join(worktreePath, '.agent/herdr-workflow-run.json'));
      assert.equal(error.diagnostics?.handleStatePath, join(worktreePath, '.agent/herdr-implement.json'));
      assert.equal(error.diagnostics?.reason, 'missing workflow run state');
      return true;
    },
  );
});

test('bootstrap wraps post-state daemon launch failures with operator diagnostics', async () => {
  const repo = await makeRepo();
  const worktreePath = mkdtempSync(join(tmpdir(), 'herdr-bootstrap-worktree-'));
  await makeWorktreeFixture(worktreePath);

  await assert.rejects(
    bootstrap({
      cwd: repo,
      issue: '#16',
      adapter: createAdapter({
        findWorktreeByBranch() {
          return null;
        },
        createWorktree() {
          return {
            workspaceId: 'w16',
            worktreePath,
            branchName: 'issue-16-herdr-implement',
          };
        },
        createDaemonPane() {
          throw new Error('tab create failed');
        },
      }),
    }),
    (error) => {
      assert.ok(error instanceof BootstrapError);
      assert.equal(error.diagnostics?.mode, 'new-run');
      assert.equal(error.diagnostics?.worktreePath, worktreePath);
      assert.equal(error.diagnostics?.workspaceId, 'w16');
      assert.equal(error.diagnostics?.runStatePath, join(worktreePath, '.agent/herdr-workflow-run.json'));
      assert.equal(error.diagnostics?.handleStatePath, join(worktreePath, '.agent/herdr-implement.json'));
      assert.equal(error.diagnostics?.currentPhase, 'setup');
      assert.equal(error.diagnostics?.reason, 'tab create failed');
      return true;
    },
  );
});

test('bootstrap wraps post-state daemon command failures with operator diagnostics', async () => {
  const repo = await makeRepo();
  const worktreePath = mkdtempSync(join(tmpdir(), 'herdr-bootstrap-worktree-'));
  await makeWorktreeFixture(worktreePath);
  writeWorkflowRunState(join(worktreePath, '.agent/herdr-workflow-run.json'), workflowStateFixture(worktreePath, 16, 'ready'));
  writeDaemonHandleState(join(worktreePath, '.agent/herdr-implement.json'), handleStateFixture(worktreePath, 16, 'tab-1', 'pane-1'));

  await assert.rejects(
    bootstrap({
      cwd: repo,
      issue: '#16',
      adapter: createAdapter({
        findWorktreeByBranch() {
          return {
            workspaceId: 'w16',
            worktreePath,
            branchName: 'issue-16-herdr-implement',
          };
        },
        createWorktree() {
          throw new Error('not used');
        },
        createDaemonPane() {
          return {
            tabId: 'tab-2',
            paneId: 'pane-2',
            terminalId: null,
          };
        },
        getPaneInfo() {
          return {
            tabId: 'tab-2',
            paneId: 'pane-2',
            terminalId: null,
          };
        },
        runPaneCommand() {
          throw new Error('daemon launch command failed');
        },
      }),
    }),
    (error) => {
      assert.ok(error instanceof BootstrapError);
      assert.equal(error.diagnostics?.mode, 'recovery');
      assert.equal(error.diagnostics?.worktreePath, worktreePath);
      assert.equal(error.diagnostics?.workspaceId, 'w16');
      assert.equal(error.diagnostics?.daemonTabId, 'tab-2');
      assert.equal(error.diagnostics?.daemonPaneId, 'pane-2');
      assert.equal(error.diagnostics?.runStatePath, join(worktreePath, '.agent/herdr-workflow-run.json'));
      assert.equal(error.diagnostics?.handleStatePath, join(worktreePath, '.agent/herdr-implement.json'));
      assert.equal(error.diagnostics?.currentPhase, 'ready');
      assert.equal(error.diagnostics?.reason, 'daemon launch command failed');
      return true;
    },
  );
});

test('bootstrap tolerates a dirty checkout and moved base branch during recovery', async () => {
  const repo = await makeRepo();
  const worktreePath = mkdtempSync(join(tmpdir(), 'herdr-bootstrap-worktree-'));
  await makeWorktreeFixture(worktreePath);
  writeFileSync(join(repo, 'dirty.txt'), 'dirty\n', 'utf8');
  git(repo, ['commit', '--allow-empty', '-m', 'advance local main']);
  writeWorkflowRunState(join(worktreePath, '.agent/herdr-workflow-run.json'), workflowStateFixture(worktreePath, 16, 'ready'));
  writeDaemonHandleState(join(worktreePath, '.agent/herdr-implement.json'), handleStateFixture(worktreePath, 16, 'tab-1', 'pane-1'));

  const result = await bootstrap({
    cwd: repo,
    issue: '#16',
    adapter: createAdapter({
      findWorktreeByBranch(_repository, branchName) {
        assert.equal(branchName, 'issue-16-herdr-implement');
        return {
          workspaceId: 'w16',
          worktreePath,
          branchName,
        };
      },
      createWorktree() {
        throw new Error('not used');
      },
      getPaneInfo(paneId) {
        return paneId === 'pane-1'
          ? {
              tabId: 'tab-1',
              paneId: 'pane-1',
              terminalId: 'term-1',
            }
          : null;
      },
    }),
  });

  assert.equal(result.mode, 'recovery');
  assert.equal(result.health, 'healthy');
  assert.equal(result.worktreePath, worktreePath);
});

test('bootstrap times out when daemon state never progresses', async () => {
  const repo = await makeRepo();
  const worktreePath = mkdtempSync(join(tmpdir(), 'herdr-bootstrap-worktree-'));
  await makeWorktreeFixture(worktreePath);

  const result = await bootstrap({
    cwd: repo,
    issue: '#16',
    waitForHealthyDaemonMs: 0,
    adapter: createAdapter({
      findWorktreeByBranch() {
        return null;
      },
      createWorktree() {
        return {
          workspaceId: 'w16',
          worktreePath,
          branchName: 'issue-16-herdr-implement',
        };
      },
      createDaemonPane() {
        return {
          tabId: 'tab-1',
          paneId: 'pane-1',
          terminalId: null,
        };
      },
      getPaneInfo(paneId) {
        return paneId === 'pane-1'
          ? {
              tabId: 'tab-1',
              paneId: 'pane-1',
              terminalId: null,
            }
          : null;
      },
      runPaneCommand() {},
    }),
  });

  assert.equal(result.mode, 'new-run');
  assert.equal(result.health, 'timed-out');
  assert.equal(result.currentPhase, 'setup');
});

test('bootstrap reports pane-exited immediately when the daemon pane disappears', async () => {
  const repo = await makeRepo();
  const worktreePath = mkdtempSync(join(tmpdir(), 'herdr-bootstrap-worktree-'));
  await makeWorktreeFixture(worktreePath);
  let paneLookups = 0;

  const result = await bootstrap({
    cwd: repo,
    issue: '#16',
    waitForHealthyDaemonMs: 0,
    adapter: createAdapter({
      findWorktreeByBranch() {
        return null;
      },
      createWorktree() {
        return {
          workspaceId: 'w16',
          worktreePath,
          branchName: 'issue-16-herdr-implement',
        };
      },
      createDaemonPane() {
        return {
          tabId: 'tab-1',
          paneId: 'pane-1',
          terminalId: null,
        };
      },
      getPaneInfo() {
        paneLookups += 1;
        return null;
      },
      runPaneCommand() {},
    }),
  });

  assert.equal(paneLookups, 1);
  assert.equal(result.mode, 'new-run');
  assert.equal(result.health, 'pane-exited');
  assert.equal(result.currentPhase, 'setup');
});

test('bootstrap CLI exits non-zero and prints startup diagnostics for pane-exited health', async () => {
  const repo = await makeRepo();
  const worktreePath = mkdtempSync(join(tmpdir(), 'herdr-bootstrap-cli-worktree-'));
  const binDir = mkdtempSync(join(tmpdir(), 'herdr-bootstrap-cli-bin-'));
  writeBootstrapCliHerdrScript(binDir);

  const result = spawnSync(
    process.execPath,
    [join(process.cwd(), 'skills/herdr-implement/bin/bootstrap.ts'), '--issue', '#16'],
    {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        HERDR_ENV: '1',
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        HERDR_FAKE_MODE: 'pane-exited',
        HERDR_FAKE_WORKTREE_PATH: worktreePath,
        HERDR_FAKE_WORKSPACE_ID: 'w16',
      },
    },
  );

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /"worktreePath":\s*"[^"]+herdr-bootstrap-cli-worktree-/);
  assert.match(result.stderr, /"workspaceId":\s*"w16"/);
  assert.match(result.stderr, /"daemonTabId":\s*"tab-1"/);
  assert.match(result.stderr, /"daemonPaneId":\s*"pane-1"/);
  assert.match(result.stderr, /"runStatePath":\s*"[^"]+\.agent\/herdr-workflow-run\.json"/);
  assert.match(result.stderr, /"handleStatePath":\s*"[^"]+\.agent\/herdr-implement\.json"/);
  assert.match(result.stderr, /"currentPhase":\s*"setup"/);
  assert.match(result.stderr, /"reason":\s*"pane-exited"/);
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

  await assert.rejects(bootstrap({ cwd: repo, issue: '#16', runner }), /herdr worktree list --cwd .* --json returned invalid JSON/);
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

  await assert.rejects(
    bootstrap({ cwd: repo, issue: '#16', runner }),
    /herdr worktree list output validation failed: worktree list.worktrees must be an array when present/,
  );
});

test('bootstrap rejects malformed Herdr pane output before recording daemon handles', async () => {
  const repo = await makeRepo();
  const repoRoot = realpathSync(repo);
  const worktreePath = mkdtempSync(join(tmpdir(), 'herdr-bootstrap-worktree-'));
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
      args: ['tab', 'create', '--workspace', 'w16', '--cwd', worktreePath, '--label', 'herdr-implement-daemon', '--focus'],
      result: { stdout: '{"tabId":17}\n', stderr: '', status: 0 },
    },
  ]);

  await assert.rejects(
    bootstrap({ cwd: repo, issue: '#16', runner }),
    /herdr tab create output validation failed: tab create.tabId must be a string when present/,
  );
  assert.equal(readDaemonHandleState(join(worktreePath, '.agent/herdr-implement.json'))?.daemonPaneId, null);
});

test('bootstrap rejects durable state that belongs to a different issue', async () => {
  const repo = await makeRepo();
  const repoRoot = realpathSync(repo);
  const worktreePath = mkdtempSync(join(tmpdir(), 'herdr-bootstrap-worktree-'));
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

  await assert.rejects(bootstrap({ cwd: repo, issue: '#16', runner }), /existing run state belongs to #15, not #16/);
});

test('bootstrap fails when pane run fails before recording started handles', async () => {
  const repo = await makeRepo();
  const repoRoot = realpathSync(repo);
  const worktreePath = mkdtempSync(join(tmpdir(), 'herdr-bootstrap-worktree-'));
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
        `node skills/herdr-implement/bin/daemon.ts --worktree ${JSON.stringify(
          worktreePath,
        )} --state .agent/herdr-workflow-run.json --handles .agent/herdr-implement.json`,
      ],
      result: { stdout: '', stderr: 'daemon failed', status: 1 },
    },
  ]);

  await assert.rejects(
    bootstrap({ cwd: repo, issue: '#16', runner }),
    (error) => {
      assert.ok(error instanceof BootstrapError);
      assert.equal(error.diagnostics?.mode, 'new-run');
      assert.equal(error.diagnostics?.worktreePath, worktreePath);
      assert.equal(error.diagnostics?.workspaceId, 'w16');
      assert.equal(error.diagnostics?.daemonTabId, 'tab-1');
      assert.equal(error.diagnostics?.daemonPaneId, 'pane-1');
      assert.equal(error.diagnostics?.runStatePath, join(worktreePath, '.agent/herdr-workflow-run.json'));
      assert.equal(error.diagnostics?.handleStatePath, join(worktreePath, '.agent/herdr-implement.json'));
      assert.equal(error.diagnostics?.currentPhase, 'setup');
      assert.match(error.diagnostics?.reason ?? '', /herdr pane run failed with exit 1: daemon failed/);
      return true;
    },
  );
  assert.equal(readDaemonHandleState(join(worktreePath, '.agent/herdr-implement.json'))?.daemonPaneId, 'pane-1');
  assert.equal(readDaemonHandleState(join(worktreePath, '.agent/herdr-implement.json'))?.daemonTabId, 'tab-1');
});

test('daemon step stops immediately on a terminal phase', async () => {
  const repo = await makeRepo();
  const worktreePath = mkdtempSync(join(tmpdir(), 'herdr-bootstrap-worktree-'));
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

test('daemon step rejects incompatible daemon handle state before recovery', async () => {
  const repo = await makeRepo();
  const worktreePath = join(repo, 'issue-worktree');
  await makeWorktreeFixture(worktreePath);
  const runStatePath = join(worktreePath, '.agent/herdr-workflow-run.json');
  const handleStatePath = join(worktreePath, '.agent/herdr-implement.json');
  writeWorkflowRunState(runStatePath, workflowStateFixture(worktreePath, 17));
  writeDaemonHandleState(handleStatePath, {
    ...handleStateFixture(worktreePath, 17, 'tab-1', 'pane-1'),
    runStatePath: join(worktreePath, '.agent/other-run.json'),
    workspaceId: 'w999',
    worktreePath: join(repo, 'other-worktree'),
  });

  assert.throws(
    () =>
      daemonStep({
        cwd: worktreePath,
        statePath: '.agent/herdr-workflow-run.json',
        handleStatePath: '.agent/herdr-implement.json',
        runner: createRunner([]),
        now: () => new Date('2026-06-30T12:34:56.000Z'),
      }),
    /runStatePath mismatch|handleStatePath mismatch|workspaceId mismatch|worktreePath mismatch/,
  );
});

test('daemon step uses the adapter for agent status recovery decisions', async () => {
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
    adapter: createAdapter({
      getAgentStatus() {
        return {
          agentName: 'issue-18-implementer',
          paneId: 'pane-impl',
          tabId: 'tab-impl',
          terminalId: 'term-impl',
          status: 'missing',
          rawStatus: null,
          failure: {
            kind: 'command-failed',
            command: 'agent get issue-18-implementer',
            exitCode: 1,
            stderr: 'missing',
          },
        };
      },
    }),
    now: () => new Date('2026-06-30T12:34:56.000Z'),
  });

  assert.equal(result.status, 'continue');
  assert.equal(result.nextPhase, 'blocked');
  assert.equal(readWorkflowRunState(runStatePath)?.currentPhase, 'blocked');
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
        agentNameTemplate: 'issue-{{ issue.slug }}-simplifier',
        model: 'gpt-5.4-mini',
        resultSchemas: ['simplifier-result-v1'],
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
    payload: {
      simplificationSummary: 'Focused validation into a schema module.',
      changedFiles: ['skills/herdr-implement/src/result-schema.ts'],
      checksRun: ['node --test skills/herdr-implement/test/*.test.ts'],
      checksDeferred: [],
      blockers: [],
    },
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

test('daemon step executes a script phase directly, records logs, and routes by stdout token', async () => {
  const repo = await makeRepo();
  const worktreePath = join(repo, 'issue-worktree');
  await makeScriptWorkflowFixture(
    worktreePath,
    `#!/bin/sh
set -eu
printf '%s' "$PWD" > .agent/script-cwd.txt
printf '%s' "$HERDR_TEST_GREETING" > .agent/script-greeting.txt
printf '%s,%s,%s' "$1" "$2" "$3" > .agent/script-args.txt
printf 'stderr-line\\n' >&2
printf 'success\\n'
`,
  );

  const runStatePath = join(worktreePath, '.agent/herdr-workflow-run.json');
  const handleStatePath = join(worktreePath, '.agent/herdr-implement.json');
  writeWorkflowRunState(runStatePath, scriptWorkflowStateFixture(worktreePath, 19));
  writeDaemonHandleState(handleStatePath, handleStateFixture(worktreePath, 19, 'tab-1', 'pane-1'));

  const result = daemonStep({
    cwd: worktreePath,
    statePath: '.agent/herdr-workflow-run.json',
    handleStatePath: '.agent/herdr-implement.json',
    runner: createRunner([]),
    now: () => new Date('2026-06-30T12:34:56.000Z'),
  });

  assert.equal(result.status, 'continue');
  assert.equal(result.currentPhase, 'run_script');
  assert.equal(result.nextPhase, 'done');
  const runState = readWorkflowRunState(runStatePath);
  assert.equal(runState?.currentPhase, 'done');
  assert.equal(runState?.context.greeting, 'hello');
  assert.equal(runState?.scriptRuns.run_script.outcome, 'success');
  assert.equal(runState?.scriptRuns.run_script.status, 'complete');
  assert.equal(runState?.scriptRuns.run_script.exitCode, 0);
  assert.equal(runState?.scriptRuns.run_script.timedOut, false);
  assert.equal(runState?.scriptRuns.run_script.stdout.trim(), 'success');
  assert.equal(runState?.scriptRuns.run_script.stderr.trim(), 'stderr-line');
  assert.equal(readFileSync(join(worktreePath, '.agent/script-cwd.txt'), 'utf8'), worktreePath);
  assert.equal(readFileSync(join(worktreePath, '.agent/script-greeting.txt'), 'utf8'), 'hello');
  assert.equal(readFileSync(join(worktreePath, '.agent/script-args.txt'), 'utf8'), `19,hello,${join(worktreePath, '.agent/script-output.txt')}`);
  assert.equal(existsSync(runState?.scriptRuns.run_script.stdoutPath ?? ''), true);
  assert.equal(existsSync(runState?.scriptRuns.run_script.stderrPath ?? ''), true);
});

test('daemon step merges JSON capture from script stdout into workflow context', async () => {
  const repo = await makeRepo();
  const worktreePath = join(repo, 'issue-worktree');
  await makeScriptWorkflowFixture(
    worktreePath,
    `#!/bin/sh
set -eu
printf '%s\\n' '{"outcome":"success","capture":{"pr_url":"https://example.test/pr/1","pr_number":"1"}}'
`,
  );

  const runStatePath = join(worktreePath, '.agent/herdr-workflow-run.json');
  const handleStatePath = join(worktreePath, '.agent/herdr-implement.json');
  writeWorkflowRunState(runStatePath, scriptWorkflowStateFixture(worktreePath, 19));
  writeDaemonHandleState(handleStatePath, handleStateFixture(worktreePath, 19, 'tab-1', 'pane-1'));

  const result = daemonStep({
    cwd: worktreePath,
    statePath: '.agent/herdr-workflow-run.json',
    handleStatePath: '.agent/herdr-implement.json',
    runner: createRunner([]),
    now: () => new Date('2026-06-30T12:34:56.000Z'),
  });

  assert.equal(result.status, 'continue');
  const runState = readWorkflowRunState(runStatePath);
  assert.equal(runState?.currentPhase, 'done');
  assert.equal(runState?.context.pr_url, 'https://example.test/pr/1');
  assert.equal(runState?.context.pr_number, '1');
  assert.equal(runState?.scriptRuns.run_script.capture?.pr_url, 'https://example.test/pr/1');
});

test('daemon step routes malformed JSON stdout from a script to failure', async () => {
  const repo = await makeRepo();
  const worktreePath = join(repo, 'issue-worktree');
  await makeScriptWorkflowFixture(
    worktreePath,
    `#!/bin/sh
set -eu
printf '%s\\n' '{not-json}'
`,
  );

  const runStatePath = join(worktreePath, '.agent/herdr-workflow-run.json');
  const handleStatePath = join(worktreePath, '.agent/herdr-implement.json');
  writeWorkflowRunState(runStatePath, scriptWorkflowStateFixture(worktreePath, 19));
  writeDaemonHandleState(handleStatePath, handleStateFixture(worktreePath, 19, 'tab-1', 'pane-1'));

  const result = daemonStep({
    cwd: worktreePath,
    statePath: '.agent/herdr-workflow-run.json',
    handleStatePath: '.agent/herdr-implement.json',
    runner: createRunner([]),
    now: () => new Date('2026-06-30T12:34:56.000Z'),
  });

  assert.equal(result.status, 'continue');
  assert.equal(result.nextPhase, 'failed');
  const runState = readWorkflowRunState(runStatePath);
  assert.equal(runState?.currentPhase, 'failed');
  assert.equal(runState?.scriptRuns.run_script.outcome, 'failure');
});

test('daemon step routes a missing script command as startup failure', async () => {
  const repo = await makeRepo();
  const worktreePath = join(repo, 'issue-worktree');
  await makeScriptWorkflowFixture(
    worktreePath,
    `#!/bin/sh
set -eu
printf 'success\\n'
`,
    { command: 'workflow-scripts/missing-script.sh' },
  );

  const runStatePath = join(worktreePath, '.agent/herdr-workflow-run.json');
  const handleStatePath = join(worktreePath, '.agent/herdr-implement.json');
  writeWorkflowRunState(runStatePath, {
    ...scriptWorkflowStateFixture(worktreePath, 19),
    workflow: normalizeWorkflow(scriptWorkflowFixture({ command: 'workflow-scripts/missing-script.sh' })) as never,
  });
  writeDaemonHandleState(handleStatePath, handleStateFixture(worktreePath, 19, 'tab-1', 'pane-1'));

  const result = daemonStep({
    cwd: worktreePath,
    statePath: '.agent/herdr-workflow-run.json',
    handleStatePath: '.agent/herdr-implement.json',
    runner: createRunner([]),
    now: () => new Date('2026-06-30T12:34:56.000Z'),
  });

  assert.equal(result.status, 'continue');
  assert.equal(result.nextPhase, 'failed');
  const runState = readWorkflowRunState(runStatePath);
  assert.equal(runState?.currentPhase, 'failed');
  assert.equal(runState?.scriptRuns.run_script.outcome, 'failure');
});

test('daemon step routes a non-zero script exit without stdout outcome to failure', async () => {
  const repo = await makeRepo();
  const worktreePath = join(repo, 'issue-worktree');
  await makeScriptWorkflowFixture(
    worktreePath,
    `#!/bin/sh
set -eu
exit 7
`,
  );

  const runStatePath = join(worktreePath, '.agent/herdr-workflow-run.json');
  const handleStatePath = join(worktreePath, '.agent/herdr-implement.json');
  writeWorkflowRunState(runStatePath, scriptWorkflowStateFixture(worktreePath, 19));
  writeDaemonHandleState(handleStatePath, handleStateFixture(worktreePath, 19, 'tab-1', 'pane-1'));

  const result = daemonStep({
    cwd: worktreePath,
    statePath: '.agent/herdr-workflow-run.json',
    handleStatePath: '.agent/herdr-implement.json',
    runner: createRunner([]),
    now: () => new Date('2026-06-30T12:34:56.000Z'),
  });

  assert.equal(result.status, 'continue');
  assert.equal(result.nextPhase, 'failed');
  const runState = readWorkflowRunState(runStatePath);
  assert.equal(runState?.currentPhase, 'failed');
  assert.equal(runState?.scriptRuns.run_script.exitCode, 7);
  assert.equal(runState?.scriptRuns.run_script.outcome, 'failure');
});

test('daemon step routes a timeout script to timeout', async () => {
  const repo = await makeRepo();
  const worktreePath = join(repo, 'issue-worktree');
  await makeScriptWorkflowFixture(
    worktreePath,
    `#!/bin/sh
set -eu
while :; do
  :
done
printf 'success\\n'
`,
    { timeoutSeconds: 0.05 },
  );

  const runStatePath = join(worktreePath, '.agent/herdr-workflow-run.json');
  const handleStatePath = join(worktreePath, '.agent/herdr-implement.json');
  writeWorkflowRunState(
    runStatePath,
    scriptWorkflowStateFixture(worktreePath, 19, 'run_script', { timeoutSeconds: 0.05 }),
  );
  writeDaemonHandleState(handleStatePath, handleStateFixture(worktreePath, 19, 'tab-1', 'pane-1'));

  const result = daemonStep({
    cwd: worktreePath,
    statePath: '.agent/herdr-workflow-run.json',
    handleStatePath: '.agent/herdr-implement.json',
    runner: createRunner([]),
    now: () => new Date('2026-06-30T12:34:56.000Z'),
  });

  assert.equal(result.status, 'continue');
  assert.equal(result.nextPhase, 'timeout');
  const runState = readWorkflowRunState(runStatePath);
  assert.equal(runState?.currentPhase, 'timeout');
  assert.equal(runState?.scriptRuns.run_script.status, 'timeout');
  assert.equal(runState?.scriptRuns.run_script.timedOut, true);
});

test('daemon step does not rerun a completed non-retryable script phase during recovery', async () => {
  const repo = await makeRepo();
  const worktreePath = join(repo, 'issue-worktree');
  await makeScriptWorkflowFixture(
    worktreePath,
    `#!/bin/sh
set -eu
printf 'should-not-run\\n' > .agent/should-not-run.txt
printf 'success\\n'
`,
  );

  const runStatePath = join(worktreePath, '.agent/herdr-workflow-run.json');
  const handleStatePath = join(worktreePath, '.agent/herdr-implement.json');
  writeWorkflowRunState(runStatePath, {
    ...scriptWorkflowStateFixture(worktreePath, 19),
    scriptRuns: {
      run_script: {
        phaseId: 'run_script',
        runId: 'issue-19-run_script-script',
        command: 'workflow-scripts/run-script.sh',
        resolvedCommandPath: join(worktreePath, '.agent/workflow-scripts/run-script.sh'),
        args: ['19', 'hello', join(worktreePath, '.agent/script-output.txt')],
        cwd: worktreePath,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: process.env.HOME ?? '',
          TMPDIR: process.env.TMPDIR ?? '/tmp',
          PWD: worktreePath,
          HERDR_ISSUE_CANONICAL: '#19',
          HERDR_ISSUE_INPUT: '#19',
          HERDR_ISSUE_SLUG: '19',
          HERDR_PHASE_ID: 'run_script',
          HERDR_RUN_ID: 'issue-19-run_script-script',
          HERDR_WORKFLOW_PATH: join(worktreePath, '.agent/herdr-workflow.yaml'),
          HERDR_WORKFLOW_BRANCH: 'issue-19-herdr-implement',
          HERDR_WORKFLOW_CURRENT_PHASE: 'run_script',
          HERDR_WORKSPACE_ID: 'w19',
          HERDR_WORKTREE_PATH: worktreePath,
          HERDR_TEST_GREETING: 'hello',
        },
        timeoutSeconds: 30,
        startedAt: '2026-06-30T12:00:00.000Z',
        finishedAt: '2026-06-30T12:00:01.000Z',
        durationMs: 1000,
        timedOut: false,
        exitCode: 0,
        signal: null,
        status: 'complete',
        outcome: 'success',
        capture: null,
        stdout: 'success\n',
        stderr: '',
        stdoutPath: join(worktreePath, '.agent/runs/issue-19-run_script-script/stdout.log'),
        stderrPath: join(worktreePath, '.agent/runs/issue-19-run_script-script/stderr.log'),
        rawOutputPath: join(worktreePath, '.agent/runs/issue-19-run_script-script/raw.log'),
        retryable: false,
      },
    },
  });
  writeDaemonHandleState(handleStatePath, handleStateFixture(worktreePath, 19, 'tab-1', 'pane-1'));

  const result = daemonStep({
    cwd: worktreePath,
    statePath: '.agent/herdr-workflow-run.json',
    handleStatePath: '.agent/herdr-implement.json',
    runner: createRunner([]),
    now: () => new Date('2026-06-30T12:34:56.000Z'),
  });

  assert.equal(result.status, 'continue');
  assert.equal(result.nextPhase, 'done');
  assert.equal(existsSync(join(worktreePath, '.agent/should-not-run.txt')), false);
  const runState = readWorkflowRunState(runStatePath);
  assert.equal(runState?.currentPhase, 'done');
});

test('daemon step recovers completed shipping and cleanup phases without rerunning them', async () => {
  const cases = [
    { phaseId: 'commit_changes', outcome: 'success', nextPhase: 'push_branch', marker: 'commit_changes.ran' },
    { phaseId: 'push_branch', outcome: 'success', nextPhase: 'create_pr', marker: 'push_branch.ran' },
    { phaseId: 'create_pr', outcome: 'existing', nextPhase: 'await_review', marker: 'create_pr.ran' },
    { phaseId: 'cleanup', outcome: 'success', nextPhase: 'complete', marker: 'cleanup.ran' },
  ] as const;

  for (const currentCase of cases) {
    const repo = await makeRepo();
    const worktreePath = join(repo, 'issue-worktree');
    await makeWorktreeFixture(worktreePath);
    installDefaultWorkflowFixture(worktreePath);
    installRecoveryMarkerScripts(worktreePath);

    const runStatePath = join(worktreePath, '.agent/herdr-workflow-run.json');
    const handleStatePath = join(worktreePath, '.agent/herdr-implement.json');
    writeWorkflowRunState(runStatePath, {
      ...defaultWorkflowRecoveryStateFixture(worktreePath, 19, currentCase.phaseId),
      currentPhase: currentCase.phaseId,
      scriptRuns: {
        [currentCase.phaseId]: completedScriptRunFixture(worktreePath, 19, currentCase.phaseId, currentCase.outcome),
      },
    });
    writeDaemonHandleState(handleStatePath, handleStateFixture(worktreePath, 19, 'tab-1', 'pane-1'));

    const result = daemonStep({
      cwd: worktreePath,
      statePath: '.agent/herdr-workflow-run.json',
      handleStatePath: '.agent/herdr-implement.json',
      runner: createRunner([]),
      now: () => new Date('2026-06-30T12:34:56.000Z'),
    });

    assert.equal(result.status, 'continue');
    assert.equal(result.nextPhase, currentCase.nextPhase);
    assert.equal(existsSync(join(worktreePath, '.agent', `${currentCase.marker}`)), false);
    assert.equal(readWorkflowRunState(runStatePath)?.currentPhase, currentCase.nextPhase);
  }
});
