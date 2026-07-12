import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  bootstrap,
  daemonStep,
  readDaemonHandleState,
  readWorkflowRunState,
  writeWorkflowRunState,
  type DaemonStepResult,
} from '../src/runtime.ts';
import type { HerdrAdapter, HerdrAgentInfo, HerdrPaneInfo, RepositoryInfo, WorktreeInfo } from '../src/herdr-adapter.ts';

type AgentPlan = {
  outcome: string;
  status?: 'complete' | 'blocked' | 'failed';
  capture?: Record<string, unknown>;
};

type ScenarioOptions = {
  issueNumber?: number;
  agentPlans: Record<string, AgentPlan[]>;
  reviewPoll?: string[];
  mergePoll?: string[];
  runChecks?: string[];
  commit?: string[];
  push?: string[];
  createPr?: string[];
  cleanup?: string[];
};

type AgentDispatch = {
  roleLabel: string;
  agentName: string;
  prompt: string;
};

class DefaultWorkflowFakeHerdr implements HerdrAdapter {
  readonly worktreeCreations: WorktreeInfo[] = [];
  readonly worktreeEnsures: WorktreeInfo[] = [];
  readonly daemonCommands: string[] = [];
  readonly launchedAgents: AgentDispatch[] = [];
  readonly submittedPanes: string[] = [];
  readonly prompts = new Map<string, string>();
  readonly roleAgents = new Map<string, { pane: HerdrPaneInfo; agentName: string }>();
  readonly worktreePath: string;
  private readonly agentPlans: Record<string, AgentPlan[]>;

  constructor(
    worktreePath: string,
    agentPlans: Record<string, AgentPlan[]>,
  ) {
    this.worktreePath = worktreePath;
    this.agentPlans = agentPlans;
  }

  findWorktreeByBranch(_repository: RepositoryInfo, branchName: string): WorktreeInfo | null {
    if (this.worktreeCreations.length === 0) {
      return null;
    }

    const worktree = this.worktreeCreations[0];
    return worktree.branchName === branchName ? worktree : null;
  }

  createWorktree(_repository: RepositoryInfo, branchName: string, issueLabel: string): WorktreeInfo {
    const worktree = {
      workspaceId: 'w-e2e',
      worktreePath: this.worktreePath,
      branchName,
    };
    this.worktreeEnsures.push(worktree);
    if (this.worktreeCreations.length === 0) {
      this.worktreeCreations.push(worktree);
      appendEvent(this.worktreePath, { type: 'worktree-create', issueLabel, branchName });
    } else {
      appendEvent(this.worktreePath, { type: 'worktree-reuse', issueLabel, branchName });
    }
    return worktree;
  }

  ensureWorktree(repository: RepositoryInfo, branchName: string, issueLabel: string): WorktreeInfo {
    return this.findWorktreeByBranch(repository, branchName) ?? this.createWorktree(repository, branchName, issueLabel);
  }

  createDaemonPane(workspaceId: string): HerdrPaneInfo {
    return {
      tabId: `${workspaceId}:daemon`,
      paneId: `${workspaceId}:daemon-pane`,
      terminalId: 'term-daemon',
    };
  }

  getPaneInfo(paneId: string): HerdrPaneInfo | null {
    if (paneId === 'w-e2e:daemon-pane') {
      const runStatePath = join(this.worktreePath, '.agent/herdr-workflow-run.json');
      const current = readWorkflowRunState(runStatePath);
      if (current) {
        writeWorkflowRunState(runStatePath, {
          ...current,
          updatedAt: new Date().toISOString(),
        });
      }
      return {
        tabId: 'w-e2e:daemon',
        paneId,
        terminalId: 'term-daemon',
      };
    }
    return null;
  }

  readPaneTranscript(): string {
    return '';
  }

  runPaneCommand(_paneId: string, command: string): void {
    this.daemonCommands.push(command);
    appendEvent(this.worktreePath, { type: 'daemon-command', command });
  }

  launchRoleAgent(
    _worktreePath: string,
    workspaceId: string,
    _role: Record<string, unknown>,
    roleLabel: string,
    agentName: string,
  ): HerdrPaneInfo {
    const pane = {
      tabId: `${workspaceId}:${roleLabel}`,
      paneId: `${workspaceId}:${roleLabel}-pane`,
      terminalId: `term-${roleLabel}`,
    };
    this.roleAgents.set(agentName, { pane, agentName });
    this.launchedAgents.push({ roleLabel, agentName, prompt: '' });
    appendEvent(this.worktreePath, { type: 'agent-launch', roleLabel, agentName });
    return pane;
  }

