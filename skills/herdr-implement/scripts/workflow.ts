import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYamlDocument } from 'yaml';
import {
  isRecord,
  optionalFiniteNumber,
  optionalTrimmedString,
} from './validation.ts';

export type WorkflowSource = {
  path: string;
  workflow: NormalizedWorkflow;
};

export type NormalizedWorkflow = {
  name: string;
  version: string;
  type: 'herdr.issue';
  start: string;
  roleDefaults: Record<string, unknown>;
  roles: Record<string, Record<string, unknown>>;
  phases: Record<string, NormalizedPhase>;
  transitions: Array<WorkflowTransition>;
};

export type NormalizedPhase = Record<string, unknown> & {
  type: string;
  on: Record<string, string>;
};

export type WorkflowTransition = {
  from: string;
  outcome: string;
  to: string;
};

const DEFAULT_WORKFLOW_PATH = 'skills/herdr-implement/workflows/default.yaml';
const PROJECT_WORKFLOW_PATH = '.agent/herdr-workflow.yaml';
const EXECUTABLE_TYPE = 'herdr.issue';

export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowValidationError';
  }
}

export function loadWorkflow(cwd = process.cwd()): WorkflowSource {
  const projectPath = resolve(cwd, PROJECT_WORKFLOW_PATH);
  const defaultPath = resolve(cwd, DEFAULT_WORKFLOW_PATH);
  const workflowPath = existsSync(projectPath) ? projectPath : defaultPath;

  const parsed = parseWorkflowFile(workflowPath);
  return {
    path: workflowPath,
    workflow: normalizeWorkflow(parsed),
  };
}

export function parseWorkflowFile(path: string): unknown {
  if (!existsSync(path)) {
    throw new WorkflowValidationError(`workflow file does not exist: ${path}`);
  }

  const source = readFileSync(path, 'utf8');
  return parseYaml(source);
}

export function normalizeWorkflow(input: unknown): NormalizedWorkflow {
  const workflow = requireRecord(input, 'workflow');
  const name = requireString(workflow.name, 'name');
  const version = requireVersion(workflow.version);
  const type = requireString(workflow.type, 'type');
  const start = requireString(workflow.start, 'start');
  const roleDefaults = {
    reuse: true,
    ...optionalRecord(workflow.roleDefaults, 'roleDefaults'),
  };
  const roleEntries = optionalRecord(workflow.roles, 'roles');
  const phaseEntries = requireRecord(workflow.phases, 'phases');

  if (type !== EXECUTABLE_TYPE) {
    throw new WorkflowValidationError(`unsupported workflow type: ${type}`);
  }

  const roles = normalizeRoles(roleDefaults, roleEntries);
  const phases = normalizePhases(phaseEntries);

  if (!Object.hasOwn(phases, start)) {
    throw new WorkflowValidationError(`start references unknown phase: ${start}`);
  }

  const transitions = validateReferences(phases, roles);

  return {
    name,
    version,
    type,
    start,
    roleDefaults,
    roles,
    phases,
    transitions,
  };
}

function normalizeRoles(
  roleDefaults: Record<string, unknown>,
  roleEntries: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const roles: Record<string, Record<string, unknown>> = {};

  for (const [roleName, roleValue] of Object.entries(roleEntries)) {
    roles[roleName] = {
      ...roleDefaults,
      ...requireRecord(roleValue, `roles.${roleName}`),
    };
  }

  return roles;
}

function normalizePhases(phaseEntries: Record<string, unknown>): Record<string, NormalizedPhase> {
  const phases: Record<string, NormalizedPhase> = {};

  for (const [phaseName, phaseValue] of Object.entries(phaseEntries)) {
    const phase = requireRecord(phaseValue, `phases.${phaseName}`);
    if (Object.hasOwn(phase, 'onSuccess') || Object.hasOwn(phase, 'onFailure')) {
      throw new WorkflowValidationError(`phase ${phaseName} must use named on transitions`);
    }

    const promptTemplate = optionalString(phase.promptTemplate ?? phase.prompt, `phases.${phaseName}.promptTemplate`);
    if (phase.type === 'agent' && !promptTemplate) {
      throw new WorkflowValidationError(`phase ${phaseName} must define promptTemplate`);
    }

    phases[phaseName] = {
      ...phase,
      type: requireString(phase.type, `phases.${phaseName}.type`),
      ...(promptTemplate ? { promptTemplate } : {}),
      on: optionalStringMap(phase.on, `phases.${phaseName}.on`),
    };
  }

  return phases;
}

function validateReferences(
  phases: Record<string, NormalizedPhase>,
  roles: Record<string, Record<string, unknown>>,
): WorkflowTransition[] {
  const transitions: WorkflowTransition[] = [];

  for (const [phaseName, phase] of Object.entries(phases)) {
    if (phase.type === 'agent') {
      const role = requireString(phase.role, `phases.${phaseName}.role`);
      if (!Object.hasOwn(roles, role)) {
        throw new WorkflowValidationError(`phase ${phaseName} references unknown role: ${role}`);
      }
    }

    for (const [outcome, target] of Object.entries(phase.on)) {
      if (!Object.hasOwn(phases, target)) {
        throw new WorkflowValidationError(`phase ${phaseName} outcome ${outcome} references unknown phase: ${target}`);
      }

      transitions.push({
        from: phaseName,
        outcome,
        to: target,
      });
    }
  }

  return transitions;
}

function requireVersion(value: unknown): string {
  const numericValue = optionalFiniteNumber(value);
  if (numericValue !== null) {
    return String(numericValue);
  }

  return requireString(value, 'version');
}

function requireString(value: unknown, field: string): string {
  const stringValue = optionalTrimmedString(value);
  if (!stringValue) {
    throw new WorkflowValidationError(`${field} must be a non-empty string`);
  }

  return typeof value === 'string' ? value : stringValue;
}

function optionalStringMap(value: unknown, field: string): Record<string, string> {
  if (value === undefined) {
    return {};
  }

  const record = requireRecord(value, field);
  const result: Record<string, string> = {};

  for (const [key, mapValue] of Object.entries(record)) {
    result[key] = requireString(mapValue, `${field}.${key}`);
  }

  return result;
}

function optionalRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }

  return requireRecord(value, field);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requireString(value, field);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new WorkflowValidationError(`${field} must be an object`);
  }

  return value;
}

export function parseYaml(source: string): unknown {
  const trimmed = source.trim();
  if (trimmed === '') {
    throw new WorkflowValidationError('workflow file is empty');
  }

  try {
    return parseYamlDocument(source) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkflowValidationError(`workflow file is not valid YAML: ${message}`);
  }
}
