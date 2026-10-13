import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/piskie-test',
    getAppPath: () => process.cwd(),
    isPackaged: false,
  },
}));

import browserCore from '../../piskiepilot/browser/skills/browser/skill.js';
import {
  attachSkillProvenance,
  type DefinedSkill,
  type SkillDomain,
  type SkillFunctions,
} from '../../piskiepilot/core/skill/define.js';
import { createProcessToolCatalog } from '../index.js';
import { parse, toApiSchema } from '../params.js';

type JsonSchema = Record<string, unknown>;
type ScalarCase = Readonly<{
  path: Array<string | number>;
  kind: 'boolean' | 'integer' | 'number';
  value: boolean | number;
  optional: boolean;
}>;

const fixedSkills = [
  browserCore,
].map((skill) => attachSkillProvenance(
  skill as DefinedSkill<SkillDomain, SkillFunctions>,
  { root: `/builtin/${skill.name}`, trust: 'builtin', entryPoint: 'direct' },
));

const includeEveryName = { includes: () => true } as unknown as readonly string[];

// The source-aligned browser tools accept JSON scalar types without coercion.
// Host browser helpers retain their existing coercing parameter contract.
const STRICT_BROWSER_TOOLS = new Set([
  'list_pages', 'new_page', 'select_page', 'close_page', 'navigate_page',
  'take_snapshot', 'click', 'hover', 'fill', 'fill_form', 'type_text',
  'press_key', 'drag', 'upload_file', 'wait_for', 'handle_dialog',
  'take_screenshot', 'evaluate_script', 'list_console_messages',
  'get_console_message', 'list_network_requests', 'get_network_request',
].map((name) => `browser_${name}`));

// Cross-field constraints need a valid combination beyond sampling each field independently.
// An `undefined` override removes the sampled field.
const BASELINE_OVERRIDES: Record<string, JsonSchema> = {
  subagent: { type: 'local-worker', subject: '本地任务', prompt: '完成看板任务', skills: ['skill-a'] },
  web_search: { publishedAfter: '2026-01-01', publishedBefore: '2026-02-01' },
  schedule: { delaySeconds: 60, at: undefined, cron: undefined },
};

// Optional numerics that stand in for a required choice: clearing them leaves no choice, so rejection is correct.
const EXCLUSIVE_NUMERIC_PARAMS = new Set([
  'schedule.delaySeconds',
]);

function applyOverrides(base: JsonSchema, overrides: JsonSchema | undefined): JsonSchema {
  const merged = { ...base, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) delete merged[key];
  }
  return merged;
}

function selectSchema(schema: JsonSchema): JsonSchema {
  const alternatives = (schema.oneOf ?? schema.anyOf) as JsonSchema[] | undefined;
  if (!alternatives?.[0]) return schema;
  const outer = { ...schema };
  delete outer.oneOf;
  delete outer.anyOf;
  return { ...outer, ...alternatives[0] };
}

function sampleString(schema: JsonSchema): string {
  const pattern = typeof schema.pattern === 'string' ? schema.pattern : '';
  if (pattern.includes('\\d+_\\d+')) return '1_1';
  if (pattern.includes('https?')) return 'https://example.com';
  if (pattern.includes('\\d+x\\d+')) return '1x1';
  if (schema.format === 'uri' || schema.format === 'url') return 'https://example.com';
  return 'x'.repeat(Math.max(1, Number(schema.minLength ?? 1)));
}

function sampleNumber(schema: JsonSchema): number {
  if (typeof schema.default === 'number') return schema.default;
  const minimum = typeof schema.minimum === 'number' ? schema.minimum : 0;
  const exclusive = typeof schema.exclusiveMinimum === 'number' ? schema.exclusiveMinimum : undefined;
  const value = exclusive === undefined ? Math.max(1, minimum) : Math.max(1, exclusive + 1);
  return schema.type === 'integer' ? Math.ceil(value) : value;
}

function sample(schemaValue: JsonSchema): unknown {
  const schema = selectSchema(schemaValue);
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];

  switch (schema.type) {
    case 'object': {
      const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
      if (
        Object.keys(properties).length === 0
        && schema.additionalProperties
        && typeof schema.additionalProperties === 'object'
      ) {
        return { key: sample(schema.additionalProperties as JsonSchema) };
      }
      return Object.fromEntries(Object.entries(properties).map(([key, child]) => [key, sample(child)]));
    }
    case 'array': {
      const count = Math.max(1, Number(schema.minItems ?? 0));
      return Array.from({ length: count }, () => sample((schema.items ?? {}) as JsonSchema));
    }
    case 'boolean':
      return typeof schema.default === 'boolean' ? schema.default : false;
    case 'integer':
    case 'number':
      return sampleNumber(schema);
    case 'string':
      return typeof schema.default === 'string' ? schema.default : sampleString(schema);
    case 'null':
      return null;
    default:
      return {};
  }
}

