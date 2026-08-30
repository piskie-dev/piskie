import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test' },
}));

import { updateRegistry } from '../../core/skill/registry-store.js';
import type { SkillRegistryEntry } from '@shared/types/skill.js';
import { getSkillsDirByType, getSkillsRootDir, setPilotRoot } from '../../paths.js';
import { PilotRuntime } from '../pilot-runtime.js';

const HASH_CURRENT = 'a'.repeat(64);
const HASH_OLD = 'b'.repeat(64);
const startupGlobals = globalThis as typeof globalThis & {
  __piskiePilotStartupImports?: string[];
};

describe('PilotRuntime startup Skill loading', () => {
  let root: string;
  let browserDir: string;
  let runtime: PilotRuntime | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pilot-startup-'));
    setPilotRoot(join(root, 'pilot'));
    browserDir = getSkillsDirByType('browser');
    await mkdir(browserDir, { recursive: true });
    startupGlobals.__piskiePilotStartupImports = [];
  });

  afterEach(async () => {
    await runtime?.dispose();
    runtime = undefined;
    delete startupGlobals.__piskiePilotStartupImports;
    setPilotRoot(join(process.cwd(), '.piskiepilot'));
    await rm(root, { recursive: true, force: true });
  });

  async function writeDocs(skill: string, description = `${skill} docs`): Promise<void> {
    const dir = join(browserDir, skill);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), [
      '---',
      `name: ${skill}`,
      'type: browser',
      'version: "1.0.0"',
      `description: ${description}`,
      '---',
      '',
      `# ${skill}`,
      '',
    ].join('\n'), 'utf8');
  }

  async function writeBuild(skill: string, hash: string, text: string): Promise<void> {
    const moduleDir = join(getSkillsRootDir(), '.build', skill, hash, 'module');
    await mkdir(moduleDir, { recursive: true });
    const zodUrl = pathToFileURL(resolve('node_modules/zod/index.js')).href;
    await writeFile(join(moduleDir, 'skill.js'), `import { z } from ${JSON.stringify(zodUrl)};
globalThis.__piskiePilotStartupImports = [
  ...(globalThis.__piskiePilotStartupImports ?? []),
  ${JSON.stringify(skill)},
];
export default {
  name: ${JSON.stringify(skill)},
  domain: 'browser',
  functions: {
    run: {
      description: ${JSON.stringify(text)},
      params: z.object({}),
      async run() { return { ok: true, text: ${JSON.stringify(text)} }; },
    },
  },
};
`, 'utf8');
    await writeFile(join(moduleDir, 'SKILL.md'), [
      '---',
      `name: ${skill}`,
      'type: browser',
      'version: "1.0.0"',
      `description: ${text}`,
      '---',
      '',
      `# ${skill}`,
      '',
    ].join('\n'), 'utf8');
  }

  async function pointCurrent(skill: string, hash: string): Promise<void> {
    const installedDir = join(browserDir, skill);
    await mkdir(installedDir, { recursive: true });
    await writeFile(join(installedDir, 'current'), `${hash}\n`, 'utf8');
  }

  function metadata(
    name: string,
    options: { enabled: boolean; executionType: 'executable' | 'guide-only' },
  ): SkillRegistryEntry {
    return {
      name,
      type: 'browser',
      version: '1.0.0',
      description: `${name} metadata`,
      path: join(browserDir, name),
      source: join(root, 'staging', name),
      sourceType: 'local',
      installedAt: '2026-07-27T00:00:00.000Z',
      enabled: options.enabled,
      executionType: options.executionType,
    };
  }

  function buildDir(skill: string, hash: string): string {
    return join(getSkillsRootDir(), '.build', skill, hash);
  }

  it('imports only enabled registry entries and prunes builds without a registry owner', async () => {
    await writeBuild('enabled-exec', HASH_OLD, 'old');
    await writeBuild('enabled-exec', HASH_CURRENT, 'current');
    await writeBuild('disabled-exec', HASH_CURRENT, 'disabled');
    await writeBuild('orphan-exec', HASH_CURRENT, 'orphan');
    await pointCurrent('enabled-exec', HASH_CURRENT);
    await pointCurrent('disabled-exec', HASH_CURRENT);
    await pointCurrent('orphan-exec', HASH_CURRENT);

    for (const skill of [
      'standard-skill',
      'disabled-standard',
      'unregistered-standard',
      'missing-current-exec',
    ]) {
      await writeDocs(skill);
    }

    const browserMetadata = [
      metadata('enabled-exec', { enabled: true, executionType: 'executable' }),
      metadata('disabled-exec', { enabled: false, executionType: 'executable' }),
      metadata('standard-skill', { enabled: true, executionType: 'guide-only' }),
      metadata('disabled-standard', { enabled: false, executionType: 'guide-only' }),
      metadata('missing-current-exec', { enabled: true, executionType: 'executable' }),
    ];
    await updateRegistry(getSkillsRootDir(), (draft) => {
      for (const entry of browserMetadata) draft.skills[entry.name] = entry;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    runtime = new PilotRuntime();
    await runtime.initialize();

    expect(startupGlobals.__piskiePilotStartupImports).toEqual(['enabled-exec']);
    expect(runtime.getSkillModule('enabled-exec')?.functions.run.description).toBe('current');
    expect(runtime.getAvailableSkill('standard-skill')?.mode).toBe('doc-only');
    expect(runtime.getAvailableSkill('disabled-exec')).toBeUndefined();
    expect(runtime.getAvailableSkill('disabled-standard')).toBeUndefined();
    expect(runtime.getAvailableSkill('orphan-exec')).toBeUndefined();
    expect(runtime.getAvailableSkill('unregistered-standard')).toBeUndefined();
    expect(runtime.getAvailableSkill('missing-current-exec')).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Skipped installed Skill missing-current-exec'),
    );

    await expect(access(buildDir('enabled-exec', HASH_OLD))).rejects.toThrow();
    await expect(access(buildDir('enabled-exec', HASH_CURRENT))).resolves.toBeUndefined();
    await expect(access(buildDir('disabled-exec', HASH_CURRENT))).resolves.toBeUndefined();
    await expect(access(buildDir('orphan-exec', HASH_CURRENT))).rejects.toThrow();
    await expect(readFile(join(browserDir, 'enabled-exec', 'current'), 'utf8'))
      .resolves.toBe(`${HASH_CURRENT}\n`);
  });
});
