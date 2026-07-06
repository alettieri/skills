import type { NormalizedWorkflow } from './workflow.ts';

export function resolveNextPhase(workflow: NormalizedWorkflow, phaseId: string, outcome: string): string | null {
  const phase = workflow.phases[phaseId];
  if (!phase) {
    return null;
  }

  return phase.on[outcome] ?? null;
}

export function isTerminalPhase(workflow: NormalizedWorkflow, phaseId: string): boolean {
  return workflow.phases[phaseId]?.type === 'terminal';
}
