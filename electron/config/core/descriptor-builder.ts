import crypto from 'node:crypto';
import { z } from 'zod';
import type {
  ConfigDescriptor,
  ConfigDynamicExtensionDescriptor,
  ConfigFieldBindingDescriptor,
  ConfigFieldDescriptor,
  ConfigFieldMutability,
} from '../../../shared/types/config.js';
import type { ConfigDomainContract } from '../contracts/domain.js';

interface PiskieJsonSchemaMetadata {
  mutability?: ConfigFieldMutability;
  keyPlaceholder?: string;
  scope?: string;
  changeImpact?: string;
  applyMode?: string;
  recommendedProbe?: string;
  billableProbe?: boolean;
}

interface CollectOptions {
  source: CollectedConfigField['source'];
  extensionId?: string;
  initialPath?: string;
  defaultMutability: ConfigFieldMutability;
}

type CollectedConfigField = Omit<ConfigFieldDescriptor, 'fieldId'>;

export function buildConfigDescriptor(contract: ConfigDomainContract): ConfigDescriptor {
  const readSchema = asJsonSchema(z.toJSONSchema(contract.readSchema));
  const writeSchema = asJsonSchema(z.toJSONSchema(contract.writeSchema, { io: 'input' }));
  const extensions = [...(contract.extensions?.() ?? [])]
    .map(normalizeExtension)
    .sort((left, right) => left.id.localeCompare(right.id));

  const readFields = collectFields(readSchema, {
    source: 'domain',
    defaultMutability: 'read-only',
  });
  const writeFields = collectFields(writeSchema, {
    source: 'domain',
    defaultMutability: 'write',
  });
  const fields = mergeDomainFields(readFields, writeFields);

  for (const extension of extensions) {
    for (const extensionSchema of extension.schemas) {
      fields.push(...collectFields(extensionSchema.schema, {
        source: 'extension',
        extensionId: extension.id,
        initialPath: extensionSchema.path,
        defaultMutability: 'write',
      }));
    }
  }

  const normalizedFields = deduplicateFields(fields)
    .sort(compareFields)
    .map((field) => identifyField(contract.id, field));
  const descriptorBody = {
    domain: contract.id,
    title: contract.title,
    description: contract.description,
    schemaVersion: contract.schemaVersion,
    capabilities: [...contract.capabilities],
    readSchema,
    writeSchema,
    fields: normalizedFields,
    dynamicExtensions: extensions,
  };

  return {
    ...descriptorBody,
    descriptorHash: crypto
      .createHash('sha256')
      .update(canonicalJson(descriptorBody))
      .digest('hex'),
  };
}

export function undocumentedWritableFields(
  descriptor: ConfigDescriptor,
): ConfigFieldDescriptor[] {
  return descriptor.fields.filter((field) => field.leaf
    && (field.mutability === 'write' || field.mutability === 'create-only')
    && !field.description?.trim());
}

function collectFields(
  root: Record<string, unknown>,
  options: CollectOptions,
): CollectedConfigField[] {
  const fields: CollectedConfigField[] = [];
  const initialPath = options.initialPath ?? '';
  visitSchema(
    root,
    root,
    initialPath,
    templateBindings(initialPath),
    false,
    options,
    fields,
    new Set(),
  );
  return fields;
}

function visitSchema(
  rawSchema: unknown,
  root: Record<string, unknown>,
  path: string,
  bindings: readonly ConfigFieldBindingDescriptor[],
  required: boolean,
  options: CollectOptions,
  fields: CollectedConfigField[],
  resolvingRefs: Set<string>,
  emitCurrent = true,
): void {
  const schema = resolveSchema(rawSchema, root, resolvingRefs);
  if (!schema) return;

  if (path && emitCurrent) fields.push(toField(schema, path, bindings, required, options));

  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives)) {
    for (const alternative of alternatives) {
      visitSchema(
        alternative,
        root,
        path,
        bindings,
        required,
        options,
        fields,
        new Set(resolvingRefs),
        false,
      );
    }
  }

  const requiredNames = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === 'string')
      : [],
  );
  if (isRecord(schema.properties)) {
    for (const [name, child] of Object.entries(schema.properties)) {
      visitSchema(
        child,
        root,
        appendPointer(path, name),
        bindings,
        requiredNames.has(name),
        options,
        fields,
        new Set(resolvingRefs),
      );
    }
  }

  if (isRecord(schema.additionalProperties)) {
    const metadata = piskieMetadata(schema);
    const placeholder = uniqueBindingName(metadata.keyPlaceholder?.trim() || 'key', bindings);
    visitSchema(
      schema.additionalProperties,
      root,
      `${path}/{${placeholder}}`,
      [...bindings, { name: placeholder, kind: 'record-key' }],
      true,
      options,
      fields,
      new Set(resolvingRefs),
    );
  }

  if (isRecord(schema.items)) {
    const placeholder = uniqueBindingName('index', bindings);
    visitSchema(
      schema.items,
      root,
      `${path}/{${placeholder}}`,
      [...bindings, { name: placeholder, kind: 'array-index' }],
      true,
      options,
      fields,
      new Set(resolvingRefs),
    );
  }
}

