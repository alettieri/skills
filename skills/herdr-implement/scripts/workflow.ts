import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

type WorkflowCandidate = Record<string, unknown>;

type Line = {
  indent: number;
  text: string;
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
  const roleDefaults = optionalRecord(workflow.roleDefaults, 'roleDefaults');
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

    phases[phaseName] = {
      ...phase,
      type: requireString(phase.type, `phases.${phaseName}.type`),
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
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return requireString(value, 'version');
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WorkflowValidationError(`${field} must be a non-empty string`);
  }

  return value;
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

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkflowValidationError(`${field} must be an object`);
  }

  return value as Record<string, unknown>;
}

export function parseYaml(source: string): unknown {
  const trimmed = source.trim();
  if (trimmed === '') {
    throw new WorkflowValidationError('workflow file is empty');
  }

  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed) as unknown;
  }

  const lines = source
    .split(/\r?\n/)
    .map(stripComment)
    .filter((line) => line.text.trim() !== '');

  const [value, nextIndex] = parseBlock(lines, 0, lines[0]?.indent ?? 0);
  if (nextIndex !== lines.length) {
    throw new WorkflowValidationError(`could not parse workflow near line ${nextIndex + 1}`);
  }

  return value;
}

function parseBlock(lines: Line[], index: number, indent: number): [unknown, number] {
  if (index >= lines.length) {
    return [{}, index];
  }

  if (lines[index].indent < indent) {
    return [{}, index];
  }

  if (lines[index].text.startsWith('- ')) {
    return parseArray(lines, index, indent);
  }

  return parseObject(lines, index, indent);
}

function parseObject(lines: Line[], index: number, indent: number): [Record<string, unknown>, number] {
  const result: Record<string, unknown> = {};
  let cursor = index;

  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.indent < indent) {
      break;
    }
    if (line.indent > indent) {
      throw new WorkflowValidationError(`unexpected indentation near line ${cursor + 1}`);
    }
    if (line.text.startsWith('- ')) {
      break;
    }

    const parsed = parseKeyValue(line.text, cursor);
    if (parsed.value === undefined) {
      const [child, nextCursor] = parseBlock(lines, cursor + 1, indent + 2);
      result[parsed.key] = child;
      cursor = nextCursor;
    } else {
      result[parsed.key] = parseScalar(parsed.value);
      cursor += 1;
    }
  }

  return [result, cursor];
}

function parseArray(lines: Line[], index: number, indent: number): [unknown[], number] {
  const result: unknown[] = [];
  let cursor = index;

  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.indent < indent) {
      break;
    }
    if (line.indent !== indent || !line.text.startsWith('- ')) {
      break;
    }

    const itemText = line.text.slice(2).trim();
    if (itemText === '') {
      const [child, nextCursor] = parseBlock(lines, cursor + 1, indent + 2);
      result.push(child);
      cursor = nextCursor;
      continue;
    }

    if (itemText.includes(':')) {
      const parsed = parseKeyValue(itemText, cursor);
      const item: Record<string, unknown> = {};
      if (parsed.value === undefined) {
        const [child, nextCursor] = parseBlock(lines, cursor + 1, indent + 2);
        item[parsed.key] = child;
        cursor = nextCursor;
      } else {
        item[parsed.key] = parseScalar(parsed.value);
        cursor += 1;
      }

      while (cursor < lines.length && lines[cursor].indent === indent + 2 && !lines[cursor].text.startsWith('- ')) {
        const child = parseKeyValue(lines[cursor].text, cursor);
        if (child.value === undefined) {
          const [nested, nextCursor] = parseBlock(lines, cursor + 1, indent + 4);
          item[child.key] = nested;
          cursor = nextCursor;
        } else {
          item[child.key] = parseScalar(child.value);
          cursor += 1;
        }
      }

      result.push(item);
      continue;
    }

    result.push(parseScalar(itemText));
    cursor += 1;
  }

  return [result, cursor];
}

function parseKeyValue(text: string, lineIndex: number): { key: string; value: string | undefined } {
  const separator = text.indexOf(':');
  if (separator === -1) {
    throw new WorkflowValidationError(`expected key/value pair near line ${lineIndex + 1}`);
  }

  const key = text.slice(0, separator).trim();
  const rawValue = text.slice(separator + 1).trim();
  if (key === '') {
    throw new WorkflowValidationError(`empty key near line ${lineIndex + 1}`);
  }

  return {
    key,
    value: rawValue === '' ? undefined : rawValue,
  };
}

function parseScalar(value: string): unknown {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  if (value === 'null') {
    return null;
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }

  return value;
}

function stripComment(raw: string): Line {
  let quote: string | null = null;
  let cut = raw.length;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if ((character === '"' || character === "'") && raw[index - 1] !== '\\') {
      quote = quote === character ? null : quote ?? character;
    }
    if (character === '#' && quote === null && (index === 0 || /\s/.test(raw[index - 1]))) {
      cut = index;
      break;
    }
  }

  const withoutComment = raw.slice(0, cut).replace(/\s+$/, '');
  const content = withoutComment.trimStart();
  return {
    indent: withoutComment.length - content.length,
    text: content,
  };
}
