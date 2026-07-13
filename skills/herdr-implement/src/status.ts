import { resolve } from 'node:path';
import { type ScriptRunState } from './script-phase.ts';
import { readWorkflowRunState, workflowStatePathsFor, type AcceptedAgentRunState, type PollRunState, type WorkflowRunState } from './workflow-state-store.ts';

export type LiveRunStatus = {
  worktreePath: string;
  runStatePath: string;
  issue: string;
  currentPhase: string;
  currentPhaseType: string | null;
  phaseSummary: string | null;
  workspaceId: string;
  daemonTabId: string | null;
  daemonPaneId: string | null;
  pendingAgentRun: string | null;
  acceptedRuns: string[];
  scriptRuns: string[];
  pollRuns: string[];
};

function sortedAcceptedRuns(runs: Record<string, AcceptedAgentRunState>): AcceptedAgentRunState[] {
  return Object.values(runs).sort((left, right) => {
    const acceptedAt = left.acceptedAt.localeCompare(right.acceptedAt);
    return acceptedAt !== 0 ? acceptedAt : left.runId.localeCompare(right.runId);
  });
}

function sortedScriptRuns(runs: Record<string, ScriptRunState>): Array<[string, ScriptRunState]> {
  return Object.entries(runs).sort(([left], [right]) => left.localeCompare(right));
}

function sortedPollRuns(runs: Record<string, PollRunState>): Array<[string, PollRunState]> {
  return Object.entries(runs).sort(([left], [right]) => left.localeCompare(right));
}

function describePendingAgentRun(state: WorkflowRunState): string | null {
  const pending = state.pendingAgentRun;
  if (!pending) {
    return null;
  }

  return `${pending.runId} role=${pending.roleId} phase=${pending.phaseId} status=${pending.status} attempt=${pending.attemptNumber}`;
}

function describeAcceptedRun(run: AcceptedAgentRunState): string {
  const summary = run.summary ? ` summary=${run.summary}` : '';
  return `${run.runId} phase=${run.phaseId} role=${run.roleId} status=${run.status} outcome=${run.outcome}${summary}`;
}

function describeScriptRun(phaseId: string, run: ScriptRunState): string {
  return `${phaseId} status=${run.status} outcome=${run.outcome}${run.capture ? ' capture=yes' : ''}`;
}

function describePollRun(phaseId: string, run: PollRunState): string {
  return `${phaseId} status=${run.status} outcome=${run.outcome}`;
}

export function readLiveRunStatus(worktreePath: string): LiveRunStatus {
  const { runStatePath } = workflowStatePathsFor(resolve(worktreePath));
  const state = readWorkflowRunState(runStatePath);

  if (!state) {
    throw new Error(`workflow run state does not exist: ${runStatePath}`);
  }

  const phase = state.workflow.phases[state.currentPhase];
  const acceptedRuns = sortedAcceptedRuns(state.acceptedAgentRuns).map(describeAcceptedRun);
  const scriptRuns = sortedScriptRuns(state.scriptRuns).map(([phaseId, run]) => describeScriptRun(phaseId, run));
  const pollRuns = sortedPollRuns(state.pollRuns ?? {}).map(([phaseId, run]) => describePollRun(phaseId, run));

  let phaseSummary: string | null = null;
  if (phase?.type === 'agent') {
    phaseSummary = describePendingAgentRun(state);
  } else if (phase?.type === 'script') {
    const run = state.scriptRuns[state.currentPhase];
    phaseSummary = run ? describeScriptRun(state.currentPhase, run) : `script phase ${state.currentPhase}`;
  } else if (phase?.type === 'poll') {
    const run = state.pollRuns?.[state.currentPhase];
    phaseSummary = run ? describePollRun(state.currentPhase, run) : `poll phase ${state.currentPhase}`;
  } else if (state.pendingAgentRun) {
    phaseSummary = describePendingAgentRun(state);
  }

  return {
    worktreePath: resolve(worktreePath),
    runStatePath,
    issue: state.issue.canonical,
    currentPhase: state.currentPhase,
    currentPhaseType: phase?.type ?? null,
    phaseSummary,
    workspaceId: state.workspaceId,
    daemonTabId: state.daemon.tabId,
    daemonPaneId: state.daemon.paneId,
    pendingAgentRun: describePendingAgentRun(state),
    acceptedRuns,
    scriptRuns,
    pollRuns,
  };
}

export function formatLiveRunStatus(status: LiveRunStatus): string {
  const lines = [
    `Issue: ${status.issue}`,
    `Current phase: ${status.currentPhase}${status.currentPhaseType ? ` (${status.currentPhaseType})` : ''}`,
    `Workspace: ${status.workspaceId}`,
    `Worktree: ${status.worktreePath}`,
    `Daemon tab: ${status.daemonTabId ?? '(none)'}`,
    `Daemon pane: ${status.daemonPaneId ?? '(none)'}`,
  ];

  if (status.phaseSummary) {
    lines.push(`Phase summary: ${status.phaseSummary}`);
  }
  if (status.pendingAgentRun) {
    lines.push(`Pending agent: ${status.pendingAgentRun}`);
  }
  if (status.acceptedRuns.length > 0) {
    lines.push('Accepted runs:');
    for (const run of status.acceptedRuns) {
      lines.push(`- ${run}`);
    }
  }
  if (status.scriptRuns.length > 0) {
    lines.push('Script runs:');
    for (const run of status.scriptRuns) {
      lines.push(`- ${run}`);
    }
  }
  if (status.pollRuns.length > 0) {
    lines.push('Poll runs:');
    for (const run of status.pollRuns) {
      lines.push(`- ${run}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export function statusCommandForWorktree(worktreePath: string): string {
  return `node skills/herdr-implement/bin/status.ts --worktree ${JSON.stringify(worktreePath)}`;
}