function resolveSchema(
  value: unknown,
  root: Record<string, unknown>,
  resolvingRefs: Set<string>,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const reference = typeof value.$ref === 'string' ? value.$ref : undefined;
  if (!reference?.startsWith('#/')) return value;
  if (resolvingRefs.has(reference)) return value;
  resolvingRefs.add(reference);
  const target = reference
    .slice(2)
    .split('/')
    .map(unescapePointerToken)
    .reduce<unknown>((current, token) => isRecord(current) ? current[token] : undefined, root);
  const resolved = resolveSchema(target, root, resolvingRefs);
  return resolved ? { ...resolved, ...withoutKey(value, '$ref') } : value;
}

function toField(
  schema: Record<string, unknown>,
  pathTemplate: string,
  bindings: readonly ConfigFieldBindingDescriptor[],
  required: boolean,
  options: CollectOptions,
): CollectedConfigField {
  const metadata = piskieMetadata(schema);
  const enumValues = enumValuesOf(schema);
  return {
    pathTemplate,
    bindings: [...bindings],
    source: options.source,
    ...(options.extensionId && { extensionId: options.extensionId }),
    leaf: isLeafSchema(schema),
    ...(typeof schema.title === 'string' && { title: schema.title }),
    ...(typeof schema.description === 'string' && { description: schema.description }),
    ...(jsonTypeOf(schema) !== undefined && { jsonType: jsonTypeOf(schema) }),
    ...(enumValues.length > 0 && { enum: enumValues }),
    ...(Object.hasOwn(schema, 'default') && { default: schema.default }),
    required,
    mutability: metadata.mutability ?? options.defaultMutability,
    ...(metadata.scope && { scope: metadata.scope }),
    ...(metadata.changeImpact && { changeImpact: metadata.changeImpact }),
    ...(metadata.applyMode && { applyMode: metadata.applyMode }),
    ...(metadata.recommendedProbe && { recommendedProbe: metadata.recommendedProbe }),
    ...(metadata.billableProbe !== undefined && { billableProbe: metadata.billableProbe }),
  };
}

function isLeafSchema(schema: Record<string, unknown>): boolean {
  if (isRecord(schema.properties) || isRecord(schema.additionalProperties) || isRecord(schema.items)) {
    return false;
  }
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives)) {
    return alternatives.some((alternative) => isRecord(alternative) && isLeafSchema(alternative));
  }
  return typeof schema.type === 'string'
    || Array.isArray(schema.type)
    || Array.isArray(schema.enum)
    || Object.hasOwn(schema, 'const');
}

function mergeDomainFields(
  readFields: readonly CollectedConfigField[],
  writeFields: readonly CollectedConfigField[],
): CollectedConfigField[] {
  const writablePaths = new Set(writeFields.map((field) => field.pathTemplate));
  const readPaths = new Set(readFields.map((field) => field.pathTemplate));
  return [
    ...readFields.map((field) => ({
      ...field,
      mutability: field.mutability === 'read-only' && writablePaths.has(field.pathTemplate)
        ? 'write' as const
        : field.mutability,
    })),
    ...writeFields.filter((field) => !readPaths.has(field.pathTemplate)),
  ];
}

