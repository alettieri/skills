import { isRecord, optionalTrimmedString } from './validation.ts';

const FLAT_LAUNCH_FIELDS = ['approval', 'sandbox', 'permissionMode'] as const;

function requireString(value: unknown, field: string): string {
  const stringValue = optionalTrimmedString(value);
  if (!stringValue) {
    throw new Error(`${field} must be a non-empty string`);
  }

  return stringValue;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }

  return value;
}

function optionalRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }

  return requireRecord(value, field);
}

function validateNoFlatLaunchFields(role: Record<string, unknown>, field: string): void {
  for (const launchField of FLAT_LAUNCH_FIELDS) {
    if (Object.hasOwn(role, launchField)) {
      throw new Error(`${field}.${launchField} is not supported; move Codex launch settings under ${field}.codex`);
    }
  }
}

export function mergeCodexLaunchPolicy(
  base: Record<string, unknown>,
  baseField: string,
  override: Record<string, unknown>,
  overrideField: string,
): Record<string, unknown> {
  validateNoFlatLaunchFields(base, baseField);
  validateNoFlatLaunchFields(override, overrideField);

  const merged: Record<string, unknown> = {
    ...base,
    ...override,
  };

  if (Object.hasOwn(base, 'codex') || Object.hasOwn(override, 'codex')) {
    merged.codex = {
      ...optionalRecord(base.codex, `${baseField}.codex`),
      ...optionalRecord(override.codex, `${overrideField}.codex`),
    };
  }

  return merged;
}

export function buildCodexLaunchArgs(
  role: Record<string, unknown>,
): readonly ['codex', '-a', string, '-m', string, '-s', string] {
  const codex = requireRecord(role.codex, 'roles.codex');
  const approval = requireString(codex.approval, 'roles.codex.approval');
  const sandbox = requireString(codex.sandbox, 'roles.codex.sandbox');
  const model = requireString(role.model, 'roles.model');

  return ['codex', '-a', approval, '-m', model, '-s', sandbox];
}
