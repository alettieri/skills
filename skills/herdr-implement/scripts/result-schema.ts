import { isRecord, optionalTrimmedString } from './validation.ts';
import {
  BUILT_IN_RESULT_SCHEMA_DOCUMENTS,
  RESULT_SCHEMA_NAMES,
  type ResultSchemaName,
} from './result-schema-definitions.ts';

type JsonSchema = Record<string, unknown>;

type ResultArtifactLike = {
  [key: string]: unknown;
  payload: Record<string, unknown> | null;
};

function isKnownResultSchemaName(value: string): value is ResultSchemaName {
  return (RESULT_SCHEMA_NAMES as readonly string[]).includes(value);
}

function requireKnownResultSchemaName(value: unknown, field: string): ResultSchemaName {
  const schemaName = optionalTrimmedString(value);
  if (!schemaName) {
    throw new Error(`${field} must be a non-empty string`);
  }

  if (!isKnownResultSchemaName(schemaName)) {
    throw new Error(`${field} references unknown result schema: ${schemaName}`);
  }

  return schemaName;
}

function validateValueAgainstSchema(value: unknown, schema: JsonSchema, path: string): void {
  if (schema.const !== undefined) {
    if (!Object.is(value, schema.const)) {
      throw new Error(`${path} must equal ${JSON.stringify(schema.const)}`);
    }
    return;
  }

  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || !schema.enum.some((entry) => Object.is(entry, value))) {
      throw new Error(`${path} must be one of: ${(schema.enum as unknown[]).map((entry) => JSON.stringify(entry)).join(', ')}`);
    }
    return;
  }

  const types = schema.type === undefined ? null : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types) {
    const matchesType = types.some((type) => {
      switch (type) {
        case 'object':
          return isRecord(value);
        case 'array':
          return Array.isArray(value);
        case 'string':
          return typeof value === 'string';
        case 'boolean':
          return typeof value === 'boolean';
        case 'number':
          return typeof value === 'number' && Number.isFinite(value);
        case 'null':
          return value === null;
        default:
          return false;
      }
    });

    if (!matchesType) {
      const itemSchema = isRecord(schema.items) ? (schema.items as JsonSchema) : null;
      const itemTypes = itemSchema?.type === undefined ? null : Array.isArray(itemSchema.type) ? itemSchema.type : [itemSchema.type];
      if (types.includes('array') && itemTypes?.length === 1 && itemTypes[0] === 'string') {
        throw new Error(`${path} must be an array of strings`);
      }
      if (types.includes('array')) {
        throw new Error(`${path} must be an array`);
      }
      if (types.length === 1) {
        switch (types[0]) {
          case 'string':
            throw new Error(`${path} must be a string`);
          case 'object':
            throw new Error(`${path} must be an object`);
          case 'boolean':
            throw new Error(`${path} must be a boolean`);
          case 'number':
            throw new Error(`${path} must be a number`);
          case 'null':
            throw new Error(`${path} must be null`);
        }
      }
      throw new Error(`${path} must be of type ${types.join(', ')}`);
    }
  }

  if (typeof value === 'string' && typeof schema.minLength === 'number' && value.length < schema.minLength) {
    if (schema.minLength === 1) {
      throw new Error(`${path} must be a non-empty string`);
    }
    throw new Error(`${path} must have a minimum length of ${schema.minLength}`);
  }

  if (Array.isArray(value)) {
    if (schema.items !== undefined) {
      for (const [index, entry] of value.entries()) {
        validateValueAgainstSchema(entry, schema.items as JsonSchema, `${path}[${index}]`);
      }
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((entry) => typeof entry === 'string') : [];

  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`${path}.${key} is required`);
    }
  }

  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!Object.hasOwn(value, key)) {
      continue;
    }
    validateValueAgainstSchema(value[key], propertySchema as JsonSchema, `${path}.${key}`);
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) {
        throw new Error(`${path} contains unexpected property: ${key}`);
      }
    }
  }
}

function validateResultArtifactSchema(artifact: Record<string, unknown>, schemaName: ResultSchemaName): void {
  validateValueAgainstSchema(artifact, BUILT_IN_RESULT_SCHEMA_DOCUMENTS[schemaName], 'result artifact');
}

export function isKnownResultSchema(value: string): value is ResultSchemaName {
  return isKnownResultSchemaName(value);
}

export function validateDeclaredResultSchemas(roleId: string, role: Record<string, unknown>): void {
  if (role.resultSchemas === undefined) {
    return;
  }

  if (!Array.isArray(role.resultSchemas)) {
    throw new Error(`roles.${roleId}.resultSchemas must be an array of strings`);
  }

  for (const [index, entry] of role.resultSchemas.entries()) {
    const schemaName = optionalTrimmedString(entry);
    if (!schemaName) {
      throw new Error(`roles.${roleId}.resultSchemas[${index}] must be a non-empty string`);
    }
    if (!isKnownResultSchemaName(schemaName)) {
      throw new Error(`roles.${roleId}.resultSchemas references unknown result schema: ${schemaName}`);
    }
  }
}

export function validatePhaseResultSchemaCompatibility(
  phaseId: string,
  phase: Record<string, unknown>,
  roleId: string,
  role: Record<string, unknown>,
): void {
  if (phase.resultSchema === undefined) {
    return;
  }

  const phaseResultSchema = optionalTrimmedString(phase.resultSchema);
  if (!phaseResultSchema) {
    throw new Error(`phases.${phaseId}.resultSchema must be a non-empty string`);
  }

  if (!isKnownResultSchemaName(phaseResultSchema)) {
    throw new Error(`phases.${phaseId}.resultSchema references unknown result schema: ${phaseResultSchema}`);
  }

  if (role.resultSchemas === undefined) {
    return;
  }

  if (!Array.isArray(role.resultSchemas)) {
    throw new Error(`roles.${roleId}.resultSchemas must be an array of strings`);
  }

  const allowedSchemas: string[] = [];
  for (const [index, entry] of role.resultSchemas.entries()) {
    const schemaName = optionalTrimmedString(entry);
    if (!schemaName) {
      throw new Error(`roles.${roleId}.resultSchemas[${index}] must be a non-empty string`);
    }
    if (!isKnownResultSchemaName(schemaName)) {
      throw new Error(`roles.${roleId}.resultSchemas references unknown result schema: ${schemaName}`);
    }
    allowedSchemas.push(schemaName);
  }

  if (!allowedSchemas.includes(phaseResultSchema)) {
    throw new Error(`phase ${phaseId} resultSchema ${phaseResultSchema} is not allowed by role ${roleId}`);
  }
}

export function validateResultArtifactAgainstSchema(artifact: ResultArtifactLike, schemaName: string): void {
  const resultSchemaName = requireKnownResultSchemaName(schemaName, 'result schema');

  if (artifact.payload === null) {
    throw new Error(`result artifact payload is required for ${resultSchemaName}`);
  }

  if (!isRecord(artifact.payload)) {
    throw new Error('result artifact payload must be an object with string keys');
  }

  const schemaArtifact: Record<string, unknown> = {
    ...artifact,
    payload: artifact.payload,
  };

  if (schemaArtifact.capture === null) {
    delete schemaArtifact.capture;
  }

  validateResultArtifactSchema(schemaArtifact, resultSchemaName);
}