function deduplicateFields(fields: readonly CollectedConfigField[]): CollectedConfigField[] {
  const unique = new Map<string, CollectedConfigField>();
  for (const field of fields) {
    const key = `${field.source}:${field.extensionId ?? ''}:${field.pathTemplate}`;
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, field);
      continue;
    }
    unique.set(key, {
      ...existing,
      ...field,
      required: existing.required || field.required,
      enum: mergeEnum(existing.enum, field.enum),
      description: existing.description ?? field.description,
      title: existing.title ?? field.title,
    });
  }
  return [...unique.values()];
}

function normalizeExtension(extension: ConfigDynamicExtensionDescriptor): ConfigDynamicExtensionDescriptor {
  return {
    ...extension,
    schemas: [...extension.schemas]
      .map((schema) => ({ ...schema, schema: asJsonSchema(schema.schema) }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function enumValuesOf(schema: Record<string, unknown>): unknown[] {
  const values: unknown[] = [];
  if (Array.isArray(schema.enum)) values.push(...schema.enum);
  if (Object.hasOwn(schema, 'const')) values.push(schema.const);
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives)) {
    for (const alternative of alternatives) {
      if (isRecord(alternative)) values.push(...enumValuesOf(alternative));
    }
  }
  return [...new Map(values.map((value) => [canonicalJson(value), value])).values()];
}

function jsonTypeOf(schema: Record<string, unknown>): string | string[] | undefined {
  if (typeof schema.type === 'string') return schema.type;
  if (Array.isArray(schema.type)
    && schema.type.every((value): value is string => typeof value === 'string')) {
    return schema.type;
  }
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (!Array.isArray(alternatives)) return undefined;
  const types = alternatives.flatMap((alternative) => {
    if (!isRecord(alternative)) return [];
    const type = jsonTypeOf(alternative);
    return typeof type === 'string' ? [type] : type ?? [];
  });
  const unique = [...new Set(types)];
  return unique.length === 1 ? unique[0] : unique.length > 1 ? unique : undefined;
}

function piskieMetadata(schema: Record<string, unknown>): PiskieJsonSchemaMetadata {
  return isRecord(schema['x-piskie'])
    ? schema['x-piskie'] as PiskieJsonSchemaMetadata
    : {};
}

function compareFields(left: CollectedConfigField, right: CollectedConfigField): number {
  return left.pathTemplate.localeCompare(right.pathTemplate)
    || (left.extensionId ?? '').localeCompare(right.extensionId ?? '')
    || left.source.localeCompare(right.source);
}

function identifyField(domain: string, field: CollectedConfigField): ConfigFieldDescriptor {
  const identity = canonicalJson({
    domain,
    source: field.source,
    extensionId: field.extensionId,
    pathTemplate: field.pathTemplate,
  });
  return {
    fieldId: `field_${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24)}`,
    ...field,
  };
}

function templateBindings(pathTemplate: string): ConfigFieldBindingDescriptor[] {
  if (!pathTemplate) return [];
  return pathTemplate
    .slice(1)
    .split('/')
    .flatMap((token) => {
      const match = /^\{([A-Za-z][A-Za-z0-9_]*)\}$/.exec(token);
      if (!match) return [];
      return [{
        name: match[1]!,
        kind: match[1] === 'index' ? 'array-index' as const : 'record-key' as const,
      }];
    });
}

function uniqueBindingName(
  preferred: string,
  bindings: readonly ConfigFieldBindingDescriptor[],
): string {
  const names = new Set(bindings.map((binding) => binding.name));
  if (!names.has(preferred)) return preferred;
  let suffix = 2;
  while (names.has(`${preferred}${suffix}`)) suffix++;
  return `${preferred}${suffix}`;
}

function appendPointer(base: string, token: string): string {
  return `${base}/${token.replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function unescapePointerToken(token: string): string {
  return token.replaceAll('~1', '/').replaceAll('~0', '~');
}

function withoutKey(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([entryKey]) => entryKey !== key));
}

function mergeEnum(left: unknown[] | undefined, right: unknown[] | undefined): unknown[] | undefined {
  const values = [...(left ?? []), ...(right ?? [])];
  return values.length > 0
    ? [...new Map(values.map((value) => [canonicalJson(value), value])).values()]
    : undefined;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}

function asJsonSchema(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Config schema must convert to a JSON object');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
