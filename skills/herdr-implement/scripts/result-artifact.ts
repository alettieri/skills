import { existsSync, readFileSync } from 'node:fs';
import { mergeCaptureIntoContext, normalizeCapture } from './capture.ts';
import type { NormalizedPhase } from './workflow.ts';
import { resolveNextPhase } from './workflow-transition.ts';
import type { PendingAgentRunState, WorkflowRunState } from './workflow-state-store.ts';
import { isRecord, optionalTrimmedString } from './validation.ts';

export type ResultArtifact = {
  schemaVersion: number;
  runId: string;
  role: string;
  phase: string;
  status: 'complete' | 'blocked' | 'failed';
  outcome: string;
  capture: Record<string, unknown> | null;
  summary: string | null;
  payload: Record<string, unknown> | null;
  resultSchema: string | null;
};

export type ResultArtifactEvaluation =
  | { kind: 'missing' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'stale'; reason: string; artifact: ResultArtifact }
  | { kind: 'accepted'; artifact: ResultArtifact };

function resultArtifactMatchesSchema(artifact: ResultArtifact, expectedResultSchema: string | null): boolean {
  if (!expectedResultSchema) {
    return true;
  }

  return artifact.resultSchema === expectedResultSchema;
}

function readResultArtifact(resultPath: string): ResultArtifact | null {
  if (!existsSync(resultPath)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resultPath, 'utf8')) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`result artifact is not valid JSON: ${message}`);
  }

  if (!isRecord(parsed)) {
    throw new Error('result artifact must be a JSON object');
  }

  const schemaVersion = parsed.schemaVersion;
  if (schemaVersion !== 1) {
    throw new Error('result artifact schemaVersion must be 1');
  }

  const runId = optionalTrimmedString(parsed.runId);
  const role = optionalTrimmedString(parsed.role);
  const phase = optionalTrimmedString(parsed.phase);
  const status =
    parsed.status === 'complete' || parsed.status === 'blocked' || parsed.status === 'failed' ? parsed.status : null;
  const outcome = optionalTrimmedString(parsed.outcome);
  const summary = optionalTrimmedString(parsed.summary);
  const capture = parsed.capture === undefined ? null : normalizeCapture(parsed.capture);
  const payload = parsed.payload === undefined ? null : normalizeCapture(parsed.payload);
  const resultSchema = optionalTrimmedString(parsed.resultSchema);

  if (!runId || !role || !phase || !status || !outcome) {
    throw new Error('result artifact is missing required completion fields');
  }

  if (parsed.capture !== undefined && capture === null) {
    throw new Error('result artifact capture must be an object with string keys');
  }

  if (parsed.payload !== undefined && payload === null) {
    throw new Error('result artifact payload must be an object with string keys');
  }

  return {
    schemaVersion,
    runId,
    role,
    phase,
    status,
    outcome,
    capture,
    summary,
    payload,
    resultSchema,
  };
}

function classifyResultArtifact(
  artifact: ResultArtifact,
  pendingRun: PendingAgentRunState,
  phase: NormalizedPhase,
): { kind: 'accepted' } | { kind: 'stale'; reason: string } | { kind: 'invalid'; reason: string } {
  if (artifact.runId !== pendingRun.runId) {
    return {
      kind: 'stale',
      reason: `result artifact runId mismatch: expected ${pendingRun.runId}, found ${artifact.runId}`,
    };
  }

  if (artifact.phase !== pendingRun.phaseId) {
    return {
      kind: 'stale',
      reason: `result artifact phase mismatch: expected ${pendingRun.phaseId}, found ${artifact.phase}`,
    };
  }

  if (artifact.role !== pendingRun.completionRole) {
    return {
      kind: 'stale',
      reason: `result artifact role mismatch: expected ${pendingRun.completionRole}, found ${artifact.role}`,
    };
  }

  const expectedResultSchema = pendingRun.resultSchema ?? optionalTrimmedString(phase.resultSchema);
  if (!resultArtifactMatchesSchema(artifact, expectedResultSchema)) {
    return {
      kind: 'invalid',
      reason: `result artifact schema mismatch: expected ${expectedResultSchema ?? 'any'}, found ${artifact.resultSchema ?? 'missing'}`,
    };
  }

  if (!Object.hasOwn(phase.on, artifact.outcome)) {
    return {
      kind: 'invalid',
      reason: `result artifact outcome ${artifact.outcome} is not declared by phase ${pendingRun.phaseId}`,
    };
  }

  if (artifact.capture !== null && !isRecord(artifact.capture)) {
    return {
      kind: 'invalid',
      reason: 'result artifact capture must be an object with string keys',
    };
  }

  return { kind: 'accepted' };
}

export function evaluateResultArtifact(options: {
  resultPath: string;
  pendingRun: PendingAgentRunState;
  phase: NormalizedPhase;
}): ResultArtifactEvaluation {
  let artifact: ResultArtifact | null;
  try {
    artifact = readResultArtifact(options.resultPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: 'invalid', reason: message };
  }

  if (!artifact) {
    return { kind: 'missing' };
  }

  const classification = classifyResultArtifact(artifact, options.pendingRun, options.phase);
  if (classification.kind === 'accepted') {
    return { kind: 'accepted', artifact };
  }

  if (classification.kind === 'stale') {
    return { kind: 'stale', artifact, reason: classification.reason };
  }

  return classification;
}

export function applyAcceptedResultArtifact(
  state: WorkflowRunState,
  pendingRun: PendingAgentRunState,
  artifact: ResultArtifact,
  acceptedAt: string,
): WorkflowRunState {
  return {
    ...state,
    currentPhase: resolveNextPhase(state.workflow, pendingRun.phaseId, artifact.outcome) ?? state.currentPhase,
    context: mergeCaptureIntoContext(state.context, artifact.capture),
    pendingAgentRun: null,
    acceptedAgentRuns: {
      ...state.acceptedAgentRuns,
      [pendingRun.runId]: {
        runId: pendingRun.runId,
        phaseId: pendingRun.phaseId,
        roleId: pendingRun.roleId,
        roleLabel: pendingRun.roleLabel,
        agentName: pendingRun.agentName,
        resultSchema: pendingRun.resultSchema ?? artifact.resultSchema,
        resultPath: pendingRun.resultPath,
        acceptedAt,
        status: artifact.status,
        outcome: artifact.outcome,
        summary: artifact.summary,
        capture: artifact.capture,
      },
    },
    updatedAt: acceptedAt,
  };
}

export function createAcceptedResultArtifactSummary(artifact: ResultArtifact, pendingRun: PendingAgentRunState): string {
  return [
    `accepted result artifact for ${pendingRun.runId}`,
    `outcome=${artifact.outcome}`,
    `status=${artifact.status}`,
    artifact.summary ? `summary=${artifact.summary}` : 'summary=(none)',
  ].join('; ');
}