  sendPrompt(agentName: string, prompt: string): void {
    this.prompts.set(agentName, prompt);
    const launched = this.launchedAgents.find((agent) => agent.agentName === agentName);
    if (launched) {
      launched.prompt = prompt;
    }
    appendEvent(this.worktreePath, { type: 'agent-prompt', agentName, phase: metadataFromPrompt(prompt).phase });
  }

  submitPrompt(paneId: string): void {
    this.submittedPanes.push(paneId);
    const entry = Array.from(this.roleAgents.values()).find((agent) => agent.pane.paneId === paneId);
    assert.ok(entry, `unknown submitted pane ${paneId}`);
    const prompt = this.prompts.get(entry.agentName);
    assert.ok(prompt, `missing prompt for ${entry.agentName}`);

    const metadata = metadataFromPrompt(prompt);
    const plan = this.nextPlan(metadata.phase);
    writeResultArtifact(metadata.resultPath, metadata, plan);
    appendEvent(this.worktreePath, {
      type: 'agent-result',
      agentName: entry.agentName,
      phase: metadata.phase,
      outcome: plan.outcome,
    });
  }

  getAgentStatus(agentName: string): HerdrAgentInfo {
    const roleAgent = this.roleAgents.get(agentName);
    return {
      agentName,
      paneId: roleAgent?.pane.paneId ?? null,
      tabId: roleAgent?.pane.tabId ?? null,
      terminalId: roleAgent?.pane.terminalId ?? null,
      status: roleAgent ? 'idle' : 'missing',
      rawStatus: roleAgent ? 'idle' : null,
      failure: null,
    };
  }

  readAgentTranscript(agentName: string): string {
    return this.prompts.get(agentName) ?? '';
  }

