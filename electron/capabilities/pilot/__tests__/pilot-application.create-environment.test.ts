import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigDomainRegistry } from '../../../config/core/registry.js';
import { configDomainStoragePaths } from '../../../config/core/storage-layout.js';
import { createBrowserEnvironmentsDomain } from '../../../config/domains/browser-profiles.adapter.js';
import { ConfigHost } from '../../../config/host/config-host.js';
import { BrowserEnvironmentRuntimeProjection } from '../../../services/browser-environment-runtime-projection.js';
import * as identifiers from '../../../../shared/utils/identifiers.js';
import { PilotApplication } from '../pilot-application.js';

let root: string;

function harness() {
  const projection = new BrowserEnvironmentRuntimeProjection();
  const registry = new ConfigDomainRegistry();
  registry.register(createBrowserEnvironmentsDomain(root, {
    publish: (snapshot) => projection.publishConfigSnapshot(snapshot),
  }, async () => ({ revision: 0, proxies: {} })));
  const host = new ConfigHost(registry);
  const application = new PilotApplication({
    config: host,
    environments: { getEnvironment: (id: string) => projection.getEnvironment(id) },
    browser: { deleteUserDataById: vi.fn(async () => 1) },
    screens: {},
    streams: {},
    presentation: {},
  } as never);
  return { application, host, projection };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-environment-test-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('PilotApplication environment identity', () => {
  it('creates and persists short environment IDs', async () => {
    const firstRun = harness();
    await firstRun.host.initialize();
    const created = await firstRun.application.createEnvironment({ name: 'Sample' });
    const second = await firstRun.application.createEnvironment({ name: 'Another' });

    expect(created.id).toMatch(/^br-[0-9A-Za-z]{6}$/);
    expect(second.id).toMatch(/^br-[0-9A-Za-z]{6}$/);
    expect(second.id).not.toBe(created.id);
    const configFile = configDomainStoragePaths(root, 'browser-profiles').configFile;
    const stored = JSON.parse(await fs.readFile(configFile, 'utf8'));
    expect(stored.environments[created.id]).toMatchObject({ name: 'Sample' });

    const restarted = harness();
    await restarted.host.initialize();
    const reloaded = restarted.projection.getEnvironment(created.id);
    expect(reloaded?.id).toBe(created.id);
  });

  it('retries a short ID collision without overwriting an existing environment', async () => {
    vi.spyOn(identifiers, 'createCompactId')
      .mockReturnValueOnce('ABC123')
      .mockReturnValueOnce('ABC123')
      .mockReturnValueOnce('DEF456');
    const { application, host } = harness();
    await host.initialize();

    const [first, second] = await Promise.all([
      application.createEnvironment({ name: 'First' }),
      application.createEnvironment({ name: 'Second' }),
    ]);

    expect(first.id).toBe('br-ABC123');
    expect(second.id).toBe('br-DEF456');
    const stored = JSON.parse(await fs.readFile(configDomainStoragePaths(root, 'browser-profiles').configFile, 'utf8'));
    expect(stored.environments[first.id].name).toBe('First');
    expect(stored.environments[second.id].name).toBe('Second');
  });
});
