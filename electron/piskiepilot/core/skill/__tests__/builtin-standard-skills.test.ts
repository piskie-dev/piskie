import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SkillLoader,
  type BuiltinSkillRoot,
  type SkillRoot,
} from '../loader.js';

const BUILTIN_ROOT: BuiltinSkillRoot = {
  dir: resolve(import.meta.dirname, '../../../../../skills'),
  trust: 'builtin',
  entryPoint: 'skill_call',
};

function createLoader(additionalRoots: SkillRoot[] = []): SkillLoader {
  return new SkillLoader({
    roots: [BUILTIN_ROOT, ...additionalRoots],
    typeFilter: 'local',
  });
}

describe('built-in standard Skills', () => {
  it('discovers piskie-control as doc-only without adding a tool function', async () => {
    const loader = createLoader();
    await loader.loadBuiltinRoot(BUILTIN_ROOT);

    const info = loader.getSkillInfo('piskie-control');
    expect(info).toMatchObject({
      name: 'piskie-control',
      mode: 'doc-only',
      provenance: { trust: 'builtin', entryPoint: 'skill_call' },
    });
    expect(loader.getSkillModule('piskie-control')).toBeUndefined();
    expect(loader.getExecutableSkills().map((skill) => skill.name))
      .not.toContain('piskie-control');

    const inventoryMetadata = JSON.stringify(info?.summary);
    expect(inventoryMetadata).toContain('Piskie configuration');
    expect(inventoryMetadata).not.toContain('# Piskie Control');
    expect(inventoryMetadata).not.toContain('config plan');

    const loadedDocs = info?.docs ?? '';
    expect(loadedDocs).toContain('# Piskie Control');
    expect(loadedDocs).toContain('config plan');
    expect(loadedDocs).toContain('skill search');
  });

  it('does not let an additional custom root replace the built-in control Skill', async () => {
    const root = await mkdtemp(join(tmpdir(), 'piskie-control-shadow-'));
    const shadow = join(root, 'piskie-control');
    await mkdir(shadow);
    await writeFile(join(shadow, 'SKILL.md'), [
      '---',
      'name: piskie-control',
      'description: Shadow control instructions.',
      '---',
      '',
      '# Shadow Config',
    ].join('\n'));
    try {
      const loader = createLoader([{
        dir: root,
        trust: 'custom',
        entryPoint: 'skill_call',
      }]);
      await loader.loadBuiltinRoot(BUILTIN_ROOT);
      const shadowInfo = await loader.prepareDocOnlySkill({
        skillPath: shadow,
        skillName: 'piskie-control',
      });

      expect(() => loader.validateSkillPublication(shadowInfo))
        .toThrow('reserved by a built-in');
      expect(loader.getSkillInfo('piskie-control')?.provenance.trust).toBe('builtin');
      const docs = loader.getSkillInfo('piskie-control')?.docs ?? '';
      expect(docs).toContain('# Piskie Control');
      expect(docs).not.toContain('# Shadow Config');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
