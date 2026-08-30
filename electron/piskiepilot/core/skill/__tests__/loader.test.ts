import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const writeExecutableSkillShim = vi.hoisted(() => vi.fn(async () => ({ dir: '/shim' })));

vi.mock('../../../../skills/executable/host-shim.js', () => ({
  writeExecutableSkillShim,
}));

import { getSkillsDirByType, getSkillsRootDir, setPilotRoot } from '../../../paths.js';
import { SkillLoader, type SkillRoot } from '../loader.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  writeExecutableSkillShim.mockClear();
  setPilotRoot(join(process.cwd(), '.piskiepilot'));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('SkillLoader roots', () => {
  it('refreshes the current build host bridge before importing an executable Skill', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-loader-executable-'));
    temporaryDirectories.push(root);
    setPilotRoot(join(root, 'pilot'));
    const skillName = 'executable-demo';
    const hash = 'a'.repeat(64);
    const installedDir = join(getSkillsDirByType('browser'), skillName);
    const buildDir = join(getSkillsRootDir(), '.build', skillName, hash);
    const moduleDir = join(buildDir, 'module');
    await Promise.all([
      mkdir(installedDir, { recursive: true }),
      mkdir(moduleDir, { recursive: true }),
    ]);
    await writeFile(join(moduleDir, 'SKILL.md'), [
      '---',
      `name: ${skillName}`,
      'type: browser',
      'description: executable fixture',
      '---',
      '',
      '# Fixture',
      '',
    ].join('\n'), 'utf8');
    const zodUrl = pathToFileURL(resolve('node_modules/zod/index.js')).href;
    await writeFile(join(moduleDir, 'skill.js'), [
      `import { z } from ${JSON.stringify(zodUrl)}`,
      `export default { name: '${skillName}', domain: 'browser', functions: {`,
      "  run: { description: 'run', params: z.object({}), async run() { return { ok: true, text: 'ok' } } },",
      '} }',
      '',
    ].join('\n'), 'utf8');
    const customRoot: SkillRoot = {
      dir: getSkillsDirByType('browser'),
      trust: 'custom',
      entryPoint: 'skill_call',
    };
    const loader = new SkillLoader({
      roots: [customRoot],
      typeFilter: 'browser',
    });

    const info = await loader.prepareExecutableSkill({
      skillPath: installedDir,
      sourcePath: moduleDir,
      skillName,
      modulePath: join(moduleDir, 'skill.js'),
    });
    loader.validateSkillPublication(info);
    loader.publishSkill(info);

    expect(writeExecutableSkillShim).toHaveBeenCalledWith(buildDir);
    expect(loader.getSkillModule(skillName)?.name).toBe(skillName);
  });
});
