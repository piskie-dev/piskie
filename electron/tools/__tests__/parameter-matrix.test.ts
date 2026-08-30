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

const STRICT_NUMERIC_PARAMS = new Set([
  'browser_getConsoleMessage.msgid',
  'browser_getNetworkRequest.reqid',
]);

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

describe('model-facing parameter coercion matrix', () => {
  it('covers every current native tool and built-in Skill function with one zod runtime contract', () => {
    const catalog = createProcessToolCatalog(undefined, {
      getExecutableSkills: () => fixedSkills,
    } as never);
    const snapshots = (['main', 'subagent'] as const).map((agentType) => catalog.snapshot({
      scope: agentType,
      agentType,
      customTools: includeEveryName,
      exposedSkillFunctions: includeEveryName,
      excluded: new Set(),
      domains: new Set(['local', 'browser']),
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
      const sourceSchema = toApiSchema(entry.tool.def.schema);
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
    for (const definition of definitions) {
      const entry = entries.get(definition.name)?.entry;
      if (!entry) {
        failures.push(`${definition.name}: definition is not resolvable in its own snapshot`);
        continue;
      }
      const apiSchema = toApiSchema(entry.tool.def.schema);
      const baseline = sample(apiSchema);
      const baselineResult = parse(entry.tool.def.schema, baseline);
      if (!baselineResult.ok) {
        failures.push(`${definition.name}: generated valid baseline failed: ${baselineResult.errors.join('; ')}`);
        continue;
      }

      for (const item of scalarCases(apiSchema, baseline)) {
        coercionCases += 1;
        const path = item.path.join('.');
        const quoted = item.kind === 'boolean' ? 'false' : String(item.value);
        const parsed = parse(
          entry.tool.def.schema,
          replaceAtPath(baseline, item.path, quoted),
        );
        const qualifiedPath = `${definition.name}.${path}`;
        if (STRICT_NUMERIC_PARAMS.has(qualifiedPath)) {
          if (parsed.ok) failures.push(`${qualifiedPath}: accepted a numeric string`);
          if (item.optional && !parse(
            entry.tool.def.schema,
            replaceAtPath(baseline, item.path, ''),
          ).ok) {
            failures.push(`${qualifiedPath}: rejected an empty optional numeric parameter`);
          }
          continue;
        }
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
            if (parse(entry.tool.def.schema, replaceAtPath(baseline, item.path, invalid)).ok) {
              failures.push(`${qualifiedPath}: accepted invalid boolean ${JSON.stringify(invalid)}`);
            }
          }
        } else {
          const empty = parse(entry.tool.def.schema, replaceAtPath(baseline, item.path, ''));
          if (item.optional && !empty.ok) {
            failures.push(`${qualifiedPath}: rejected an empty optional numeric parameter`);
          } else if (!item.optional && empty.ok) {
            failures.push(`${qualifiedPath}: accepted an empty required numeric string`);
          }
        }
      }
    }

    expect(coercionCases).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });
});
