import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateResultArtifactAgainstSchema } from './result-schema.ts';
import { BUILT_IN_RESULT_SCHEMA_DOCUMENTS } from './result-schema-definitions.ts';

type SchemaCase = {
  schemaName: string;
  payload: Record<string, unknown>;
  invalidPayload: Record<string, unknown>;
  invalidReason: RegExp;
};

function baseArtifact(schemaName: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId: `run-${schemaName}`,
    phase: 'phase',
    role: 'role',
    status: 'complete',
    outcome: 'complete',
    capture: null,
    summary: 'summary',
    payload,
    resultSchema: schemaName,
  };
}

const schemaCases: SchemaCase[] = [
  {
    schemaName: 'implementer-result-v1',
    payload: {
      changedFiles: ['skills/herdr-implement/scripts/result-artifact.ts'],
      checksRun: ['node --test skills/herdr-implement/scripts/*.test.ts'],
      checksDeferred: ['integration'],
      blockers: [],
    },
    invalidPayload: {
      changedFiles: 'skills/herdr-implement/scripts/result-artifact.ts',
      checksRun: ['node --test skills/herdr-implement/scripts/*.test.ts'],
      checksDeferred: ['integration'],
      blockers: [],
    },
    invalidReason: /payload\.changedFiles must be an array of strings/,
  },
  {
    schemaName: 'simplifier-result-v1',
    payload: {
      simplificationSummary: 'Reduced result handling to a focused schema module.',
      changedFiles: ['skills/herdr-implement/scripts/result-schema.ts'],
      checksRun: ['node --test skills/herdr-implement/scripts/*.test.ts'],
      checksDeferred: [],
      blockers: [],
    },
    invalidPayload: {
      simplificationSummary: '',
      changedFiles: ['skills/herdr-implement/scripts/result-schema.ts'],
      checksRun: ['node --test skills/herdr-implement/scripts/*.test.ts'],
      checksDeferred: [],
      blockers: [],
    },
    invalidReason: /payload\.simplificationSummary must be a non-empty string/,
  },
  {
    schemaName: 'reviewer-result-v1',
    payload: {
      verdict: 'approved',
      findings: [
        {
          severity: 'minor',
          message: 'No functional issues found.',
        },
      ],
      hasBlockingFindings: false,
    },
    invalidPayload: {
      verdict: 'approved',
      findings: ['bad'],
      hasBlockingFindings: false,
    },
    invalidReason: /payload\.findings\[0\] must be an object/,
  },
  {
    schemaName: 'verifier-result-v1',
    payload: {
      checksSelected: ['node --test skills/herdr-implement/scripts/*.test.ts'],
      checksRun: ['node --test skills/herdr-implement/scripts/*.test.ts'],
      checksDeferred: [],
      failures: [],
      blockers: [],
    },
    invalidPayload: {
      checksSelected: ['node --test skills/herdr-implement/scripts/*.test.ts'],
      checksRun: 'node --test skills/herdr-implement/scripts/*.test.ts',
      checksDeferred: [],
      failures: [],
      blockers: [],
    },
    invalidReason: /payload\.checksRun must be an array of strings/,
  },
];

test('validateResultArtifactAgainstSchema accepts valid artifacts for the built-in schemas', () => {
  for (const item of schemaCases) {
    assert.doesNotThrow(() =>
      validateResultArtifactAgainstSchema(baseArtifact(item.schemaName, item.payload) as never, item.schemaName),
    );
  }
});

test('validateResultArtifactAgainstSchema rejects invalid payloads for the built-in schemas', () => {
  for (const item of schemaCases) {
    assert.throws(
      () => validateResultArtifactAgainstSchema(baseArtifact(item.schemaName, item.invalidPayload) as never, item.schemaName),
      item.invalidReason,
    );
  }
});

test('checked-in schema files match the shared built-in schema definitions', () => {
  for (const [schemaName, expectedDocument] of Object.entries(BUILT_IN_RESULT_SCHEMA_DOCUMENTS)) {
    const schemaPath = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'schemas', `${schemaName}.json`);
    const fileDocument = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(fileDocument, expectedDocument);
  }
});
