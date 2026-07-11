import { isRecord, optionalTrimmedString } from './validation.ts';

const FLAT_LAUNCH_FIELDS = ['approval', 'sandbox', 'permissionMode'] as const;
const SUPPORTED_PROVIDER_AGENTS = ['codex', 'claude'] as const;
const KNOWN_PROVIDER_BLOCKS = ['codex', 'claude'] as const;

const CODEX_APPROVAL_VALUES = ['untrusted', 'on-failure', 'on-request', 'never'] as const;
const CODEX_SANDBOX_VALUES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
const CLAUDE_PERMISSION_MODE_VALUES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'] as const;

type ProviderAgent = (typeof SUPPORTED_PROVIDER_AGENTS)[number];

type ProviderBlock = (typeof KNOWN_PROVIDER_BLOCKS)[number];

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

function isSupportedProviderAgent(value: string): value is ProviderAgent {
  return (SUPPORTED_PROVIDER_AGENTS as readonly string[]).includes(value);
}

function requireSupportedProviderAgent(value: unknown, field: string): ProviderAgent {
  const agent = requireString(value, field);
  if (!isSupportedProviderAgent(agent)) {
    throw new Error(`${field} must be one of: ${SUPPORTED_PROVIDER_AGENTS.join(', ')}`);
  }

  return agent;
}

function validateNoFlatLaunchFields(role: Record<string, unknown>, field: string): void {
  for (const launchField of FLAT_LAUNCH_FIELDS) {
    if (Object.hasOwn(role, launchField)) {
      throw new Error(`${field}.${launchField} is not supported; move launch settings under ${field}.codex or ${field}.claude`);
    }
  }
}

function validateKnownProviderBlocks(role: Record<string, unknown>, field: string): void {
  for (const [key, value] of Object.entries(role)) {
    if (!KNOWN_PROVIDER_BLOCKS.includes(key as ProviderBlock) && isRecord(value)) {
      throw new Error(`${field}.${key} is not a supported provider block`);
    }
  }
}

function validateEnumValue(
  value: unknown,
  field: string,
  allowedValues: readonly string[],
): string {
  const stringValue = requireString(value, field);
  if (!(allowedValues as readonly string[]).includes(stringValue)) {
    throw new Error(`${field} must be one of: ${allowedValues.join(', ')}`);
  }

  return stringValue;
}

function normalizeCodexBlock(
  base: Record<string, unknown>,
  baseField: string,
  override: Record<string, unknown>,
  overrideField: string,
): Record<string, unknown> {
  if (base.approval !== undefined) {
    validateEnumValue(base.approval, `${baseField}.approval`, CODEX_APPROVAL_VALUES);
  }
  if (base.sandbox !== undefined) {
    validateEnumValue(base.sandbox, `${baseField}.sandbox`, CODEX_SANDBOX_VALUES);
  }
  if (override.approval !== undefined) {
    validateEnumValue(override.approval, `${overrideField}.approval`, CODEX_APPROVAL_VALUES);
  }
  if (override.sandbox !== undefined) {
    validateEnumValue(override.sandbox, `${overrideField}.sandbox`, CODEX_SANDBOX_VALUES);
  }

  const merged: Record<string, unknown> = {
    approval: 'on-request',
    sandbox: 'workspace-write',
    ...base,
    ...override,
  };

  return merged;
}

function normalizeClaudeBlock(
  base: Record<string, unknown>,
  baseField: string,
  override: Record<string, unknown>,
  overrideField: string,
): Record<string, unknown> {
  if (base.permissionMode !== undefined) {
    validateEnumValue(base.permissionMode, `${baseField}.permissionMode`, CLAUDE_PERMISSION_MODE_VALUES);
  }
  if (override.permissionMode !== undefined) {
    validateEnumValue(override.permissionMode, `${overrideField}.permissionMode`, CLAUDE_PERMISSION_MODE_VALUES);
  }

  const merged: Record<string, unknown> = {
    permissionMode: 'auto',
    ...base,
    ...override,
  };

  return merged;
}

