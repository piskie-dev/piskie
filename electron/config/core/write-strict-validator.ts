import type { ZodError, ZodType } from 'zod';
import type {
  ConfigPatchOperation,
  ConfigValidationIssue,
} from '../../../shared/types/config.js';

interface SchemaLocation {
  schema: ZodType;
  value: unknown;
  path: readonly PropertyKey[];
}

/**
 * Validates only configuration nodes explicitly added or replaced by a patch.
 * Existing untouched nodes may be incomplete after a schema upgrade, while a
 * record/object/array written as one value must satisfy its full current schema.
 */
export function validateStrictConfigWrites(
  schema: ZodType,
  candidate: unknown,
  patch: readonly ConfigPatchOperation[],
): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  for (const operation of patch) {
    const tokens = parsePointer(operation.path);
    if (operation.op === 'remove' && tokens.length > 0) {
      const parent = locateSchema(schema, candidate, tokens.slice(0, -1));
      if (!parent) {
        issues.push(notWritableIssue(operation.path));
        continue;
      }
      const parentType = definitionOf(unwrap(parent.schema, parent.value)).type;
      // Record keys are entities, so deleting one is valid even when its old
      // value predates required fields. Arrays must retain their own bounds.
      if (parentType === 'record') continue;
      if (parentType === 'array' || parentType === 'tuple') {
        const result = parent.schema.safeParse(parent.value);
        if (!result.success) issues.push(...zodIssues(result.error, parent.path));
        continue;
      }
    }
    const location = locateSchema(schema, candidate, tokens);
    if (!location) {
      issues.push(notWritableIssue(operation.path));
      continue;
    }
    const result = location.schema.safeParse(location.value);
    if (result.success) continue;
    issues.push(...zodIssues(result.error, location.path));
  }
  return dedupeIssues(issues);
}

function notWritableIssue(path: string): ConfigValidationIssue {
  return {
    stage: 'schema',
    code: 'CONFIG_FIELD_NOT_WRITABLE',
    path,
    message: `Configuration path is not writable: ${path}`,
  };
}

function locateSchema(
  schema: ZodType,
  value: unknown,
  path: readonly string[],
): SchemaLocation | undefined {
  let currentSchema = unwrap(schema, value);
  let currentValue = value;
  const consumed: PropertyKey[] = [];

  for (let index = 0; index < path.length; index += 1) {
    currentSchema = unwrap(currentSchema, currentValue);
    const definition = definitionOf(currentSchema);
    const token = path[index]!;

    // z.unknown()/z.any() deliberately delegate the remainder of the subtree
    // to Domain semantic validation.
    if (definition.type === 'unknown' || definition.type === 'any') {
      for (const remaining of path.slice(index)) {
        if (Array.isArray(currentValue)) currentValue = currentValue[Number(remaining)];
        else if (isRecord(currentValue)) currentValue = currentValue[remaining];
        else currentValue = undefined;
        consumed.push(remaining);
      }
      return { schema: currentSchema, value: currentValue, path: consumed };
    }

    if (definition.type === 'object') {
      const shape = objectShape(currentSchema);
      const child = shape[token] ?? catchallSchema(definition);
      if (!child || !isRecord(currentValue)) return undefined;
      currentValue = currentValue[token];
      currentSchema = child;
      consumed.push(token);
      continue;
    }

    if (definition.type === 'record') {
      const child = definition.valueType;
      if (!child || !isRecord(currentValue)) return undefined;
      currentValue = currentValue[token];
      currentSchema = child;
      consumed.push(token);
      continue;
    }

    if (definition.type === 'array' || definition.type === 'tuple') {
      if (!Array.isArray(currentValue)) return undefined;
      const arrayIndex = Number(token);
      if (!Number.isInteger(arrayIndex) || arrayIndex < 0) return undefined;
      const child = definition.type === 'array'
        ? definition.element
        : definition.items?.[arrayIndex] ?? definition.rest;
      if (!child) return undefined;
      currentValue = currentValue[arrayIndex];
      currentSchema = child;
      consumed.push(arrayIndex);
      continue;
    }

    return undefined;
  }

  // Keep the endpoint wrapper: removing an optional property must validate as
  // `undefined`, while removing a required property still fails its schema.
  return { schema: currentSchema, value: currentValue, path: consumed };
}

