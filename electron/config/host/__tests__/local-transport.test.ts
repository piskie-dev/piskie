import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLocalConfigEndpointAdapter } from '../../../transport/local/config-host-endpoint.js';
import type { ConfigCommandPort } from '../config-command-port.js';
import {
  ConfigHostUnavailableError,
  connectLocalConfigHost,
  localConfigDescriptorPath,
  LocalConfigServer,
} from '../local-transport.js';

const roots: string[] = [];
const servers: LocalConfigServer[] = [];

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.stop()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(overrides: Partial<ConfigCommandPort> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-local-config-'));
  roots.push(root);
  const host = configPort(overrides);
  const server = new LocalConfigServer({
    rootDirectory: root,
    generation: 'test-generation',
    endpointAdapter: createLocalConfigEndpointAdapter(),
    host,
  });
  servers.push(server);
  await server.start();
  return { root, host, client: await connectLocalConfigHost(root), server };
}

describe('local ConfigHost transport', () => {
  it('forwards one-shot config requests and removes its descriptor on shutdown', async () => {
    const createPlan = vi.fn(async () => ({ id: 'plan-1', domain: 'app-settings', baseRevision: 3 }));
    const { root, client, server } = await fixture({ createPlan });

    await expect(client.createPlan('app-settings', {
      descriptorHash: 'descriptor',
      changes: [],
    })).resolves.toEqual({ id: 'plan-1', domain: 'app-settings', baseRevision: 3 });
    expect(createPlan).toHaveBeenCalledWith('app-settings', {
      descriptorHash: 'descriptor',
      changes: [],
    });
    await expect(fs.stat(localConfigDescriptorPath(root))).resolves.toBeDefined();

    await server.stop();
    await expect(fs.stat(localConfigDescriptorPath(root))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(connectLocalConfigHost(root)).rejects.toBeInstanceOf(ConfigHostUnavailableError);
  });

  it('preserves stable Config error codes and details across the process boundary', async () => {
    const apply = vi.fn(async () => {
      throw Object.assign(new Error('revision changed'), {
        name: 'ConfigRepositoryError',
        code: 'CONFIG_REVISION_CONFLICT',
        details: { expectedRevision: 2, actualRevision: 3 },
      });
    });
    const { client } = await fixture({ apply });

    await expect(client.apply('plan-1', 2)).rejects.toMatchObject({
      name: 'ConfigRepositoryError',
      code: 'CONFIG_REVISION_CONFLICT',
      message: 'revision changed',
      details: { expectedRevision: 2, actualRevision: 3 },
    });
  });

  it('reports a stable unavailable error when no Electron host is running', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-local-config-missing-'));
    roots.push(root);

    await expect(connectLocalConfigHost(root)).rejects.toMatchObject({
      code: 'CONFIG_HOST_UNAVAILABLE',
    });
  });
});

function configPort(overrides: Partial<ConfigCommandPort>): ConfigCommandPort {
  return {
    domains: () => [],
    describe: () => ({
      domain: 'app-settings',
      title: 'Application settings',
      description: '',
      schemaVersion: 1,
      descriptorHash: 'descriptor',
      capabilities: [],
      readSchema: {},
      writeSchema: {},
      fields: [],
      dynamicExtensions: [],
    }),
    show: async () => ({}),
    history: async () => [],
    createPlan: async () => ({ id: 'plan', domain: 'app-settings', baseRevision: 0 }),
    validate: async () => ({}),
    probe: async () => ({}),
    apply: async () => ({ domain: 'app-settings', previousRevision: 0, revision: 1 }),
    verify: async () => ({ domain: 'app-settings', healthy: true, issues: [] }),
    rollback: async () => ({ domain: 'app-settings', previousRevision: 1, revision: 2 }),
    ...overrides,
  };
}