  private nextPlan(phase: string): AgentPlan {
    const plans = this.agentPlans[phase];
    assert.ok(plans?.length, `missing agent plan for phase ${phase}`);
    return plans.shift()!;
  }
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function appendEvent(worktreePath: string, event: Record<string, unknown>): void {
  const path = join(worktreePath, '.agent/e2e-events.log');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(event)}\n`, { flag: 'a' });
}

function readEvents(worktreePath: string): Array<Record<string, unknown>> {
  const path = join(worktreePath, '.agent/e2e-events.log');
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function metadataFromPrompt(prompt: string): {
  runId: string;
  phase: string;
  role: string;
  resultPath: string;
  resultSchema: string;
} {
  return {
    runId: requirePromptMatch(prompt, /- Run id: ([^\n]+)/),
    phase: requirePromptMatch(prompt, /- Phase id: ([^\n]+)/),
    role: requirePromptMatch(prompt, /- Completion role: ([^\n]+)/),
    resultPath: requirePromptMatch(prompt, /- Result path: ([^\n]+)/),
    resultSchema: schemaForPhase(requirePromptMatch(prompt, /- Phase id: ([^\n]+)/)),
  };
}

function requirePromptMatch(prompt: string, pattern: RegExp): string {
  const match = prompt.match(pattern);
  assert.ok(match, `prompt did not match ${pattern}`);
  return match[1].trim();
}

function schemaForPhase(phase: string): string {
  switch (phase) {
    case 'simplify':
      return 'simplifier-result-v1';
    case 'review':
      return 'reviewer-result-v1';
    case 'verify':
      return 'verifier-result-v1';
    default:
      return 'implementer-result-v1';
  }
}

function writeResultArtifact(
  resultPath: string,
  metadata: ReturnType<typeof metadataFromPrompt>,
  plan: AgentPlan,
): void {
  mkdirSync(dirname(resultPath), { recursive: true });
  const artifact: Record<string, unknown> = {
    schemaVersion: 1,
    runId: metadata.runId,
    phase: metadata.phase,
    role: metadata.role,
    status: plan.status ?? 'complete',
    outcome: plan.outcome,
    resultSchema: metadata.resultSchema,
    summary: `${metadata.phase} -> ${plan.outcome}`,
    payload: payloadFor(metadata.resultSchema, plan),
  };
  if (plan.capture) {
    artifact.capture = plan.capture;
  }
  writeFileSync(resultPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}

function payloadFor(resultSchema: string, plan: AgentPlan): Record<string, unknown> {
  switch (resultSchema) {
    case 'simplifier-result-v1':
      return {
        simplificationSummary: 'scenario simplification complete',
        changedFiles: [],
        checksRun: [],
        checksDeferred: [],
        blockers: plan.status === 'blocked' ? ['blocked by scenario'] : [],
      };
    case 'reviewer-result-v1':
      return {
        verdict: plan.outcome,
        findings: plan.outcome === 'needs_fix' ? [{ severity: 'Major', message: 'scenario finding' }] : [],
        hasBlockingFindings: plan.outcome === 'needs_fix',
      };
    case 'verifier-result-v1':
      return {
        checksSelected: ['scenario checks'],
        checksRun: ['scenario checks'],
        checksDeferred: [],
        failures: [],
        blockers: plan.status === 'blocked' ? ['blocked by scenario'] : [],
      };
    default:
      return {
        changedFiles: ['scenario.txt'],
        checksRun: [],
        checksDeferred: [],
        blockers: plan.status === 'blocked' ? ['blocked by scenario'] : [],
      };
  }
}

async function makeScenario(options: ScenarioOptions): Promise<{
  repo: string;
  adapter: DefaultWorkflowFakeHerdr;
  runToTerminal: () => DaemonStepResult[];
}> {
  const repo = mkdtempSync(join(tmpdir(), 'herdr-implement-default-e2e-'));
  const origin = mkdtempSync(join(tmpdir(), 'herdr-implement-default-e2e-origin-'));
  git(origin, ['init', '--bare']);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test User']);
  git(repo, ['remote', 'add', 'origin', origin]);
  writeFileSync(join(repo, 'README.md'), 'fixture\n', 'utf8');
  mkdirSync(join(repo, '.agent/prompts'), { recursive: true });
  mkdirSync(join(repo, '.agent/workflow-scripts'), { recursive: true });
  writeFileSync(
    join(repo, '.agent/herdr-workflow.yaml'),
    readFileSync(join(process.cwd(), 'skills/herdr-implement/workflows/default.yaml'), 'utf8'),
    'utf8',
  );
  for (const prompt of ['implement', 'simplify', 'review', 'fix', 'verify', 'handle-pr-feedback']) {
    writeFileSync(join(repo, `.agent/prompts/${prompt}.md`), `${prompt} {{ runId }} {{ resultPath }}\n`, 'utf8');
  }
  installScripts(repo, options);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'initial']);
  git(repo, ['push', '-u', 'origin', 'main']);
  git(repo, ['fetch', 'origin', 'main']);
  git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);

  const adapter = new DefaultWorkflowFakeHerdr(repo, structuredClone(options.agentPlans));
  await bootstrap({
    cwd: repo,
    issue: `#${options.issueNumber ?? 24}`,
    adapter,
    now: () => new Date('2026-07-08T12:00:00.000Z'),
  });

  return {
    repo,
    adapter,
    runToTerminal() {
      return runToTerminal(repo, adapter);
    },
  };
}

function installScripts(repo: string, options: ScenarioOptions): void {
  writeScript(repo, 'post-worktree-setup.sh', simpleOutcomeScript('post_worktree_setup', ['skipped']));
  writeScript(repo, 'run-checks.sh', simpleOutcomeScript('run_checks', options.runChecks ?? ['success']));
  writeScript(repo, 'commit-changes.sh', simpleOutcomeScript('commit_changes', options.commit ?? ['success'], { commit_sha: 'abc123' }));
  writeScript(repo, 'push-branch.sh', simpleOutcomeScript('push_branch', options.push ?? ['success']));
  writeScript(repo, 'create-pr.sh', simpleOutcomeScript('create_pr', options.createPr ?? ['success'], { pr_url: 'https://github.com/example/repo/pull/24', pr_number: 24 }));
  writeScript(repo, 'cleanup-worktree.sh', simpleOutcomeScript('cleanup', options.cleanup ?? ['success']));
  writeScript(repo, 'check-pr-review.sh', simpleOutcomeScript('await_review', options.reviewPoll ?? ['approved']));
  writeScript(repo, 'check-pr-merged.sh', simpleOutcomeScript('await_merge', options.mergePoll ?? ['merged']));
}

