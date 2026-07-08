export const RESULT_SCHEMA_NAMES = [
  'implementer-result-v1',
  'simplifier-result-v1',
  'reviewer-result-v1',
  'verifier-result-v1',
] as const;

export type ResultSchemaName = (typeof RESULT_SCHEMA_NAMES)[number];

type JsonSchemaDocument = Record<string, unknown>;

export const BUILT_IN_RESULT_SCHEMA_DOCUMENTS: Record<ResultSchemaName, JsonSchemaDocument> = {
  'implementer-result-v1': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'herdr-implement implementer result v1',
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'runId', 'phase', 'role', 'status', 'outcome', 'payload'],
    properties: {
      schemaVersion: { const: 1 },
      runId: { type: 'string', minLength: 1 },
      phase: { type: 'string', minLength: 1 },
      role: { type: 'string', minLength: 1 },
      status: { enum: ['complete', 'blocked', 'failed'] },
      outcome: { type: 'string', minLength: 1 },
      capture: { type: 'object', additionalProperties: true },
      summary: { type: ['string', 'null'] },
      payload: {
        type: 'object',
        additionalProperties: false,
        required: ['changedFiles', 'checksRun', 'checksDeferred', 'blockers'],
        properties: {
          changedFiles: { type: 'array', items: { type: 'string', minLength: 1 } },
          checksRun: { type: 'array', items: { type: 'string', minLength: 1 } },
          checksDeferred: { type: 'array', items: { type: 'string', minLength: 1 } },
          blockers: { type: 'array', items: { type: 'string', minLength: 1 } },
        },
      },
      resultSchema: { type: ['string', 'null'] },
    },
  },
  'simplifier-result-v1': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'herdr-implement simplifier result v1',
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'runId', 'phase', 'role', 'status', 'outcome', 'payload'],
    properties: {
      schemaVersion: { const: 1 },
      runId: { type: 'string', minLength: 1 },
      phase: { type: 'string', minLength: 1 },
      role: { type: 'string', minLength: 1 },
      status: { enum: ['complete', 'blocked', 'failed'] },
      outcome: { type: 'string', minLength: 1 },
      capture: { type: 'object', additionalProperties: true },
      summary: { type: ['string', 'null'] },
      payload: {
        type: 'object',
        additionalProperties: false,
        required: ['simplificationSummary', 'changedFiles', 'checksRun', 'checksDeferred', 'blockers'],
        properties: {
          simplificationSummary: { type: 'string', minLength: 1 },
          changedFiles: { type: 'array', items: { type: 'string', minLength: 1 } },
          checksRun: { type: 'array', items: { type: 'string', minLength: 1 } },
          checksDeferred: { type: 'array', items: { type: 'string', minLength: 1 } },
          blockers: { type: 'array', items: { type: 'string', minLength: 1 } },
        },
      },
      resultSchema: { type: ['string', 'null'] },
    },
  },
  'reviewer-result-v1': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'herdr-implement reviewer result v1',
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'runId', 'phase', 'role', 'status', 'outcome', 'payload'],
    properties: {
      schemaVersion: { const: 1 },
      runId: { type: 'string', minLength: 1 },
      phase: { type: 'string', minLength: 1 },
      role: { type: 'string', minLength: 1 },
      status: { enum: ['complete', 'blocked', 'failed'] },
      outcome: { type: 'string', minLength: 1 },
      capture: { type: 'object', additionalProperties: true },
      summary: { type: ['string', 'null'] },
      payload: {
        type: 'object',
        additionalProperties: false,
        required: ['verdict', 'findings', 'hasBlockingFindings'],
        properties: {
          verdict: { type: 'string', minLength: 1 },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              required: ['severity', 'message'],
              properties: {
                severity: { type: 'string', minLength: 1 },
                message: { type: 'string', minLength: 1 },
              },
            },
          },
          hasBlockingFindings: { type: 'boolean' },
        },
      },
      resultSchema: { type: ['string', 'null'] },
    },
  },
  'verifier-result-v1': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'herdr-implement verifier result v1',
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'runId', 'phase', 'role', 'status', 'outcome', 'payload'],
    properties: {
      schemaVersion: { const: 1 },
      runId: { type: 'string', minLength: 1 },
      phase: { type: 'string', minLength: 1 },
      role: { type: 'string', minLength: 1 },
      status: { enum: ['complete', 'blocked', 'failed'] },
      outcome: { type: 'string', minLength: 1 },
      capture: { type: 'object', additionalProperties: true },
      summary: { type: ['string', 'null'] },
      payload: {
        type: 'object',
        additionalProperties: false,
        required: ['checksSelected', 'checksRun', 'checksDeferred', 'failures', 'blockers'],
        properties: {
          checksSelected: { type: 'array', items: { type: 'string', minLength: 1 } },
          checksRun: { type: 'array', items: { type: 'string', minLength: 1 } },
          checksDeferred: { type: 'array', items: { type: 'string', minLength: 1 } },
          failures: { type: 'array', items: { type: 'string', minLength: 1 } },
          blockers: { type: 'array', items: { type: 'string', minLength: 1 } },
        },
      },
      resultSchema: { type: ['string', 'null'] },
    },
  },
};
