import { isDeepStrictEqual } from 'node:util';
import { z, type ZodType } from 'zod';

type JsonSchema = Record<string, unknown>;

const MAX_PROJECTION_CANDIDATES = 256;

/**
 * Derives the writable view from the write contract, recursively removing
 * stored-only and runtime-only fields without maintaining a second field map.
 */
export function projectConfigWrite<TWrite>(
  writeSchema: ZodType<TWrite>,
  stored: unknown,
): TWrite {
  const jsonSchema = asSchema(z.toJSONSchema(writeSchema, { io: 'input' }));
  const normalized = omitUndefinedObjectProperties(stored);
  if (!jsonSchema) return writeSchema.parse(normalized);

  const candidates = uniqueCandidates(projectValue(jsonSchema, jsonSchema, normalized));
  for (const candidate of candidates) {
    const parsed = writeSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }

  // Preserve the Zod contract's native error shape when read/write schemas drift.
  return writeSchema.parse(candidates[0] ?? stored);
}

/**
 * Projects a persisted document to its writable shape without requiring every
 * current write-schema field to exist. This is used only as the base for a
 * patch; strict validation is applied to changed configuration nodes later.
 */
export function projectConfigWriteWide(
  writeSchema: ZodType,
  stored: unknown,
): unknown {
  const jsonSchema = asSchema(z.toJSONSchema(writeSchema, { io: 'input' }));
  const normalized = omitUndefinedObjectProperties(stored);
  if (!jsonSchema) return normalized;
  const candidates = uniqueCandidates(projectValue(jsonSchema, jsonSchema, normalized));
  for (const candidate of candidates) if (writeSchema.safeParse(candidate).success) return candidate;
  return candidates[0] ?? normalized;
}

function projectValue(
  rawSchema: unknown,
  root: JsonSchema,
  value: unknown,
): unknown[] {
  const schema = resolveSchema(rawSchema, root);
  if (!schema) return [cloneValue(value)];

  const alternatives = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined;
  if (alternatives) {
    const base = withoutKeys(schema, ['oneOf', 'anyOf']);
    const compatible = alternatives.filter((alternative) => (
      schemaCouldMatch(alternative, root, value)
    ));
    const selected = compatible.length > 0 ? compatible : alternatives;
    return limitCandidates(selected.flatMap((alternative) => {
      const option = asSchema(alternative);
      return option
        ? projectValue(mergeProjectionSchemas(base, option), root, value)
        : [];
    }));
  }

  if (Array.isArray(schema.allOf)) {
    const schemas = [withoutKeys(schema, ['allOf']), ...schema.allOf]
      .map(asSchema)
      .filter((entry): entry is JsonSchema => Boolean(entry));
    return schemas.reduce<unknown[]>(
      (candidates, entry) => limitCandidates(
        candidates.flatMap((candidate) => projectValue(entry, root, candidate)),
      ),
      [value],
    );
  }

  if (isObjectSchema(schema)) return projectObject(schema, root, value);
  if (isArraySchema(schema)) return projectArray(schema, root, value);
  return [cloneValue(value)];
}

function schemaCouldMatch(
  rawSchema: unknown,
  root: JsonSchema,
  value: unknown,
): boolean {
  const schema = resolveSchema(rawSchema, root);
  if (!schema) return true;
  if (Object.hasOwn(schema, 'const') && !isDeepStrictEqual(schema.const, value)) return false;
  if (Array.isArray(schema.enum)
    && !schema.enum.some((entry) => isDeepStrictEqual(entry, value))) return false;

  const types = typeof schema.type === 'string'
    ? [schema.type]
    : Array.isArray(schema.type)
      ? schema.type.filter((entry): entry is string => typeof entry === 'string')
      : [];
  if (types.length > 0 && !types.some((type) => matchesJsonType(type, value))) return false;

  const alternatives = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined;
  if (alternatives && !alternatives.some((entry) => schemaCouldMatch(entry, root, value))) {
    return false;
  }
  if (Array.isArray(schema.allOf)
    && !schema.allOf.every((entry) => schemaCouldMatch(entry, root, value))) return false;

  if (!isRecord(value)) return true;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === 'string')
    : [];
  if (required.some((key) => !Object.hasOwn(value, key))) return false;
  if (isRecord(schema.properties)) {
    for (const [key, child] of Object.entries(schema.properties)) {
      if (Object.hasOwn(value, key) && !schemaCouldMatch(child, root, value[key])) return false;
    }
  }
  return true;
}

