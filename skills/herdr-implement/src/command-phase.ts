import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { NormalizedWorkflow } from './workflow.ts';
import { readWorkflowScriptSource } from './asset-resolver.ts';
import { normalizeCapture } from './capture.ts';
import { renderTemplate } from './text-template.ts';
import { isRecord, optionalTrimmedString } from './validation.ts';

export type CommandIssueReference = {
  input: string;
  number: number | null;
  url: string | null;
  canonical: string;
};

export type CommandPhaseWorkflowState = {
  issue: CommandIssueReference;
  workflowPath: string;
  workflow: NormalizedWorkflow;
  branchName: string;
  worktreePath: string;
  workspaceId: string;
  currentPhase: string;
  updatedAt: string;
  context: Record<string, unknown>;
};

export type CommandRunPaths = {
  stdoutPath: string;
  stderrPath: string;
  rawOutputPath: string;
};

type CommandRunLogInput = {
  command: string;
  resolvedCommandPath: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutSeconds: number;
  startedAt: string;
  finishedAt: string;
  stdout: string;
  stderr: string;
};

function ensureDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function flattenContextValues(context: Record<string, unknown>, prefix = 'context'): Record<string, string> {
  const values: Record<string, string> = {};

  for (const [key, value] of Object.entries(context)) {
    const renderedKey = `${prefix}.${key}`;
    if (typeof value === 'string') {
      values[renderedKey] = value;
      continue;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      values[renderedKey] = String(value);
      continue;
    }

    if (isRecord(value)) {
      Object.assign(values, flattenContextValues(value, renderedKey));
    }
  }

  return values;
}

export function renderCommandTemplate(
  source: string,
  state: CommandPhaseWorkflowState,
  phaseId: string,
  runId: string,
): string {
  const phase = state.workflow.phases[phaseId];
  return renderTemplate(source, {
    ...flattenContextValues(state.context),
    'issue.canonical': state.issue.canonical,
    'issue.input': state.issue.input,
    'issue.number': String(state.issue.number ?? ''),
    'phase.id': phaseId,
    'phase.type': phase?.type ?? '',
    'run.id': runId,
    'workflow.branchName': state.branchName,
    'workflow.currentPhase': state.currentPhase,
    'workflow.path': state.workflowPath,
    'workflow.workspaceId': state.workspaceId,
    worktreePath: state.worktreePath,
    workspaceId: state.workspaceId,
  });
}

export function buildCommandRunPaths(worktreePath: string, runId: string): CommandRunPaths {
  const basePath = resolve(worktreePath, '.agent', 'runs', runId);
  return {
    stdoutPath: resolve(basePath, 'stdout.log'),
    stderrPath: resolve(basePath, 'stderr.log'),
    rawOutputPath: resolve(basePath, 'raw.log'),
  };
}

export function resolveCommandPath(cwd: string, workflowPath: string, command: string): string {
  return readWorkflowScriptSource(cwd, workflowPath, command).path;
}

export function renderCommandArgs(state: CommandPhaseWorkflowState, phaseId: string, args: unknown, runId: string): string[] {
  if (args === undefined) {
    return [];
  }

  if (!Array.isArray(args) || !args.every((value) => typeof value === 'string')) {
    throw new Error(`phases.${phaseId}.args must be an array of strings`);
  }

  return args.map((arg) => renderCommandTemplate(arg, state, phaseId, runId));
}

export function renderCommandEnv(
  state: CommandPhaseWorkflowState,
  phaseId: string,
  env: unknown,
  runId: string,
): Record<string, string> {
  if (env === undefined) {
    return {};
  }

  if (!isRecord(env)) {
    throw new Error(`phases.${phaseId}.env must be an object`);
  }

  const rendered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') {
      throw new Error(`phases.${phaseId}.env.${key} must be a non-empty string`);
    }
    rendered[key] = renderCommandTemplate(value, state, phaseId, runId);
  }

  return rendered;
}

export function buildCommandEnvironment(
  state: CommandPhaseWorkflowState,
  phaseId: string,
  renderedEnv: Record<string, string>,
  runId: string,
): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    PWD: state.worktreePath,
    HERDR_ISSUE_CANONICAL: state.issue.canonical,
    HERDR_ISSUE_INPUT: state.issue.input,
    HERDR_ISSUE_NUMBER: String(state.issue.number ?? ''),
    HERDR_PHASE_ID: phaseId,
    HERDR_RUN_ID: runId,
    HERDR_WORKFLOW_PATH: state.workflowPath,
    HERDR_WORKFLOW_BRANCH: state.branchName,
    HERDR_WORKFLOW_CURRENT_PHASE: state.currentPhase,
    HERDR_WORKSPACE_ID: state.workspaceId,
    HERDR_WORKTREE_PATH: state.worktreePath,
    ...renderedEnv,
  };
}

export function commandLogContents(input: CommandRunLogInput): string {
  return [
    `command: ${input.command}`,
    `resolvedCommandPath: ${input.resolvedCommandPath}`,
    `cwd: ${input.cwd}`,
    `timeoutSeconds: ${input.timeoutSeconds}`,
    `startedAt: ${input.startedAt}`,
    `finishedAt: ${input.finishedAt}`,
    `args: ${JSON.stringify(input.args)}`,
    `env: ${JSON.stringify(input.env)}`,
    '',
    '--- stdout ---',
    input.stdout,
    '',
    '--- stderr ---',
    input.stderr,
    '',
  ].join('\n');
}

export function writeCommandLogFiles(paths: CommandRunPaths, stdout: string, stderr: string, rawOutput: string): void {
  ensureDir(paths.stdoutPath);
  writeFileSync(paths.stdoutPath, stdout, 'utf8');
  writeFileSync(paths.stderrPath, stderr, 'utf8');
  writeFileSync(paths.rawOutputPath, rawOutput, 'utf8');
}

export function parseCommandOutcome(stdout: string): { outcome: string; capture: Record<string, unknown> | null } {
  const trimmed = stdout.trim();
  if (trimmed === '') {
    return { outcome: '', capture: null };
  }

  if (trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`script stdout is not valid JSON: ${message}`);
    }

    if (!isRecord(parsed)) {
      throw new Error('script stdout JSON outcome must be an object');
    }

    const outcome = optionalTrimmedString(parsed.outcome);
    if (!outcome) {
      throw new Error('script stdout JSON outcome must include a non-empty outcome');
    }

    const capture = parsed.capture === undefined ? null : normalizeCapture(parsed.capture);
    if (parsed.capture !== undefined && capture === null) {
      throw new Error('script stdout capture must be an object with string keys');
    }

    return { outcome, capture };
  }

  if (/\s/.test(trimmed)) {
    throw new Error('script stdout outcome must be a single token or JSON object');
  }

  return { outcome: trimmed, capture: null };
}
