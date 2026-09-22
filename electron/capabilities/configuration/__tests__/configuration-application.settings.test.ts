import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS } from '../../../../shared/constants/index.js';
import type { ShortcutOverrides } from '../../../../shared/shortcuts.js';
import type { ConfigPatchOperation } from '../../../../shared/types/config.js';
import { applyJsonPatch } from '../../../config/core/json-patch.js';
import { ConfigDomainRegistry } from '../../../config/core/registry.js';
import { configDomainStoragePaths } from '../../../config/core/storage-layout.js';
import { createAppSettingsDomain } from '../../../config/domains/app-settings.adapter.js';
import { ConfigHost } from '../../../config/host/config-host.js';
import { ConfigurationApplication } from '../configuration-application.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe('ConfigurationApplication settings patches', () => {
  it('merges one shortcut and uses add so the first write succeeds when the field is absent', async () => {
    const { application, createPatchPlan, writable } = fixtureWithoutShortcuts();

    await expect(application.writeShortcut(
      'agent.interruptCurrent',
      'primary+shift+x',
    )).resolves.toBeUndefined();

    expect(createPatchPlan).toHaveBeenCalledWith('app-settings', [{
      op: 'add',
      path: '/shortcuts',
      value: { 'agent.interruptCurrent': 'primary+shift+x' },
    }]);
    expect(writable.current).toMatchObject({
      shortcuts: { 'agent.interruptCurrent': 'primary+shift+x' },
    });
  });

  it('merges against the latest shortcut object instead of replacing another command', async () => {
    const { application, createPatchPlan, writable } = fixtureWithoutShortcuts({
      'tool.promoteToBackground': null,
    });

    await application.writeShortcut('agent.interruptCurrent', 'primary+shift+x');

    expect(createPatchPlan).toHaveBeenCalledWith('app-settings', [{
      op: 'add',
      path: '/shortcuts',
      value: {
        'agent.interruptCurrent': 'primary+shift+x',
        'tool.promoteToBackground': null,
      },
    }]);
    expect(writable.current).toMatchObject({
      shortcuts: {
        'agent.interruptCurrent': 'primary+shift+x',
        'tool.promoteToBackground': null,
      },
    });
  });

  it('uses replace for established fields in a batch write', async () => {
    const { application, createPatchPlan } = fixtureWithoutShortcuts();

    await application.writeSettings({
      theme: 'dark',
    });

    expect(createPatchPlan).toHaveBeenCalledWith('app-settings', [
      { op: 'replace', path: '/theme', value: 'dark' },
    ]);
  });

  it('writes and rereads a legacy file without shortcuts through the real ConfigHost', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'configuration-shortcuts-'));
    temporaryDirectories.push(root);
    const configFile = configDomainStoragePaths(root, 'app-settings').configFile;
    const legacySettings = Object.fromEntries(
      Object.entries(DEFAULT_SETTINGS).filter(([key]) => key !== 'shortcuts'),
    );
    await fs.mkdir(path.dirname(configFile), { recursive: true });
    await fs.writeFile(configFile, JSON.stringify({ revision: 0, ...legacySettings }));

    const registry = new ConfigDomainRegistry();
    registry.register(createAppSettingsDomain(root, {
      shortcutPlatform: 'linux',
      resolveInitialLanguage: () => 'en-US',
      publish: vi.fn(),
    }));
    const host = new ConfigHost(registry);
    await host.prepare();
    const application = new ConfigurationApplication({
      host,
      settings: { getSettings: () => structuredClone(DEFAULT_SETTINGS) },
      developmentFeatures: false,
    });

    await Promise.all([
      application.writeShortcut('agent.interruptCurrent', 'primary+shift+x'),
      application.writeShortcut('console.toggleLayout', 'primary+shift+l'),
    ]);

    await expect(host.show('app-settings')).resolves.toMatchObject({
      revision: 2,
      shortcuts: {
        'agent.interruptCurrent': 'primary+shift+x',
        'console.toggleLayout': 'primary+shift+l',
      },
    });
    expect(JSON.parse(await fs.readFile(configFile, 'utf8'))).toMatchObject({
      revision: 2,
      shortcuts: {
        'agent.interruptCurrent': 'primary+shift+x',
        'console.toggleLayout': 'primary+shift+l',
      },
    });
  });
});

function fixtureWithoutShortcuts(shortcuts?: ShortcutOverrides): {
  application: ConfigurationApplication;
  createPatchPlan: ReturnType<typeof vi.fn>;
  writable: { current: Record<string, unknown> };
} {
  const initial = Object.fromEntries(
    Object.entries(DEFAULT_SETTINGS).filter(([key]) => key !== 'shortcuts'),
  );
  if (shortcuts) initial.shortcuts = structuredClone(shortcuts);
  const writable = { current: structuredClone(initial) };
  const show = vi.fn(async () => ({ revision: 0, ...structuredClone(writable.current) }));
  const createPatchPlan = vi.fn(async (
    _domain: string,
    patch: readonly ConfigPatchOperation[],
  ) => {
    writable.current = applyJsonPatch(writable.current, patch);
    return { id: 'plan-settings', domain: 'app-settings', baseRevision: 0 };
  });
  const host = {
    show,
    createPatchPlan,
    validate: vi.fn(async () => ({})),
    apply: vi.fn(async () => ({
      domain: 'app-settings',
      previousRevision: 0,
      revision: 1,
    })),
  } as unknown as ConfigHost;
  return {
    application: new ConfigurationApplication({
      host,
      settings: { getSettings: () => structuredClone(DEFAULT_SETTINGS) },
      developmentFeatures: false,
    }),
    createPatchPlan,
    writable,
  };
}
