import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS } from '../../../../shared/constants/index.js';
import { effectiveShortcut } from '../../../../shared/shortcuts.js';
import type { ShortcutPlatform } from '../../../../shared/shortcuts.js';
import { configDomainStoragePaths } from '../../core/storage-layout.js';
import {
  appSettingsPersistedSchema,
  appSettingsReadSchema,
  appSettingsWriteSchema,
  createAppSettingsDomain,
} from '../app-settings.adapter.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe('app-settings shortcut adapter', () => {
  it('materializes missing shortcuts and strips unknown persisted fields at both levels', async () => {
    const missing = await fixture({
      revision: 0,
      theme: 'auto',
      language: 'en-US',
      retiredTopLevelSetting: true,
    });
    await expect(missing.domain.show()).resolves.toMatchObject({
      revision: 0,
      shortcuts: {},
    });

    const withUnknown = await fixture({
      revision: 0,
      theme: 'auto',
      language: 'en-US',
      shortcuts: {
        'agent.interruptCurrent': 'primary+shift+x',
        'retired.shortcut': 'primary+shift+y',
      },
      retiredTopLevelSetting: true,
    });
    await expect(withUnknown.domain.show()).resolves.toMatchObject({
      shortcuts: { 'agent.interruptCurrent': 'primary+shift+x' },
    });
    expect((await withUnknown.domain.show()) as object).not.toHaveProperty('retiredTopLevelSetting');
    expect((await withUnknown.domain.show()).shortcuts).not.toHaveProperty('retired.shortcut');
    expect(await fs.readFile(
      configDomainStoragePaths(withUnknown.root, 'app-settings').configFile,
      'utf8',
    )).toContain('retired.shortcut');
  });

  it('keeps runtime and write schemas strict at the root and shortcuts object', () => {
    const runtime = { revision: 0, ...DEFAULT_SETTINGS };
    expect(appSettingsReadSchema.safeParse({ ...runtime, retiredTopLevelSetting: true }).success)
      .toBe(false);
    expect(appSettingsReadSchema.safeParse({
      ...runtime,
      shortcuts: { 'retired.shortcut': 'primary+shift+y' },
    }).success).toBe(false);
    expect(appSettingsWriteSchema.safeParse({
      ...DEFAULT_SETTINGS,
      shortcuts: { 'retired.shortcut': 'primary+shift+y' },
    }).success).toBe(false);

    expect(appSettingsPersistedSchema.safeParse({
      ...runtime,
      shortcuts: { 'retired.shortcut': 'primary+shift+y' },
      retiredTopLevelSetting: true,
    })).toMatchObject({
      success: true,
      data: { shortcuts: {} },
    });
  });

  it('rejects unknown root and nested fields through Config Domain writes', async () => {
    const { domain } = await fixture();
    const root = await domain.createPlan([{
      op: 'add',
      path: '/retiredTopLevelSetting',
      value: true,
    }]);
    expect(root.validation).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ stage: 'schema' })],
    });

    const nested = await domain.createPlan([{
      op: 'add',
      path: '/shortcuts/retired.shortcut',
      value: 'primary+shift+y',
    }]);
    expect(nested.validation).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ stage: 'schema' })],
    });
  });

  it.each([
    ['invalid combo', { 'agent.interruptCurrent': 'b' }, 'MISSING_MODIFIER'],
    ['editor combo', { 'agent.interruptCurrent': 'primary+c' }, 'EDITOR_RESERVED_COMBO'],
    ['Electron combo', { 'agent.interruptCurrent': 'primary+r' }, 'ELECTRON_RESERVED_COMBO'],
    ['physical conflict', { 'console.toggleLayout': 'primary+b' }, 'PHYSICAL_CONFLICT'],
  ])('rejects %s during semantic validation', async (_name, shortcuts, code) => {
    const { domain } = await fixture();
    const plan = await domain.createPlan([{
      op: 'add',
      path: '/shortcuts',
      value: shortcuts,
    }]);

    expect(plan.validation.valid).toBe(false);
    expect(plan.validation.issues).toContainEqual(expect.objectContaining({
      stage: 'semantic',
      code: `APP_SETTINGS_SHORTCUT_${code}`,
      path: expect.stringMatching(/^\/shortcuts\//),
    }));
  });

  it('persists null disable and restores the default when an override is removed', async () => {
    const { domain } = await fixture();
    const initial = await domain.createPlan([{
      op: 'add',
      path: '/shortcuts',
      value: {
        'agent.interruptCurrent': null,
        'console.toggleLayout': 'primary+shift+l',
      },
    }]);
    expect(initial.validation).toMatchObject({ valid: true, issues: [] });
    await expect(domain.apply(initial.id, 0)).resolves.toMatchObject({ revision: 1 });

    const configured = await domain.show();
    expect(effectiveShortcut('agent.interruptCurrent', configured.shortcuts)).toBeNull();
    expect(effectiveShortcut('console.toggleLayout', configured.shortcuts))
      .toBe('primary+shift+l');

    const remove = await domain.createPlan([{
      op: 'remove',
      path: '/shortcuts/console.toggleLayout',
    }]);
    expect(remove.validation).toMatchObject({ valid: true, issues: [] });
    await expect(domain.apply(remove.id, 1)).resolves.toMatchObject({ revision: 2 });

    const restored = await domain.show();
    expect(restored.shortcuts).toEqual({ 'agent.interruptCurrent': null });
    expect(effectiveShortcut('console.toggleLayout', restored.shortcuts))
      .toBe('primary+\\');
  });

  it('rejects known invalid shortcut values in persisted data', async () => {
    await expect(fixture({
      revision: 0,
      theme: 'auto',
      language: 'en-US',
      shortcuts: { 'agent.interruptCurrent': 'primary+c' },
    })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('validates physical aliases against the injected shortcut platform', async () => {
    const darwin = await fixture(undefined, 'darwin');
    const linux = await fixture(undefined, 'linux');
    const patch = [{
      op: 'add' as const,
      path: '/shortcuts',
      value: { 'agent.interruptCurrent': 'meta+r' },
    }];

    await expect(darwin.domain.createPlan(patch)).resolves.toMatchObject({
      validation: {
        valid: false,
        issues: [expect.objectContaining({
          code: 'APP_SETTINGS_SHORTCUT_ELECTRON_RESERVED_COMBO',
        })],
      },
    });
    await expect(linux.domain.createPlan(patch)).resolves.toMatchObject({
      validation: { valid: true, issues: [] },
    });
  });
});

async function fixture(
  seed?: Record<string, unknown>,
  shortcutPlatform: ShortcutPlatform = 'linux',
): Promise<{
  root: string;
  domain: ReturnType<typeof createAppSettingsDomain>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'app-settings-shortcuts-'));
  temporaryDirectories.push(root);
  if (seed) {
    const configFile = configDomainStoragePaths(root, 'app-settings').configFile;
    await fs.mkdir(path.dirname(configFile), { recursive: true });
    await fs.writeFile(configFile, JSON.stringify(seed));
  }
  const domain = createAppSettingsDomain(root, {
    shortcutPlatform,
    resolveInitialLanguage: () => 'en-US',
    publish: vi.fn(),
  });
  await domain.prepare();
  return { root, domain };
}