function unwrap(schema: ZodType, value: unknown): ZodType {
  let current = schema;
  const visited = new Set<ZodType>();
  while (!visited.has(current)) {
    visited.add(current);
    const definition = definitionOf(current);
    if (isWrapper(definition.type) && definition.innerType) {
      current = definition.innerType;
      continue;
    }
    if (definition.type === 'pipe' && definition.in) {
      current = definition.in;
      continue;
    }
    if (definition.type === 'lazy' && definition.getter) {
      current = definition.getter();
      continue;
    }
    if (definition.type === 'union' && definition.options) {
      const option = bestUnionOption(definition.options, value);
      if (option) {
        current = option;
        continue;
      }
    }
    break;
  }
  return current;
}

function bestUnionOption(options: readonly ZodType[], value: unknown): ZodType | undefined {
  const successful = options.find((option) => option.safeParse(value).success);
  if (successful) return successful;
  if (!isRecord(value)) return options[0];

  return options
    .map((option) => ({ option, score: matchingObjectFields(option, value) }))
    .sort((left, right) => right.score - left.score)[0]?.option;
}

function matchingObjectFields(schema: ZodType, value: Record<string, unknown>): number {
  const current = unwrapNonUnion(schema);
  if (definitionOf(current).type !== 'object') return -1;
  let score = 0;
  for (const [key, child] of Object.entries(objectShape(current))) {
    if (!Object.hasOwn(value, key)) continue;
    score += child.safeParse(value[key]).success ? 2 : -1;
  }
  return score;
}

function unwrapNonUnion(schema: ZodType): ZodType {
  let current = schema;
  const visited = new Set<ZodType>();
  while (!visited.has(current)) {
    visited.add(current);
    const definition = definitionOf(current);
    if (isWrapper(definition.type) && definition.innerType) current = definition.innerType;
    else if (definition.type === 'pipe' && definition.in) current = definition.in;
    else if (definition.type === 'lazy' && definition.getter) current = definition.getter();
    else break;
  }
  return current;
}

function zodIssues(error: ZodError, prefix: readonly PropertyKey[]): ConfigValidationIssue[] {
  return error.issues.map((issue) => ({
    stage: 'schema',
    code: issue.code,
    path: pointer([...prefix, ...issue.path]),
    message: issue.message,
  }));
}

function dedupeIssues(issues: readonly ConfigValidationIssue[]): ConfigValidationIssue[] {
  return [...new Map(issues.map((issue) => [
    `${issue.code}\0${issue.path}\0${issue.message}`,
    issue,
  ])).values()];
}

function parsePointer(pointer: string): string[] {
  if (!pointer) return [];
  return pointer.slice(1).split('/').map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function pointer(path: readonly PropertyKey[]): string {
  return `/${path.map((token) => String(token).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
}

interface ZodDefinition {
  type: string;
  shape?: Record<string, ZodType> | (() => Record<string, ZodType>);
  catchall?: ZodType;
  valueType?: ZodType;
  element?: ZodType;
  items?: ZodType[];
  rest?: ZodType;
  options?: ZodType[];
  innerType?: ZodType;
  in?: ZodType;
  getter?: () => ZodType;
}

function definitionOf(schema: ZodType): ZodDefinition {
  return schema.def as ZodDefinition;
}

function objectShape(schema: ZodType): Record<string, ZodType> {
  return (schema as ZodType & { shape: Record<string, ZodType> }).shape;
}

function catchallSchema(definition: ZodDefinition): ZodType | undefined {
  return definition.catchall && definitionOf(definition.catchall).type !== 'never'
    ? definition.catchall
    : undefined;
}

function isWrapper(type: string): boolean {
  return type === 'optional'
    || type === 'nullable'
    || type === 'default'
    || type === 'prefault'
    || type === 'catch'
    || type === 'readonly'
    || type === 'promise';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