function validateAgentField(value: unknown, field: string): void {
  if (value === undefined) {
    return;
  }

  requireSupportedProviderAgent(value, field);
}

export function normalizeProviderLaunchPolicy(
  base: Record<string, unknown>,
  baseField: string,
  override: Record<string, unknown>,
  overrideField: string,
): Record<string, unknown> {
  validateNoFlatLaunchFields(base, baseField);
  validateNoFlatLaunchFields(override, overrideField);
  validateKnownProviderBlocks(base, baseField);
  validateKnownProviderBlocks(override, overrideField);

  const merged: Record<string, unknown> = {
    ...base,
    ...override,
  };

  validateAgentField(merged.agent, `${overrideField}.agent`);

  const baseCodex = optionalRecord(base.codex, `${baseField}.codex`);
  const overrideCodex = optionalRecord(override.codex, `${overrideField}.codex`);
  merged.codex = normalizeCodexBlock(baseCodex, `${baseField}.codex`, overrideCodex, `${overrideField}.codex`);

  const baseClaude = optionalRecord(base.claude, `${baseField}.claude`);
  const overrideClaude = optionalRecord(override.claude, `${overrideField}.claude`);
  merged.claude = normalizeClaudeBlock(baseClaude, `${baseField}.claude`, overrideClaude, `${overrideField}.claude`);

  return merged;
}

function requireProviderBlock(role: Record<string, unknown>, field: string, block: ProviderBlock): Record<string, unknown> {
  return requireRecord(role[block], `${field}.${block}`);
}

function validateCodexLaunchRole(role: Record<string, unknown>, field: string): void {
  const codex = requireProviderBlock(role, field, 'codex');
  validateEnumValue(codex.approval, `${field}.codex.approval`, CODEX_APPROVAL_VALUES);
  validateEnumValue(codex.sandbox, `${field}.codex.sandbox`, CODEX_SANDBOX_VALUES);
}

function validateClaudeLaunchRole(role: Record<string, unknown>, field: string): void {
  const claude = requireProviderBlock(role, field, 'claude');
  validateEnumValue(claude.permissionMode, `${field}.claude.permissionMode`, CLAUDE_PERMISSION_MODE_VALUES);
}

export function validateProviderLaunchRole(role: Record<string, unknown>, field: string): void {
  const agent = requireSupportedProviderAgent(role.agent, `${field}.agent`);
  requireString(role.model, `${field}.model`);

  switch (agent) {
    case 'codex':
      validateCodexLaunchRole(role, field);
      break;
    case 'claude':
      validateClaudeLaunchRole(role, field);
      break;
  }
}

export function buildProviderLaunchArgs(
  role: Record<string, unknown>,
): readonly ['codex', '-a', string, '-m', string, '-s', string] | readonly ['claude', '--model', string, '--permission-mode', string] {
  const agent = requireSupportedProviderAgent(role.agent, 'roles.agent');
  const model = requireString(role.model, 'roles.model');

  switch (agent) {
    case 'codex': {
      const codex = requireProviderBlock(role, 'roles', 'codex');
      const approval = validateEnumValue(codex.approval, 'roles.codex.approval', CODEX_APPROVAL_VALUES);
      const sandbox = validateEnumValue(codex.sandbox, 'roles.codex.sandbox', CODEX_SANDBOX_VALUES);
      return ['codex', '-a', approval, '-m', model, '-s', sandbox];
    }
    case 'claude': {
      const claude = requireProviderBlock(role, 'roles', 'claude');
      const permissionMode = validateEnumValue(
        claude.permissionMode,
        'roles.claude.permissionMode',
        CLAUDE_PERMISSION_MODE_VALUES,
      );
      return ['claude', '--model', model, '--permission-mode', permissionMode];
    }
  }
}
