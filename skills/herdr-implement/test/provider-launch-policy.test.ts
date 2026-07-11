import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildProviderLaunchArgs,
  normalizeProviderLaunchPolicy,
  validateProviderLaunchRole,
} from '../src/provider-launch-policy.ts';

test('normalizes provider launch defaults and preserves active provider config', () => {
  const role = normalizeProviderLaunchPolicy(
    {
      agent: 'codex',
      reuse: true,
      codex: {
        approval: 'on-request',
        sandbox: 'workspace-write',
      },
    },
    'roleDefaults',
    {
      model: 'gpt-5.4-mini',
    },
    'roles.implementer',
  );

  assert.deepEqual(role.codex, {
    approval: 'on-request',
    sandbox: 'workspace-write',
  });
  assert.deepEqual(role.claude, {
    permissionMode: 'auto',
  });
  assert.equal(role.agent, 'codex');
  assert.equal(role.model, 'gpt-5.4-mini');
});

test('buildProviderLaunchArgs returns codex and claude argv tails', () => {
  assert.deepEqual(
    buildProviderLaunchArgs({
      agent: 'codex',
      model: 'gpt-5.4-mini',
      codex: {
        approval: 'on-request',
        sandbox: 'workspace-write',
      },
      claude: {
        permissionMode: 'auto',
      },
    }),
    ['codex', '-a', 'on-request', '-m', 'gpt-5.4-mini', '-s', 'workspace-write'],
  );

  assert.deepEqual(
    buildProviderLaunchArgs({
      agent: 'claude',
      model: 'claude-sonnet-4.5',
      claude: {
        permissionMode: 'plan',
      },
      codex: {
        approval: 'on-request',
        sandbox: 'workspace-write',
      },
    }),
    ['claude', '--model', 'claude-sonnet-4.5', '--permission-mode', 'plan'],
  );
});

test('validateProviderLaunchRole enforces active launch config and provider enum values', () => {
  assert.throws(
    () =>
      validateProviderLaunchRole(
        {
          agent: 'claude',
          model: 'claude-sonnet-4.5',
          claude: {
            permissionMode: 'wrong',
          },
        },
        'roles.reviewer',
      ),
    /roles\.reviewer\.claude\.permissionMode must be one of: acceptEdits, auto, bypassPermissions, manual, dontAsk, plan/,
  );

  assert.throws(
    () =>
      validateProviderLaunchRole(
        {
          agent: 'codex',
          codex: {
            approval: 'on-request',
            sandbox: 'workspace-write',
          },
        },
        'roles.reviewer',
      ),
    /roles\.reviewer\.model must be a non-empty string/,
  );
});

test('normalization rejects flat launch fields, unknown provider blocks, and unsupported agents', () => {
  assert.throws(
    () =>
      normalizeProviderLaunchPolicy(
        { approval: 'on-request' },
        'roleDefaults',
        {},
        'roles.implementer',
      ),
    /roleDefaults\.approval is not supported; move launch settings under roleDefaults\.codex or roleDefaults\.claude/,
  );

  assert.throws(
    () =>
      normalizeProviderLaunchPolicy(
        {},
        'roleDefaults',
        { gemini: { permissionMode: 'auto' } },
        'roles.implementer',
      ),
    /roles\.implementer\.gemini is not a supported provider block/,
  );

  assert.throws(
    () =>
      normalizeProviderLaunchPolicy(
        {},
        'roleDefaults',
        { agent: 'gemini' },
        'roles.implementer',
      ),
    /roles\.implementer\.agent must be one of: codex, claude/,
  );
});
