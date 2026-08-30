import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import browserCore from '../../../browser/skills/browser/skill.js';
import { buildLoadedSkillEntries } from '../../../../tools/skill/domain-descriptors.js';
import { toApiSchema, z } from '../../../../tools/params.js';
import {
  assertDefinedSkill,
  attachSkillProvenance,
  skillToolName,
  type DefinedSkill,
  type SkillDomain,
  type SkillFunctions,
} from '../define.js';

const FIXED = [
  {
    skill: browserCore,
    functions: 30,
  },
] as const;

const SYSTEM_PARAMS = ['browserId', 'taskId', 'executorId'] as const;

describe('defineSkill module contract', () => {
  it('publishes exactly the current 30 built-in functions', () => {
    let total = 0;
    for (const { skill, functions } of FIXED) {
      assertDefinedSkill(skill);
      expect(Object.keys(skill.functions)).toHaveLength(functions);

      const loaded = attachSkillProvenance(
        skill as DefinedSkill<SkillDomain, SkillFunctions>,
        { root: `/builtin/${skill.name}`, trust: 'builtin', entryPoint: 'direct' },
      );
      const entries = buildLoadedSkillEntries(loaded);
      expect(entries).toHaveLength(functions);
      expect(entries.map((entry) => entry.tool.def.name)).toEqual(
        Object.keys(skill.functions).map((name) => skillToolName(skill.name, name)),
      );
      expect(entries.every((entry) => !entry.tool.def.name.includes('.'))).toBe(true);
      total += functions;
    }
    expect(total).toBe(30);
  });

  it('keeps all system identifiers out of every fixed function schema', () => {
    for (const { skill } of FIXED) {
      for (const fn of Object.values(skill.functions)) {
        const schema = toApiSchema(fn.params);
        for (const name of SYSTEM_PARAMS) {
          expect(schema.properties).not.toHaveProperty(name);
        }
      }
    }
  });

  it('returns browser snapshots as raw text without JSON escaping', async () => {
    const snapshot = '[1_1] button "Continue"\n[1_2] textbox "Name"';
    const output = await browserCore.functions.takeSnapshot.run({ verbose: false }, {
      signal: new AbortController().signal,
      browserId: 'browser-1',
      browser: { core: { takeSnapshot: vi.fn(async () => snapshot) } } as never,
      log: vi.fn(),
    });

    expect(output).toEqual({ ok: true, text: snapshot });
    expect(output.text).toContain('\n');
    expect(output.text).not.toContain('\\n');
    expect(output.text.startsWith('"')).toBe(false);
  });

  it('rejects non-object function parameters before a Skill reaches the tool catalog', () => {
    const invalid = {
      name: 'scalar-params',
      domain: 'local',
      functions: {
        run: {
          description: 'run',
          params: z.string(),
          async run() { return { ok: true as const, text: 'ok' }; },
        },
      },
    };
    expect(() => assertDefinedSkill(invalid)).toThrow(/object-shaped zod params schema/);
  });

  it('rejects a Browser Skill with no callable business functions', () => {
    expect(() => assertDefinedSkill({
      name: 'empty-browser-skill',
      domain: 'browser',
      functions: {},
    })).toThrow(/at least one callable business function/);
  });

  it('rejects host runtime identifiers anywhere in Browser Skill business parameters', () => {
    expect(() => assertDefinedSkill({
      name: 'host-parameter-browser-skill',
      domain: 'browser',
      functions: {
        inspect: {
          description: 'Inspect with invalid host parameters',
          params: z.object({
            query: z.string(),
            recovery: z.object({ browserId: z.string(), taskId: z.string().optional() }),
          }),
          async run() { return { ok: true as const, text: 'ok' }; },
        },
      },
    })).toThrow(/recovery\.browserId, recovery\.taskId/);

    expect(() => assertDefinedSkill({
      name: 'host-parameter-local-skill',
      domain: 'local',
      functions: {
        inspect: {
          description: 'Local schemas retain their existing semantics',
          params: z.object({ taskId: z.string() }),
          async run() { return { ok: true as const, text: 'ok' }; },
        },
      },
    })).not.toThrow();
  });

  it('keeps runtime identifiers out of fixed Skill teaching documents', async () => {
    const docs = [
      await readFile(new URL('../../../browser/skills/browser/SKILL.md', import.meta.url), 'utf8'),
    ];
    for (const doc of docs) {
      for (const name of SYSTEM_PARAMS) expect(doc).not.toContain(name);
    }
  });
});