function matchesJsonType(type: string, value: unknown): boolean {
  switch (type) {
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isRecord(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return true;
  }
}

function projectObject(
  schema: JsonSchema,
  root: JsonSchema,
  value: unknown,
): unknown[] {
  if (!isRecord(value)) return [cloneValue(value)];

  const properties = isRecord(schema.properties) ? schema.properties : {};
  let candidates: JsonSchema[] = [{}];
  for (const [key, childSchema] of Object.entries(properties)) {
    if (!Object.hasOwn(value, key)) continue;
    candidates = appendObjectProperty(
      candidates,
      key,
      projectValue(childSchema, root, value[key]),
    );
  }

  const additional = schema.additionalProperties;
  if (additional !== false) {
    for (const key of Object.keys(value).filter((entry) => !Object.hasOwn(properties, entry))) {
      const projected = isRecord(additional)
        ? projectValue(additional, root, value[key])
        : [cloneValue(value[key])];
      candidates = appendObjectProperty(candidates, key, projected);
    }
  }
  return candidates;
}

function projectArray(
  schema: JsonSchema,
  root: JsonSchema,
  value: unknown,
): unknown[] {
  if (!Array.isArray(value)) return [cloneValue(value)];

  const prefixItems = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
  let candidates: unknown[][] = [[]];
  for (const [index, item] of value.entries()) {
    const itemSchema = prefixItems[index] ?? schema.items;
    const projected = itemSchema === false || itemSchema === undefined
      ? [cloneValue(item)]
      : projectValue(itemSchema, root, item);
    candidates = limitCandidates(candidates.flatMap((candidate) => (
      projected.map((entry) => [...candidate, entry])
    )));
  }
  return candidates;
}

function appendObjectProperty(
  candidates: readonly JsonSchema[],
  key: string,
  values: readonly unknown[],
): JsonSchema[] {
  return limitCandidates(candidates.flatMap((candidate) => (
    values.map((value) => ({ ...candidate, [key]: value }))
  )));
}

function resolveSchema(rawSchema: unknown, root: JsonSchema): JsonSchema | undefined {
  let schema = asSchema(rawSchema);
  if (!schema) return undefined;

  const visited = new Set<string>();
  while (typeof schema.$ref === 'string') {
    const reference = schema.$ref;
    if (visited.has(reference)) break;
    visited.add(reference);
    const target = resolveReference(root, reference);
    if (!target) break;
    schema = {
      ...target,
      ...withoutKeys(schema, ['$ref']),
    };
  }
  return schema;
}

function resolveReference(root: JsonSchema, reference: string): JsonSchema | undefined {
  if (reference === '#') return root;
  if (!reference.startsWith('#/')) return undefined;
  const target = reference
    .slice(2)
    .split('/')
    .map(unescapePointerToken)
    .reduce<unknown>((current, token) => isRecord(current) ? current[token] : undefined, root);
  return asSchema(target);
}

function mergeProjectionSchemas(base: JsonSchema, option: JsonSchema): JsonSchema {
  const baseProperties = isRecord(base.properties) ? base.properties : undefined;
  const optionProperties = isRecord(option.properties) ? option.properties : undefined;
  const required = [
    ...(Array.isArray(base.required) ? base.required : []),
    ...(Array.isArray(option.required) ? option.required : []),
  ];
  return {
    ...base,
    ...option,
    ...(baseProperties || optionProperties
      ? { properties: { ...baseProperties, ...optionProperties } }
      : {}),
    ...(required.length > 0 ? { required: [...new Set(required)] } : {}),
    ...(base.additionalProperties === false || option.additionalProperties === false
      ? { additionalProperties: false }
      : {}),
  };
}

function isObjectSchema(schema: JsonSchema): boolean {
  return schema.type === 'object'
    || isRecord(schema.properties)
    || Object.hasOwn(schema, 'additionalProperties');
}

function isArraySchema(schema: JsonSchema): boolean {
  return schema.type === 'array'
    || Object.hasOwn(schema, 'items')
    || Array.isArray(schema.prefixItems);
}

function uniqueCandidates<T>(candidates: readonly T[]): T[] {
  const unique = new Map<string, T>();
  for (const candidate of candidates) {
    const key = JSON.stringify([candidate]);
    if (!unique.has(key)) unique.set(key, candidate);
  }
  return [...unique.values()];
}

function limitCandidates<T>(candidates: T[]): T[] {
  const unique = uniqueCandidates(candidates);
  if (unique.length <= MAX_PROJECTION_CANDIDATES) return unique;
  throw new Error(
    `Config write projection exceeded ${MAX_PROJECTION_CANDIDATES} schema alternatives`,
  );
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

/** JSON has no `undefined`; an absent object property preserves optional-field semantics. */
function omitUndefinedObjectProperties(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => omitUndefinedObjectProperties(entry));
  }
  if (!isPlainRecord(value)) return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, omitUndefinedObjectProperties(entry)]),
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function asSchema(value: unknown): JsonSchema | undefined {
  return isRecord(value) ? value : undefined;
}

function withoutKeys(value: JsonSchema, keys: readonly string[]): JsonSchema {
  const excluded = new Set(keys);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !excluded.has(key)));
}

function unescapePointerToken(token: string): string {
  return token.replaceAll('~1', '/').replaceAll('~0', '~');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
