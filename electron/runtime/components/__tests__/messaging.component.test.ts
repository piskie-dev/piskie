import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => {
  const fsSync = await import('node:fs');
  const osModule = await import('node:os');
  const pathModule = await import('node:path');
  const directory = fsSync.mkdtempSync(pathModule.join(osModule.tmpdir(), 'messaging-startup-'));
  return {
    app: { getPath: () => directory },
    powerSaveBlocker: { start: () => 1, stop: () => undefined },
  };
});
vi.mock('../../../core/storage/index.js', () => ({
  taskDefinitionStore: { get: (id: string) => ({ definitionId: id, purpose: 'messaging' }) },
}));
vi.mock('../../../im-gateway/channels/index.js', () => ({
  registerBuiltinChannels: vi.fn(),
  BUILTIN_CHANNEL_INFOS: [],
}));
vi.mock('../../../observability/logging/app-log.js', () => ({
  appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { app } from 'electron';
import type { MessagingConnectionConfig } from '../../../../shared/types/im-gateway.js';
import { createAgentObservations } from '../../../agent/observations.js';
import { ConfigDomainRegistry } from '../../../config/core/registry.js';
import { configDomainStoragePaths } from '../../../config/core/storage-layout.js';
import { createImBotsDomain } from '../../../config/domains/im-bots.adapter.js';
import { ConfigHost } from '../../../config/host/config-host.js';
import { IMGateway } from '../../../im-gateway/index.js';
import { AccountSessionStore } from '../../../im-gateway/account-session-store.js';
import { registerBuiltinChannels } from '../../../im-gateway/channels/index.js';
import { channelRegistry } from '../../../im-gateway/core/registry.js';
import { appLog } from '../../../observability/logging/app-log.js';
import { ResourceLedger } from '../../lifecycle/resource-ledger.js';
import { ResourceScope } from '../../lifecycle/resource-scope.js';
import { createMessagingComponent } from '../messaging.component.js';

const scopes: ResourceScope[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const scope of scopes.splice(0)) await scope.close('test-complete');
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
afterAll(async () => { await fs.rm(app.getPath('userData'), { recursive: true, force: true }); });

function bot(id: string, autoStart?: boolean): MessagingConnectionConfig {
  return { id, name: id, channelType: 'openclaw-weixin', definitionId: `template-${id}`,
    ...(autoStart !== undefined && { autoStart }) };
}

async function fixture(configs: MessagingConnectionConfig[]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'messaging-config-'));
  directories.push(directory);
  const configFile = configDomainStoragePaths(directory, 'im-bots').configFile;
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  await fs.writeFile(configFile, JSON.stringify({ revision: 1, bots: Object.fromEntries(configs.map(({ id, ...config }) => [id, config])) }));
  const gateway = new IMGateway();
  const registry = new ConfigDomainRegistry();
  registry.register(createImBotsDomain(directory, {
    validate: (snapshot) => gateway.validateConfigSnapshot(snapshot),
    publish: (snapshot) => gateway.publishConfigSnapshot(snapshot),
  }, async () => ({ revision: 1 })));
  const config = new ConfigHost(registry);
  await config.initialize();
  const observations = createAgentObservations();
  const agentService = { observations: observations.source };
  const inject = vi.spyOn(gateway, 'injectDependencies');
  const component = createMessagingComponent({ gateway, agentService: agentService as never,
    inference: { bindings: { inferenceHost: { configHost: config } } as never } });
  const scope = new ResourceScope('test-generation', 'component:messaging', new ResourceLedger('test-generation'));
  scopes.push(scope);
  const start = () => component.start({ generation: 'test-generation', startedAt: Date.now(), signal: new AbortController().signal }, scope);
  const create = vi.spyOn(channelRegistry, 'create').mockImplementation((connection) => ({
    id: connection.channelType,
    start: ({ signal }) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
  }));
  return { gateway, component, config, inject, create, start };
}

describe('messaging startup', () => {
  it('starts only opted-in Bots after config, channels, sessions and message dependencies are ready', async () => {
    const sessions = new AccountSessionStore(path.join(app.getPath('userData'), 'runtime-state', 'im-account-sessions.json'));
    sessions.set('enabled-bot', 'example-account');
    const f = await fixture([bot('enabled-bot', true), bot('disabled-bot', false), bot('legacy-bot')]);
    expect(f.create).not.toHaveBeenCalled();
    expect(f.gateway.getBotConfigs().find((config) => config.id === 'legacy-bot')?.autoStart).toBe(false);
    const readyAtConnect: unknown[] = [];
    f.create.mockImplementation((connection) => {
      readyAtConnect.push({
        initialized: f.gateway.lifecycleSnapshot().initialized,
        observations: f.gateway.lifecycleSnapshot().observationBindingCount,
        channelsRegistered: vi.mocked(registerBuiltinChannels).mock.calls.length,
        config: f.inject.mock.calls.at(-1)?.[0].config,
        account: connection.pluginAccountId,
      });
      return { id: connection.channelType,
        start: ({ signal }) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })) };
    });
    expect(f.component.dependsOn).toEqual(['agent']);
    await expect(f.start()).resolves.toBe(f.gateway);
    expect(f.create.mock.calls.map(([config]) => config.id)).toEqual(['enabled-bot']);
    expect(readyAtConnect).toEqual([{ initialized: true, observations: 3, channelsRegistered: 1, config: f.config, account: 'example-account' }]);
    expect(f.gateway.getBotStates().map(({ config, status }) => [config.id, status])).toEqual([
      ['enabled-bot', 'running'], ['disabled-bot', 'stopped'], ['legacy-bot', 'stopped'],
    ]);
    // Publishing a later save does not start newly opted-in Bots or stop running ones.
    await f.gateway.publishConfigSnapshot([bot('enabled-bot', false), bot('disabled-bot', true), bot('legacy-bot')]);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.gateway.lifecycleSnapshot().activeBotIds).toEqual(['enabled-bot']);
    await f.gateway.stopBot('enabled-bot');
    expect(f.gateway.lifecycleSnapshot().activeBotIds).toEqual([]);
  });

  it('isolates invalid bindings and connector failures while other Bots and startup succeed', async () => {
    const f = await fixture([
      { ...bot('unbound-bot', true), definitionId: undefined },
      bot('failed-bot', true), bot('working-bot', true),
    ]);
    f.create.mockImplementation((config) => {
      if (config.id === 'failed-bot') throw new Error('Example connector failed');
      return { id: config.channelType,
        start: ({ signal }) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })) };
    });
    const statusChanged = vi.fn();
    f.gateway.statusChanges.subscribe(statusChanged);
    await expect(f.start()).resolves.toBe(f.gateway);
    expect(f.create.mock.calls.map(([config]) => config.id)).toEqual(['failed-bot', 'working-bot']);
    expect(f.gateway.getBotStates()).toMatchObject([
      { config: { id: 'unbound-bot' }, status: 'error', error: expect.stringContaining('task_definition_unavailable') },
      { config: { id: 'failed-bot' }, status: 'error', error: 'Example connector failed' },
      { config: { id: 'working-bot' }, status: 'running' },
    ]);
    expect(statusChanged).toHaveBeenCalledWith(expect.objectContaining({ botId: 'failed-bot', state: expect.objectContaining({ status: 'error' }) }));
    expect(appLog.warn).toHaveBeenCalledTimes(2);
    expect(appLog.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'messaging.connector.auto_start.failed', context: expect.objectContaining({ botId: 'failed-bot' }),
      error: expect.objectContaining({ message: 'Example connector failed' }),
    }));
  });
});