function scalarCases(
  schemaValue: JsonSchema,
  value: unknown,
  path: Array<string | number> = [],
  optional = false,
): ScalarCase[] {
  const schema = selectSchema(schemaValue);
  if (schema.type === 'boolean') {
    return [{ path, kind: 'boolean', value: value as boolean, optional }];
  }
  if (schema.type === 'integer' || schema.type === 'number') {
    return [{ path, kind: schema.type, value: value as number, optional }];
  }
  if (schema.type === 'array') {
    return scalarCases((schema.items ?? {}) as JsonSchema, (value as unknown[])[0], [...path, 0]);
  }
  if (schema.type !== 'object') return [];

  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const object = value as Record<string, unknown>;
  return Object.entries(properties).flatMap(([key, child]) => (
    scalarCases(child, object[key], [...path, key], !required.has(key))
  ));
}

function replaceAtPath(input: unknown, path: readonly (string | number)[], value: unknown): unknown {
  const clone = structuredClone(input);
  let cursor = clone as Record<string | number, unknown>;
  for (const segment of path.slice(0, -1)) {
    cursor = cursor[segment] as Record<string | number, unknown>;
  }
  cursor[path.at(-1)!] = value;
  return clone;
}

function valueAtPath(input: unknown, path: readonly (string | number)[]): unknown {
  let current = input;
  for (const segment of path) {
    current = (current as Record<string | number, unknown> | undefined)?.[segment];
  }
  return current;
}