function writeScript(repo: string, name: string, body: string): void {
  const path = join(repo, '.agent/workflow-scripts', name);
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

function simpleOutcomeScript(phase: string, outcomes: string[], capture: Record<string, unknown> = {}): string {
  const captureJson = JSON.stringify(capture);
  return `#!/usr/bin/env node
const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('node:fs');
const { dirname, join } = require('node:path');
const cwd = process.cwd();
const statePath = join(cwd, '.agent/e2e-${phase}.json');
const eventPath = join(cwd, '.agent/e2e-events.log');
const defaults = ${JSON.stringify(outcomes)};
let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { index: 0, outcomes: defaults };
const outcome = state.outcomes[Math.min(state.index, state.outcomes.length - 1)];
state.index += 1;
mkdirSync(dirname(statePath), { recursive: true });
writeFileSync(statePath, JSON.stringify(state, null, 2));
writeFileSync(eventPath, JSON.stringify({ type: 'script', phase: '${phase}', outcome }) + '\\n', { flag: 'a' });
const capture = ${captureJson};
process.stdout.write(JSON.stringify({ outcome, capture }) + '\\n');
`;
}

function runToTerminal(repo: string, adapter: HerdrAdapter): DaemonStepResult[] {
  const results: DaemonStepResult[] = [];
  for (let index = 0; index < 80; index += 1) {
    const result = daemonStep({
      cwd: repo,
      adapter,
      now: () => new Date(`2026-07-08T12:${String(index).padStart(2, '0')}:00.000Z`),
    });
    results.push(result);
    if (result.status === 'stop') {
      return results;
    }
  }
  assert.fail('workflow did not reach a terminal phase within 80 daemon steps');
}

function runUntilPhase(repo: string, adapter: HerdrAdapter, phase: string): DaemonStepResult[] {
  const results: DaemonStepResult[] = [];
  for (let index = 0; index < 80; index += 1) {
    const result = daemonStep({
      cwd: repo,
      adapter,
      now: () => new Date(`2026-07-08T13:${String(index).padStart(2, '0')}:00.000Z`),
    });
    results.push(result);
    if (terminalPhase(repo) === phase) {
      return results;
    }
    assert.notEqual(result.status, 'stop', `workflow stopped before reaching ${phase}`);
  }
  assert.fail(`workflow did not reach ${phase} within 80 daemon steps`);
}

function terminalPhase(repo: string): string {
  return readWorkflowRunState(join(repo, '.agent/herdr-workflow-run.json'))?.currentPhase ?? '';
}

test('default workflow E2E completes the happy path without live Herdr or GitHub mutation', async () => {
  const scenario = await makeScenario({
    agentPlans: {
      implement: [{ outcome: 'complete' }],
      simplify: [{ outcome: 'no_changes' }],
      review: [{ outcome: 'approved' }],
      verify: [{ outcome: 'complete' }],
    },
  });

  scenario.runToTerminal();

  assert.equal(terminalPhase(scenario.repo), 'complete');
  assert.equal(scenario.adapter.worktreeCreations.length, 1);
  assert.deepEqual(
    scenario.adapter.launchedAgents.map((agent) => agent.roleLabel),
    ['implementer', 'simplifier', 'reviewer', 'verifier'],
  );
  const state = readWorkflowRunState(join(scenario.repo, '.agent/herdr-workflow-run.json'));
  assert.ok(state);
  assert.equal(state.context.pr_url, 'https://github.com/example/repo/pull/24');
  assert.equal(state.context.pr_number, 24);
  assert.ok(state.scriptRuns.commit_changes.rawOutputPath.endsWith('raw.log'));
  assert.ok(readDaemonHandleState(join(scenario.repo, '.agent/herdr-implement.json'))?.roleAgents.reviewer);
  assert.ok(readEvents(scenario.repo).some((event) => event.type === 'script' && event.phase === 'cleanup'));
});

test('default workflow E2E follows review findings through fix and re-review', async () => {
  const scenario = await makeScenario({
    agentPlans: {
      implement: [{ outcome: 'complete' }, { outcome: 'complete' }],
      simplify: [{ outcome: 'no_changes' }, { outcome: 'no_changes' }],
      review: [{ outcome: 'needs_fix', capture: { review_feedback: 'fix it' } }, { outcome: 'approved' }],
      fix: [{ outcome: 'complete' }],
      verify: [{ outcome: 'complete' }],
    },
  });

  scenario.runToTerminal();

  assert.equal(terminalPhase(scenario.repo), 'complete');
  assert.deepEqual(
    scenario.adapter.launchedAgents.map((agent) => agent.roleLabel),
    ['implementer', 'simplifier', 'reviewer', 'verifier'],
  );
  assert.ok(readEvents(scenario.repo).some((event) => event.type === 'agent-result' && event.phase === 'fix'));
});

test('default workflow E2E handles PR feedback then resumes polling', async () => {
  const scenario = await makeScenario({
    reviewPoll: ['changes_requested', 'approved'],
    agentPlans: {
      implement: [{ outcome: 'complete' }, { outcome: 'complete' }],
      simplify: [{ outcome: 'no_changes' }, { outcome: 'no_changes' }],
      review: [{ outcome: 'approved' }, { outcome: 'approved' }],
      verify: [{ outcome: 'complete' }, { outcome: 'complete' }],
      handle_pr_feedback: [{ outcome: 'complete', capture: { pr_feedback: 'requested changes' } }],
    },
  });

  scenario.runToTerminal();

  assert.equal(terminalPhase(scenario.repo), 'complete');
  assert.ok(readEvents(scenario.repo).some((event) => event.type === 'agent-result' && event.phase === 'handle_pr_feedback'));
  assert.ok(readEvents(scenario.repo).filter((event) => event.type === 'script' && event.phase === 'await_review').length >= 2);
});

test('default workflow E2E routes a blocked agent to the terminal blocked phase', async () => {
  const scenario = await makeScenario({
    agentPlans: {
      implement: [{ outcome: 'blocked', status: 'blocked', capture: { blocker: 'scenario blocker' } }],
    },
  });

  scenario.runToTerminal();

  assert.equal(terminalPhase(scenario.repo), 'blocked');
  const state = readWorkflowRunState(join(scenario.repo, '.agent/herdr-workflow-run.json'));
  assert.equal(state?.acceptedAgentRuns['issue-24-implement-implementer-1'].status, 'blocked');
});

test('default workflow E2E recovers from bootstrap restart without duplicate side effects', async () => {
  const scenario = await makeScenario({
    agentPlans: {
      implement: [{ outcome: 'complete' }],
      simplify: [{ outcome: 'no_changes' }],
      review: [{ outcome: 'approved' }],
      verify: [{ outcome: 'complete' }],
    },
  });

  runUntilPhase(scenario.repo, scenario.adapter, 'await_review');
  const eventsBeforeRestart = readEvents(scenario.repo);
  assert.equal(eventsBeforeRestart.filter((event) => event.type === 'agent-launch').length, 4);
  assert.equal(eventsBeforeRestart.filter((event) => event.type === 'agent-prompt').length, 4);
  assert.equal(eventsBeforeRestart.filter((event) => event.type === 'script' && event.phase === 'commit_changes').length, 1);
  assert.equal(eventsBeforeRestart.filter((event) => event.type === 'script' && event.phase === 'push_branch').length, 1);
  assert.equal(eventsBeforeRestart.filter((event) => event.type === 'script' && event.phase === 'create_pr').length, 1);

  const secondBootstrap = await bootstrap({
    cwd: scenario.repo,
    issue: '#24',
    adapter: scenario.adapter,
    now: () => new Date('2026-07-08T12:05:00.000Z'),
  });
  assert.equal(secondBootstrap.createdRunState, false);
  assert.equal(secondBootstrap.createdHandleState, false);

  scenario.runToTerminal();

  assert.equal(terminalPhase(scenario.repo), 'complete');
  assert.equal(scenario.adapter.worktreeEnsures.length, 1);
  assert.equal(scenario.adapter.worktreeCreations.length, 1);
  assert.equal(scenario.adapter.daemonCommands.length, 1);
  const events = readEvents(scenario.repo);
  assert.equal(events.filter((event) => event.type === 'agent-launch').length, 4);
  assert.equal(events.filter((event) => event.type === 'agent-prompt').length, 4);
  assert.equal(events.filter((event) => event.type === 'script' && event.phase === 'commit_changes').length, 1);
  assert.equal(events.filter((event) => event.type === 'script' && event.phase === 'push_branch').length, 1);
  assert.equal(events.filter((event) => event.type === 'script' && event.phase === 'create_pr').length, 1);
  assert.equal(events.filter((event) => event.type === 'script' && event.phase === 'cleanup').length, 1);

  rmSync(scenario.repo, { recursive: true, force: true });
});
