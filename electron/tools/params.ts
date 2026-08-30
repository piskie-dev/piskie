import { z } from 'zod';
import type { ToolInputSchema } from '../../shared/types/index.js';
export { bool, int, num } from '../piskiepilot/core/skill/author-api.js';

/** Function tools always accept one JSON object; scalar/union roots are rejected by TypeScript. */
export type ParamSpec<T> = z.ZodType<T> & z.ZodObject;

export type JSONSchemaObject = Record<string, unknown> & { type?: string };

/** Export the model-facing schema from the same zod contract used at runtime. */
export function toApiSchema(schema: z.ZodType): JSONSchemaObject {
  const input = z.toJSONSchema(schema, {
    target: 'draft-7',
    io: 'input',
  }) as JSONSchemaObject;
  // Zod omits defaults and required markers that sit outside a preprocess
  // node on its input projection. Its output projection retains both, so
  // merge only those annotations while keeping the input-side shape.
  const output = z.toJSONSchema(schema, {
    target: 'draft-7',
    io: 'output',
  }) as JSONSchemaObject;
  const json = restorePreprocessAnnotations(input, output);
  const apiSchema = { ...json };
  delete apiSchema.$schema;
  delete apiSchema.additionalProperties;
  return apiSchema;
}

/** Export a provider-facing function schema from a statically object-shaped contract. */
export function toToolInputSchema(schema: z.ZodObject): ToolInputSchema {
  const apiSchema = toApiSchema(schema);
  return {
    ...apiSchema,
    type: 'object',
    properties: isSchema(apiSchema.properties)
      ? apiSchema.properties as Record<string, unknown>
      : {},
  };
}

function restorePreprocessAnnotations(
  input: JSONSchemaObject,
  output: JSONSchemaObject,
): JSONSchemaObject {
  let merged: JSONSchemaObject = { ...input };
  if (!Object.hasOwn(input, 'default') && Object.hasOwn(output, 'default')) {
    merged = { default: output.default, ...merged };
  }

  const inputProperties = asSchemaMap(input.properties);
  const outputProperties = asSchemaMap(output.properties);
  if (inputProperties && outputProperties) {
    merged.properties = Object.fromEntries(Object.entries(inputProperties).map(([key, child]) => [
      key,
      outputProperties[key]
        ? restorePreprocessAnnotations(child, outputProperties[key])
        : child,
    ]));

    const required = Array.isArray(output.required)
      ? output.required.filter((key): key is string => (
          typeof key === 'string'
          && !Object.hasOwn(outputProperties[key] ?? {}, 'default')
        ))
      : [];
    if (required.length > 0) merged.required = required;
    else delete merged.required;
  }

  if (isSchema(input.items) && isSchema(output.items)) {
    merged.items = restorePreprocessAnnotations(input.items, output.items);
  }
  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    const inputBranches = input[keyword];
    const outputBranches = output[keyword];
    if (!Array.isArray(inputBranches) || !Array.isArray(outputBranches)) continue;
    merged[keyword] = inputBranches.map((branch, index) => (
      isSchema(branch) && isSchema(outputBranches[index])
        ? restorePreprocessAnnotations(branch, outputBranches[index])
        : branch
    ));
  }
  return merged;
}

function isSchema(value: unknown): value is JSONSchemaObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asSchemaMap(value: unknown): Record<string, JSONSchemaObject> | undefined {
  if (!isSchema(value)) return undefined;
  return value as Record<string, JSONSchemaObject>;
}

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

const parameterSchemas = new WeakMap<z.ZodType, JSONSchemaObject>();

function isMissingOptionalParam(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '' || normalized === 'undefined' || normalized === 'null';
}

/** Normalize model placeholder values without mutating the raw call recorded by observers. */
function normalizeOptionalToolParams(schema: z.ZodType, raw: unknown): unknown {
  let apiSchema = parameterSchemas.get(schema);
  if (!apiSchema) {
    apiSchema = toApiSchema(schema);
    parameterSchemas.set(schema, apiSchema);
  }
  return normalizeSchemaValue(apiSchema, raw).value;
}

function normalizeSchemaValue(
  schema: JSONSchemaObject,
  value: unknown,
): { value: unknown; changed: boolean } {
  if (Array.isArray(value) && isSchema(schema.items)) {
    let normalized: unknown[] | undefined;
    value.forEach((item, index) => {
      const child = normalizeSchemaValue(schema.items as JSONSchemaObject, item);
      if (!child.changed) return;
      normalized ??= [...value];
      normalized[index] = child.value;
    });
    return normalized ? { value: normalized, changed: true } : { value, changed: false };
  }

  if (!isSchema(value)) return { value, changed: false };
  const properties = asSchemaMap(schema.properties);
  if (!properties) return { value, changed: false };
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === 'string')
      : [],
  );

  let normalized: JSONSchemaObject | undefined;
  for (const [name, childSchema] of Object.entries(properties)) {
    if (!Object.hasOwn(value, name)) continue;
    const childValue = value[name];
    if (!required.has(name) && isMissingOptionalParam(childValue)) {
      normalized ??= { ...value };
      delete normalized[name];
      continue;
    }
    const child = normalizeSchemaValue(childSchema, childValue);
    if (!child.changed) continue;
    normalized ??= { ...value };
    normalized[name] = child.value;
  }
  return normalized ? { value: normalized, changed: true } : { value, changed: false };
}

/** The sole runtime parameter-validation entry point. */
export function parse<T>(schema: ParamSpec<T>, raw: unknown): ParseResult<T> {
  const result = schema.safeParse(normalizeOptionalToolParams(schema, raw));
  if (result.success) {
    return { ok: true, value: result.data };
  }

  return {
    ok: false,
    errors: result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'params';
      return `${path}: ${issue.message}`;
    }),
  };
}

export { z };
