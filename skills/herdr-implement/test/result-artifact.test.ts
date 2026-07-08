import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  applyAcceptedResultArtifact,
  createAcceptedResultArtifactSummary,
  evaluateResultArtifact,
  type ResultArtifact,
} from '../src/result-artifact.ts';
import { validateResultArtifactAgainstSchema } from '../src/result-schema.ts';
import { normalizeWorkflow } from '../src/workflow.ts';
import type { PendingAgentRunState, WorkflowRunState } from '../src/runtime.ts';

function workflowFixture(): Record<string, unknown> {
  return {
    name: 'result-artifact',
    version: 1,
    type: 'herdr.issue',
    start: 'implement',
    roles: {
      implementer: {
        label: 'implementer',
        agentNameTemplate: 'issue-{{ issue.number }}-implementer',
        model: 'gpt-5.4-mini',
        resultSchemas: ['implementer-result-v1'],
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

function pendingRunFixture(worktreePath: string): PendingAgentRunState {
  const runId = 'issue-36-implement-implementer-1';
  return {
    runId,
    phaseId: 'implement',
    roleId: 'implementer',
    completionRole: 'implementer',
    roleLabel: 'implementer',
    agentName: 'issue-36-implementer',
    resultSchema: 'implementer-result-v1',
    resultPath: join(worktreePath, '.agent/runs', runId, 'result.json'),
    notifyTarget: 'issue-36-orchestrator',
    attemptNumber: 1,
    startedAt: '2026-07-05T01:00:00.000Z',
    status: 'pending',
  };
}

function workflowStateFixture(worktreePath: string): WorkflowRunState {
  return {
    schemaVersion: 1,
    issue: {
      input: '#36',
      number: 36,
      url: null,
      canonical: '#36',
    },
    workflowPath: join(worktreePath, '.agent/herdr-workflow.yaml'),
    workflow: normalizeWorkflow(workflowFixture()) as never,
    sourceRepo: {
      rootPath: worktreePath,
      remoteUrl: null,
      currentBranch: 'main',
      baseBranch: 'main',
    },
    branchName: 'issue-36-herdr-implement',
    worktreePath,
    workspaceId: 'w36',
    currentPhase: 'implement',
    context: { existing: 'value' },
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

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'herdr-result-artifact-'));
  await mkdir(join(dir, '.agent/runs'), { recursive: true });
  return dir;
}

function baseArtifact(run: PendingAgentRunState): ResultArtifact {
  return {
    schemaVersion: 1,
    runId: run.runId,
    role: run.roleId,
    phase: run.phaseId,
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

async function writeArtifact(path: string, artifact: Record<string, unknown>): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}

test('evaluateResultArtifact reports missing and malformed artifacts', async () => {
  const worktreePath = await tempDir();
  const pendingRun = pendingRunFixture(worktreePath);

  const missing = evaluateResultArtifact({
    resultPath: join(worktreePath, '.agent/runs/missing/result.json'),
    pendingRun,
    phase: workflowStateFixture(worktreePath).workflow.phases.implement,
  });
  assert.deepEqual(missing, { kind: 'missing' });

  const malformedPath = pendingRun.resultPath;
  await writeArtifact(malformedPath, { not: 'json' });
  await writeFile(malformedPath, '{not-json}\n', 'utf8');

  const malformed = evaluateResultArtifact({
    resultPath: malformedPath,
    pendingRun,
    phase: workflowStateFixture(worktreePath).workflow.phases.implement,
  });
  assert.equal(malformed.kind, 'invalid');
  assert.match(malformed.reason ?? '', /not valid JSON/);
});

test('evaluateResultArtifact validates required fields, schema checks, outcome, capture, and payload', async () => {
  const worktreePath = await tempDir();
  const pendingRun = pendingRunFixture(worktreePath);
  const phase = workflowStateFixture(worktreePath).workflow.phases.implement;

  const cases: Array<{
    name: string;
    artifact: Record<string, unknown>;
    reason: RegExp;
  }> = [
    {
      name: 'schema version',
      artifact: { ...baseArtifact(pendingRun), schemaVersion: 2 },
      reason: /schemaVersion must be 1/,
    },
    {
      name: 'schema mismatch',
      artifact: { ...baseArtifact(pendingRun), resultSchema: 'wrong-schema' },
      reason: /schema mismatch: expected implementer-result-v1, found wrong-schema/,
    },
    {
      name: 'missing outcome',
      artifact: (() => {
        const { outcome: _outcome, ...artifact } = baseArtifact(pendingRun);
        return artifact;
      })(),
      reason: /missing required completion fields/,
    },
    {
      name: 'invalid capture',
      artifact: { ...baseArtifact(pendingRun), capture: ['bad'] },
      reason: /capture must be an object with string keys/,
    },
    {
      name: 'invalid payload',
      artifact: { ...baseArtifact(pendingRun), payload: ['bad'] },
      reason: /payload must be an object with string keys/,
    },
    {
      name: 'invalid schema payload',
      artifact: {
        ...baseArtifact(pendingRun),
        payload: {
          changedFiles: ['skills/herdr-implement/src/runtime.ts'],
          checksRun: ['node --test skills/herdr-implement/test/*.test.ts'],
          checksDeferred: [],
          blockers: 'still blocked',
        },
      },
      reason: /payload\.blockers must be an array of strings/,
    },
    {
      name: 'invalid outcome',
      artifact: { ...baseArtifact(pendingRun), outcome: 'mystery' },
      reason: /outcome mystery is not declared/,
    },
  ];

  for (const item of cases) {
    const resultPath = join(worktreePath, '.agent/runs', item.name.replace(/\s+/g, '-'), 'result.json');
    await writeArtifact(resultPath, item.artifact);

    const result = evaluateResultArtifact({
      resultPath,
      pendingRun,
      phase,
    });

    assert.equal(result.kind, 'invalid');
    assert.match(result.reason ?? '', item.reason);
  }
});

test('evaluateResultArtifact classifies stale artifacts separately from invalid ones', async () => {
  const worktreePath = await tempDir();
  const pendingRun = pendingRunFixture(worktreePath);
  const phase = workflowStateFixture(worktreePath).workflow.phases.implement;
  const resultPath = pendingRun.resultPath;

  await writeArtifact(resultPath, { ...baseArtifact(pendingRun), runId: 'issue-36-old-run-1' });

  const result = evaluateResultArtifact({
    resultPath,
    pendingRun,
    phase,
  });

  assert.equal(result.kind, 'stale');
  assert.match(result.reason ?? '', /runId mismatch/);
});

test('applyAcceptedResultArtifact updates accepted runs and merges capture into context', async () => {
  const worktreePath = await tempDir();
  const pendingRun = pendingRunFixture(worktreePath);
  const artifact = {
    ...baseArtifact(pendingRun),
    capture: { reviewFindings: 'none', extra: 'value' },
  } as ResultArtifact;
  const acceptedAt = '2026-07-05T02:00:00.000Z';

  const updatedState = applyAcceptedResultArtifact(workflowStateFixture(worktreePath), pendingRun, artifact, acceptedAt);

  assert.equal(updatedState.currentPhase, 'done');
  assert.equal(updatedState.pendingAgentRun, null);
  assert.equal(updatedState.updatedAt, acceptedAt);
  assert.equal(updatedState.context.existing, 'value');
  assert.equal(updatedState.context.reviewFindings, 'none');
  assert.equal(updatedState.context.extra, 'value');
  assert.equal(updatedState.acceptedAgentRuns[pendingRun.runId].outcome, 'complete');
  assert.equal(updatedState.acceptedAgentRuns[pendingRun.runId].capture?.extra, 'value');
  assert.equal(updatedState.acceptedAgentRuns[pendingRun.runId].resultSchema, 'implementer-result-v1');
});

test('evaluateResultArtifact accepts valid artifacts for every built-in result schema', async () => {
  const worktreePath = await tempDir();
  const schemaCases = [
    {
      phaseId: 'implement',
      roleId: 'implementer',
      artifactRole: 'implementer',
      resultSchema: 'implementer-result-v1',
      outcome: 'complete',
      payload: {
        changedFiles: ['skills/herdr-implement/src/result-artifact.ts'],
        checksRun: ['node --test skills/herdr-implement/test/*.test.ts'],
        checksDeferred: [],
        blockers: [],
      },
    },
    {
      phaseId: 'simplify',
      roleId: 'simplifier',
      artifactRole: 'implementer',
      resultSchema: 'simplifier-result-v1',
      outcome: 'complete',
      payload: {
        simplificationSummary: 'Focused validation into a schema module.',
        changedFiles: ['skills/herdr-implement/src/result-schema.ts'],
        checksRun: ['node --test skills/herdr-implement/test/*.test.ts'],
        checksDeferred: [],
        blockers: [],
      },
    },
    {
      phaseId: 'review',
      roleId: 'reviewer',
      artifactRole: 'reviewer',
      resultSchema: 'reviewer-result-v1',
      outcome: 'approved',
      payload: {
        verdict: 'approved',
        findings: [],
        hasBlockingFindings: false,
      },
    },
    {
      phaseId: 'verify',
      roleId: 'verifier',
      artifactRole: 'implementer',
      resultSchema: 'verifier-result-v1',
      outcome: 'complete',
      payload: {
        checksSelected: ['node --test skills/herdr-implement/test/*.test.ts'],
        checksRun: ['node --test skills/herdr-implement/test/*.test.ts'],
        checksDeferred: [],
        failures: [],
        blockers: [],
      },
    },
  ] as const;

  for (const item of schemaCases) {
    const runId = `issue-36-${item.phaseId}-${item.roleId}-1`;
    const pendingRun: PendingAgentRunState = {
      runId,
      phaseId: item.phaseId,
      roleId: item.roleId,
      completionRole: item.roleId === 'reviewer' ? 'reviewer' : 'implementer',
      roleLabel: item.roleId,
      agentName: `issue-36-${item.roleId}`,
      resultSchema: item.resultSchema,
      resultPath: join(worktreePath, '.agent/runs', runId, 'result.json'),
      notifyTarget: 'issue-36-orchestrator',
      attemptNumber: 1,
      startedAt: '2026-07-05T01:00:00.000Z',
      status: 'pending',
    };
    const phase = {
      type: 'agent',
      role: item.roleId,
      promptTemplate: `${item.phaseId}.md`,
      resultSchema: item.resultSchema,
      on: { [item.outcome]: 'done' },
    };

    await writeArtifact(pendingRun.resultPath, {
      schemaVersion: 1,
      runId: pendingRun.runId,
      role: item.artifactRole,
      phase: item.phaseId,
      resultSchema: item.resultSchema,
      status: 'complete',
      outcome: item.outcome,
      summary: 'schema-specific completion',
      capture: { schemaName: item.resultSchema },
      payload: item.payload,
    });

    const result = evaluateResultArtifact({
      resultPath: pendingRun.resultPath,
      pendingRun,
      phase: phase as never,
    });

    assert.equal(result.kind, 'accepted', `${item.resultSchema} should be accepted`);

    assert.doesNotThrow(() =>
      validateResultArtifactAgainstSchema(
        {
          schemaVersion: 1,
          runId: `run-${item.resultSchema}`,
          phase: item.phaseId,
          role: item.artifactRole,
          status: 'complete',
          outcome: item.outcome,
          capture: { schemaName: item.resultSchema },
          summary: 'schema-specific completion',
          payload: item.payload,
          resultSchema: item.resultSchema,
        },
        item.resultSchema,
      ),
    );
  }
});

test('createAcceptedResultArtifactSummary includes the accepted status details', async () => {
  const worktreePath = await tempDir();
  const pendingRun = pendingRunFixture(worktreePath);
  const artifact = baseArtifact(pendingRun) as ResultArtifact;

  assert.equal(
    createAcceptedResultArtifactSummary(artifact, pendingRun),
    'accepted result artifact for issue-36-implement-implementer-1; outcome=complete; status=complete; summary=implemented completion routing',
  );
});
