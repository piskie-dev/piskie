import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import browserCore from '../../../browser/skills/browser/skill.js';
import { toApiSchema } from '../../../../tools/params.js';

type JsonObject = Record<string, unknown>;
type Baseline = Record<string, Record<string, {
  description: string;
  schema: JsonObject;
}>>;

const skills = [browserCore];
const baseline = JSON.parse(await readFile(
  new URL('./fixtures/fixed-skill-model-schema-baseline.json', import.meta.url),
  'utf8',
)) as Baseline;

function normalizeSemanticNoOps(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeSemanticNoOps);
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? value.replaceAll('\\/', '/') : value;
  }

  const result = Object.fromEntries(Object.entries(value as JsonObject).map(([key, child]) => [
    key,
    normalizeSemanticNoOps(child),
  ])) as JsonObject;
  if (isEmptyObject(result.properties)) delete result.properties;
  if (isEmptyObject(result.additionalProperties)) delete result.additionalProperties;
  return result;
}

function isEmptyObject(value: unknown): boolean {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value as JsonObject).length === 0;
}

describe('fixed Skill model schema compatibility', () => {
  it('keeps all 30 built-in function descriptions and schemas semantically equivalent', () => {
    let count = 0;
    for (const skill of skills) {
      const expectedSkill = baseline[skill.name];
      expect(Object.keys(skill.functions)).toEqual(Object.keys(expectedSkill));
      for (const [name, fn] of Object.entries(skill.functions)) {
        const actual = toApiSchema(fn.params);
        const expected = expectedSkill[name];
        expect(fn.description, `${skill.name}.${name} description`).toBe(expected.description);
        expect(
          Object.keys((actual.properties ?? {}) as JsonObject),
          `${skill.name}.${name} property order`,
        ).toEqual(Object.keys((expected.schema.properties ?? {}) as JsonObject));
        expect(
          normalizeSemanticNoOps(actual),
          `${skill.name}.${name} schema`,
        ).toEqual(normalizeSemanticNoOps(expected.schema));
        count += 1;
      }
    }
    expect(count).toBe(30);
  });
});