describe('model-facing parameter runtime matrix', () => {
  it('covers every current native tool and built-in Skill function with one zod runtime contract', () => {
    const catalog = createProcessToolCatalog(undefined, {
      getExecutableSkills: () => fixedSkills,
    } as never);
    const snapshots = (['main', 'subagent'] as const).map((agentType) => catalog.snapshot({
      scope: agentType,
      agentType: agentType === 'main' ? 'main' : 'worker',
      searchCapabilities: { domains: true, publishedAfter: true, publishedBefore: true },
      customTools: includeEveryName,
      exposedSkillFunctions: includeEveryName,
      excluded: new Set(),
      domains: new Set(['local', 'browser']),
      subagentTypes: [
        { name: 'local-worker', description: '本地执行', assignment: 'work-package', browser: false, skills: true },
      ],
    }));
    const entries = new Map(snapshots.flatMap((snapshot) => (
      snapshot.definitions().map((definition) => [
        definition.name,
        { definition, entry: snapshot.resolve(definition.name)! },
      ] as const)
    )));
    const definitions = [...entries.values()].map(({ definition }) => definition);
    const fixedNames = new Set(fixedSkills.flatMap((skill) => (
      Object.keys(skill.functions).map((name) => `${skill.name}_${name}`)
    )));

    const fixedDefinitions = definitions.filter((definition) => fixedNames.has(definition.name));
    const nativeDefinitions = definitions.filter((definition) => !fixedNames.has(definition.name));
    expect(fixedDefinitions).toHaveLength(fixedNames.size);
    expect(nativeDefinitions.length).toBeGreaterThan(0);
    expect(definitions).toHaveLength(fixedDefinitions.length + nativeDefinitions.length);
    expect(entries.has('agent_run')).toBe(true);
    expect(entries.has('flow')).toBe(false);

    const schemaContractFailures = [...entries].flatMap(([name, { definition, entry }]) => {
      const sourceSchema = toApiSchema(entry.contract.schema);
      const published = definition.input_schema;
      const failures: string[] = [];
      if (sourceSchema.type !== 'object') failures.push(`${name}: source schema root is not object`);
      if (published.type !== 'object') failures.push(`${name}: published schema root is not object`);
      if (
        !published.properties
        || typeof published.properties !== 'object'
        || Array.isArray(published.properties)
      ) {
        failures.push(`${name}: published schema properties is not an object`);
      }
      return failures;
    });
    expect(schemaContractFailures).toEqual([]);

    expect(entries.get('agent_run')?.definition.input_schema).toMatchObject({
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'stop'] },
        taskDescription: { type: 'string' },
        agentId: { type: 'string' },
      },
      required: ['action'],
      oneOf: [
        { properties: { action: { const: 'create' } }, required: ['action', 'taskDescription'] },
        { properties: { action: { const: 'list' } }, required: ['action'] },
        { properties: { action: { const: 'stop' } }, required: ['action', 'agentId'] },
      ],
    });
    expect(entries.get('plan')?.definition.input_schema).toMatchObject({
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'read'] },
        taskSummary: { type: 'string' },
        planDocument: { type: 'string' },
      },
      required: ['action'],
      oneOf: [
        { required: ['action', 'taskSummary', 'planDocument'] },
        { required: ['action'] },
      ],
    });

    const failures: string[] = [];
    let coercionCases = 0;
    let strictCases = 0;
    for (const definition of definitions) {
      const entry = entries.get(definition.name)?.entry;
      if (!entry) {
        failures.push(`${definition.name}: definition is not resolvable in its own snapshot`);
        continue;
      }
      const apiSchema = toApiSchema(entry.contract.schema);
      const baseline = applyOverrides(sample(apiSchema) as JsonSchema, BASELINE_OVERRIDES[definition.name]);
      const baselineResult = parse(entry.contract.schema, baseline);
      if (!baselineResult.ok) {
        failures.push(`${definition.name}: generated valid baseline failed: ${baselineResult.errors.join('; ')}`);
        continue;
      }

      for (const item of scalarCases(apiSchema, baseline)) {
        const path = item.path.join('.');
        const quoted = item.kind === 'boolean' ? 'false' : String(item.value);
        const parsed = parse(
          entry.contract.schema,
          replaceAtPath(baseline, item.path, quoted),
        );
        const qualifiedPath = `${definition.name}.${path}`;
        if (STRICT_BROWSER_TOOLS.has(definition.name)) {
          strictCases += 1;
          const quotedInput = replaceAtPath(baseline, item.path, quoted);
          const emptyInput = replaceAtPath(baseline, item.path, '');
          if (entry.contract.schema.safeParse(quotedInput).success) {
            failures.push(`${qualifiedPath}: source schema accepted a scalar string`);
          }
          if (entry.contract.schema.safeParse(emptyInput).success) {
            failures.push(`${qualifiedPath}: source schema accepted an empty scalar string`);
          }
          if (parsed.ok) failures.push(`${qualifiedPath}: runtime accepted a valued scalar string`);
          const empty = parse(entry.contract.schema, emptyInput);
          if (item.optional) {
            const omitted = parse(
              entry.contract.schema,
              replaceAtPath(baseline, item.path, undefined),
            );
            if (!empty.ok || !omitted.ok) {
              failures.push(`${qualifiedPath}: runtime rejected an omitted optional parameter`);
            } else if (!Object.is(
              valueAtPath(empty.value, item.path),
              valueAtPath(omitted.value, item.path),
            )) {
              failures.push(`${qualifiedPath}: empty optional parameter differs from omission/default`);
            }
          } else if (empty.ok) {
            failures.push(`${qualifiedPath}: runtime accepted an empty required scalar string`);
          }
          continue;
        }
        coercionCases += 1;
        if (!parsed.ok) {
          failures.push(`${qualifiedPath}: rejected ${JSON.stringify(quoted)}`);
          continue;
        }
        let actual: unknown = parsed.value;
        for (const segment of item.path) actual = (actual as Record<string | number, unknown>)[segment];
        if (item.kind === 'boolean' ? actual !== false : actual !== item.value) {
          failures.push(`${qualifiedPath}: parsed to ${JSON.stringify(actual)}`);
        }

        if (item.kind === 'boolean') {
          for (const invalid of ['0', 'yes']) {
            if (parse(entry.contract.schema, replaceAtPath(baseline, item.path, invalid)).ok) {
              failures.push(`${qualifiedPath}: accepted invalid boolean ${JSON.stringify(invalid)}`);
            }
          }
        } else {
          const empty = parse(entry.contract.schema, replaceAtPath(baseline, item.path, ''));
          const clearable = item.optional && !EXCLUSIVE_NUMERIC_PARAMS.has(qualifiedPath);
          if (clearable && !empty.ok) {
            failures.push(`${qualifiedPath}: rejected an empty optional numeric parameter`);
          } else if (!clearable && empty.ok) {
            failures.push(`${qualifiedPath}: accepted an empty required numeric string`);
          }
        }
      }
    }

    expect(coercionCases).toBeGreaterThan(0);
    expect(strictCases).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });
});
