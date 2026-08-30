import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ConfigPatchOperation,
  ConfigPlan,
} from '../../../../shared/types/config.js';
import type { AppSettings } from '../../../../shared/types/index.js';
import type { MessagingConnectionConfig } from '../../../../shared/types/im-gateway.js';
import { InferenceControlPlane } from '../../../inference/control/control-plane.js';
import {
  InferenceConfigRepository,
  inferenceConfigPaths,
} from '../../../inference/control/config-repository.js';
import { InferenceSelectionStore } from '../../../inference/control/selection-store.js';
import { runConfigCli } from '../../../inference/config-cli/main.js';
import { createFakeDriver } from '../../../inference/control/__tests__/fake-driver.js';
import {
  testConfig,
  testModel,
} from '../../../inference/control/__tests__/fixtures.js';
import { DriverRegistry } from '../../../inference/drivers/registry.js';
import { createLocalConfigEndpointAdapter } from '../../../transport/local/config-host-endpoint.js';
import type { ConfigDomainIntegrations } from '../integrations.js';
import { createConfigHost } from '../../host/composition.js';
import type { ConfigHost } from '../../host/config-host.js';
import {
  connectLocalConfigHost,
  LocalConfigServer,
} from '../../host/local-transport.js';
import { configDomainStoragePaths } from '../../core/storage-layout.js';

const temporaryDirectories: string[] = [];
const DEFINITION_A_ID = 'td-AAAAAA';
const DEFINITION_B_ID = 'td-BBBBBB';
const GENERAL_DEFINITION_ID = 'td-GENERAL';

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

interface DomainFixture {
  root: string;
  host: ConfigHost;
  control: InferenceControlPlane;
  runningBots: Set<string>;
  runningEnvironments: Set<string>;
  publications: Array<{ domain: string; source: string }>;
}

async function fixture(
  seed?: (root: string) => Promise<void>,
  initialLanguage: AppSettings['language'] = 'en-US',
): Promise<DomainFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-all-domains-'));
  temporaryDirectories.push(root);
  await fs.mkdir(path.join(root, 'catalog'), { recursive: true });
  await fs.mkdir(path.join(root, 'config'), { recursive: true });
  await seed?.(root);
  await fs.writeFile(path.join(root, 'catalog', 'models.json'), JSON.stringify({
    version: 'base-1',
    models: [testModel()],
  }));
  const modelCatalogPath = path.join(root, 'config', 'model-catalog.json');
  try {
    await fs.access(modelCatalogPath);
  } catch {
    await fs.writeFile(modelCatalogPath, JSON.stringify({
      version: 'local:0',
      revision: 0,
      models: [],
    }));
  }

  const paths = inferenceConfigPaths(root);
  const repository = new InferenceConfigRepository(paths);
  await repository.initialize(testConfig());
  const drivers = new DriverRegistry();
  drivers.register(createFakeDriver());
  const control = new InferenceControlPlane({
    repository,
    drivers,
    publisher: 'cli',
    now: () => new Date('2026-08-05T08:00:00.000Z'),
  });
  const selections = new InferenceSelectionStore(paths);
  const runningBots = new Set<string>();
  const runningEnvironments = new Set<string>();
  const publications: Array<{ domain: string; source: string }> = [];
  let botConfigs: MessagingConnectionConfig[] = [];

  const integrations: ConfigDomainIntegrations = {
    appSettings: {
      resolveInitialLanguage: () => initialLanguage,
      publish: (_settings, context) => publications.push({ domain: context.domain, source: context.source }),
    },
    proxies: {
      publish: (_config, context) => publications.push({ domain: context.domain, source: context.source }),
    },
    taskDefinitions: {
      publish: (_definitions, _removed, context) => publications.push({ domain: context.domain, source: context.source }),
    },
    browserEnvironments: {
      publish: (_snapshot, context) => publications.push({ domain: context.domain, source: context.source }),
      observe: (snapshot) => ({
        ...snapshot,
        environments: snapshot.environments.map((environment) => ({
          ...environment,
          status: runningEnvironments.has(environment.id) ? 'running' as const : 'idle' as const,
        })),
      }),
      environmentInUse: (environmentId) => runningEnvironments.has(environmentId),
    },
    imBots: {
      validate: (candidate) => {
        const current = new Map(botConfigs.map((bot) => [bot.id, bot]));
        for (const bot of candidate) {
          const previous = current.get(bot.id);
          if (
            previous
            && previous.definitionId !== bot.definitionId
            && runningBots.has(bot.id)
          ) {
            throw new Error(
              'task_definition_locked: stop the Bot before rebinding its Task Definition',
            );
          }
        }
      },
      publish: (candidate, context) => {
        botConfigs = structuredClone([...candidate]);
        publications.push({ domain: context.domain, source: context.source });
      },
      observe: (configs) => configs.map((config) => ({
        config,
        status: runningBots.has(config.id) ? 'running' as const : 'stopped' as const,
      })),
    },
    mcp: {
      publish: (_snapshot, context) => publications.push({ domain: context.domain, source: context.source }),
    },
  };
  const host = createConfigHost({
    rootDirectory: root,
    inference: control,
    selections,
    integrations,
  });
  await host.initialize();
  return { root, host, control, runningBots, runningEnvironments, publications };
}

async function validPlan(
  host: ConfigHost,
  domain: string,
  patch: readonly ConfigPatchOperation[],
): Promise<ConfigPlan> {
  const created = await host.createPatchPlan<ConfigPlan>(domain, patch);
  expect(created.validation, `${domain} createPlan validation`).toMatchObject({ valid: true, issues: [] });
  const validated = await host.validate<ConfigPlan>(created.id);
  expect(validated.validation, `${domain} final validation`).toMatchObject({ valid: true, issues: [] });
  return validated;
}

async function applyPlan(
  host: ConfigHost,
  domain: string,
  patch: readonly ConfigPatchOperation[],
  expectedRevision: number,
): Promise<ConfigPlan> {
  const plan = await validPlan(host, domain, patch);
  await expect(host.apply(plan.id, expectedRevision)).resolves.toMatchObject({
    domain,
    previousRevision: expectedRevision,
    revision: expectedRevision + 1,
  });
  return plan;
}

describe('all managed Config Domains', () => {
  it('uses the system-derived language only when creating app settings', async () => {
    const fresh = await fixture(undefined, 'zh-CN');
    await expect(fresh.host.show('app-settings')).resolves.toMatchObject({
      revision: 0,
      language: 'zh-CN',
    });

    const existing = await fixture(async (root) => {
      await fs.writeFile(
        configDomainStoragePaths(root, 'app-settings').configFile,
        JSON.stringify({ revision: 0, theme: 'auto', language: 'en-US' }),
      );
    }, 'zh-CN');
    await expect(existing.host.show('app-settings')).resolves.toMatchObject({
      revision: 0,
      language: 'en-US',
    });
  });

  it('loads an incomplete model record and applies write-strict validation only when that record is written', async () => {
    const { host } = await fixture(async (root) => {
      await fs.writeFile(path.join(root, 'config', 'model-catalog.json'), JSON.stringify({
        version: 'local:0',
        revision: 0,
        models: [testModel({
          id: 'custom/incomplete',
          limits: {},
          source: { kind: 'local', version: 'local:0' },
        })],
      }));
    });

    await expect(host.show('model-catalog')).resolves.toMatchObject({
      models: { 'custom/incomplete': { kind: 'ai', limits: {} } },
    });

    const sibling = await host.createPatchPlan<ConfigPlan>('model-catalog', [{
      op: 'add',
      path: '/models/custom~1complete',
      value: {
        displayName: 'Complete',
        kind: 'ai',
        lifecycle: 'active',
        compatibleDrivers: ['fake'],
        inputModalities: ['text'],
        outputModalities: ['text'],
        capabilities: { streaming: true },
        limits: { contextWindow: 50_000 },
      },
    }]);
    expect(sibling.validation.valid).toBe(true);

    const invalidRewrite = await host.createPatchPlan<ConfigPlan>('model-catalog', [{
      op: 'replace',
      path: '/models/custom~1incomplete',
      value: {
        displayName: 'Still incomplete',
        kind: 'ai',
        lifecycle: 'active',
        compatibleDrivers: ['fake'],
        inputModalities: ['text'],
        outputModalities: ['text'],
        capabilities: { streaming: true },
        limits: {},
      },
    }]);
    expect(invalidRewrite.validation).toMatchObject({
      valid: false,
      issues: [{ path: '/models/custom~1incomplete/limits/contextWindow' }],
    });

    const remove = await host.createPatchPlan<ConfigPlan>('model-catalog', [{
      op: 'remove', path: '/models/custom~1incomplete',
    }]);
    expect(remove.validation.valid).toBe(true);
  });

  it('auto-generates descriptor-bound mutations for every registered Domain', async () => {
    const { host } = await fixture();
    for (const domain of host.domains()) {
      const descriptor = host.describe(domain.id);
      const ids = descriptor.fields.map((field) => field.fieldId);
      expect(new Set(ids).size, domain.id).toBe(ids.length);
      for (const field of descriptor.fields) {
        expect(field.fieldId, `${domain.id}:${field.pathTemplate}`)
          .toMatch(/^field_[a-f0-9]{24}$/);
        const placeholders = [...field.pathTemplate.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)]
          .map((match) => match[1]);
        expect(field.bindings.map((binding) => binding.name), field.pathTemplate)
          .toEqual(placeholders);
      }
    }

    const definitionsDescriptor = host.describe('task-definitions');
    const definitionEntry = definitionsDescriptor.fields.find(
      (field) => field.pathTemplate === '/definitions/{definitionId}',
    )!;
    const definitionPlan = await host.createPlan<ConfigPlan>('task-definitions', {
      descriptorHash: definitionsDescriptor.descriptorHash,
      changes: [{
        op: 'set',
        fieldId: definitionEntry.fieldId,
        bindings: { definitionId: DEFINITION_A_ID },
        value: {
          name: 'Reusable task',
          description: 'A reusable task definition.',
          purpose: 'general',
          promptTemplate: 'Run the task.',
        },
      }],
    });
    expect(definitionPlan.validation).toMatchObject({ valid: true, issues: [] });

    const descriptor = host.describe('app-settings');
    const theme = descriptor.fields.find((field) => field.pathTemplate === '/theme')!;
    const plan = await host.createPlan<ConfigPlan>('app-settings', {
      descriptorHash: descriptor.descriptorHash,
      changes: [{ op: 'set', fieldId: theme.fieldId, value: 'dark' }],
    });
    expect(plan.patch).toEqual([{ op: 'add', path: '/theme', value: 'dark' }]);
    await expect(host.apply(plan.id, 0)).resolves.toMatchObject({ revision: 1 });
    await expect(host.show('app-settings')).resolves.toMatchObject({ theme: 'dark' });
  });

  it('uses a clean break: old files and unknown persisted fields are ignored without rewriting them', async () => {
    const { root, host } = await fixture(async (directory) => {
      await fs.writeFile(path.join(directory, 'config', 'gateway.json'), JSON.stringify({
        proxyGateway: {
          proxies: [{
            id: 'old-proxy',
            name: 'Old proxy',
            protocol: 'http',
            host: '127.0.0.1',
            port: 8080,
            enabled: true,
          }],
        },
      }));
      await fs.mkdir(path.join(directory, 'im-gateway'), { recursive: true });
      await fs.writeFile(path.join(directory, 'im-gateway', 'bots.json'), JSON.stringify([{
        id: 'old-bot',
        channelType: 'feishu',
        name: 'Old bot',
        bindFlowId: 'old-flow',
      }]));
    });

    await expect(host.show('proxies')).resolves.toMatchObject({ revision: 0, proxies: {} });
    await expect(host.show('im-bots')).resolves.toMatchObject({ revision: 0, bots: {} });

    await fs.writeFile(
      configDomainStoragePaths(root, 'app-settings').configFile,
      JSON.stringify({ revision: 0, theme: 'auto', language: 'zh-CN', deprecatedTheme: 'system' }),
    );
    await expect(host.show('app-settings')).resolves.toEqual({
      revision: 0,
      theme: 'auto',
      language: 'zh-CN',
      navEdgeDockEnabled: true,
      navPrismEnabled: true,
      navPrismSpot: null,
      backgroundImage: null,
      backgroundMaskOpacity: 0.65,
    });
    expect(await fs.readFile(
      configDomainStoragePaths(root, 'app-settings').configFile,
      'utf8',
    )).toContain('deprecatedTheme');

    await fs.writeFile(
      configDomainStoragePaths(root, 'browser-profiles').configFile,
      JSON.stringify({
        revision: 0,
        ignoredBrowserRoot: true,
        environments: {
          environmentA: {
            name: 'Environment A',
            createdAt: 1,
            ignoredEnvironmentField: true,
            identityPolicy: {
              ignoredIdentityField: true,
              timezone: { mode: 'ip', ignoredTimezoneField: true },
              geolocation: { mode: 'off', ignoredGeolocationField: true },
              language: { mode: 'custom', value: 'en-US', ignoredLanguageField: true },
            },
          },
        },
        groups: {},
      }),
    );
    await expect(host.show('browser-profiles')).resolves.toMatchObject({
      revision: 0,
      environments: {
        environmentA: {
          name: 'Environment A',
          status: 'idle',
          identityPolicy: {
            timezone: { mode: 'ip' },
            geolocation: { mode: 'off' },
            language: { mode: 'custom', value: 'en-US' },
          },
        },
      },
    });
    expect(await fs.readFile(
      configDomainStoragePaths(root, 'browser-profiles').configFile,
      'utf8',
    )).toContain('ignoredTimezoneField');

    await fs.writeFile(
      configDomainStoragePaths(root, 'task-definitions').configFile,
      JSON.stringify({
        revision: 0,
        ignoredDefinitionsRoot: true,
        definitions: {
          [DEFINITION_A_ID]: {
            name: 'Task A',
            description: 'Unknown persisted fields are ignored.',
            promptTemplate: 'Run A.',
            defaultModeId: 'normal',
            defaultApprovalMode: 'confirm',
            createdAt: '2026-08-11T00:00:00.000Z',
            ignoredDefinitionField: true,
          },
        },
      }),
    );
    await expect(host.show('task-definitions')).resolves.toMatchObject({
      revision: 0,
      definitions: {
        [DEFINITION_A_ID]: { name: 'Task A', purpose: 'general', defaultModeId: 'normal' },
      },
    });
    expect(await fs.readFile(
      configDomainStoragePaths(root, 'task-definitions').configFile,
      'utf8',
    )).toContain('ignoredDefinitionField');

    await fs.writeFile(
      configDomainStoragePaths(root, 'proxies').configFile,
      JSON.stringify({
        revision: 0,
        ignoredProxyRoot: true,
        proxies: {
          proxyA: {
            name: 'Proxy A',
            protocol: 'http',
            host: '127.0.0.1',
            port: 8080,
            enabled: true,
            ignoredProxyField: true,
          },
        },
      }),
    );
    await expect(host.show('proxies')).resolves.toMatchObject({
      revision: 0,
      proxies: { proxyA: { name: 'Proxy A', enabled: true } },
    });
    expect(await fs.readFile(
      configDomainStoragePaths(root, 'proxies').configFile,
      'utf8',
    )).toContain('ignoredProxyField');

    await fs.writeFile(
      configDomainStoragePaths(root, 'app-settings').configFile,
      JSON.stringify({ revision: 0, theme: 'removed-theme', language: 'zh-CN' }),
    );
    await expect(host.show('app-settings')).rejects.toMatchObject({ code: 'CONFIG_INVALID' });

    await fs.writeFile(
      configDomainStoragePaths(root, 'app-settings').configFile,
      JSON.stringify({
        revision: 0,
        theme: 'auto',
        language: 'zh-CN',
        navEdgeDockEnabled: false,
        navPrismEnabled: false,
      }),
    );
    await expect(host.show('app-settings')).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('validates app navigation and managed background preferences', async () => {
    const { host } = await fixture();
    const noNavigation = await host.createPatchPlan<ConfigPlan>('app-settings', [
      { op: 'replace', path: '/navEdgeDockEnabled', value: false },
      { op: 'replace', path: '/navPrismEnabled', value: false },
    ]);
    expect(noNavigation.validation).toMatchObject({
      valid: false,
      issues: [{ code: 'APP_SETTINGS_NAVIGATION_REQUIRED' }],
    });

    for (const value of [0.01, 0.99]) {
      const boundary = await host.createPatchPlan<ConfigPlan>('app-settings', [
        { op: 'replace', path: '/backgroundMaskOpacity', value },
      ]);
      expect(boundary.validation.valid).toBe(true);
    }

    for (const patch of [
      [{ op: 'replace' as const, path: '/backgroundMaskOpacity', value: 0 }],
      [{ op: 'replace' as const, path: '/backgroundMaskOpacity', value: 1 }],
      [{ op: 'replace' as const, path: '/backgroundImage', value: 'https://example.test/wall.png' }],
    ]) {
      const invalid = await host.createPatchPlan<ConfigPlan>('app-settings', patch);
      expect(invalid.validation.valid).toBe(false);
      expect(invalid.validation.issues).toContainEqual(expect.objectContaining({
        stage: 'schema',
      }));
    }

    await applyPlan(host, 'app-settings', [
      { op: 'replace', path: '/navEdgeDockEnabled', value: false },
      { op: 'replace', path: '/navPrismSpot', value: { x: 120, y: 240 } },
      {
        op: 'replace',
        path: '/backgroundImage',
        value: 'piskie-attachment://theme-background/background-1.webp',
      },
      { op: 'replace', path: '/backgroundMaskOpacity', value: 0.99 },
    ], 0);
    await expect(host.show('app-settings')).resolves.toMatchObject({
      revision: 1,
      navEdgeDockEnabled: false,
      navPrismEnabled: true,
      navPrismSpot: { x: 120, y: 240 },
      backgroundImage: 'piskie-attachment://theme-background/background-1.webp',
      backgroundMaskOpacity: 0.99,
    });
  });

  it('reads an IM Bot with unknown persisted keys and writes only the current contract after save', async () => {
    let originalSource = '';
    const { root, host } = await fixture(async (directory) => {
      originalSource = JSON.stringify({
        revision: 3,
        bots: {
          'bot-existing': {
            channelType: 'openclaw-weixin',
            name: 'Existing Bot',
            bindFlowId: 'retired-flow-id',
            replyForward: {
              forwardThinking: false,
              forwardToolCalls: true,
              forwardToolResults: false,
            },
          },
        },
      });
      await fs.writeFile(
        configDomainStoragePaths(directory, 'im-bots').configFile,
        originalSource,
      );
    });

    await expect(host.show('im-bots')).resolves.toMatchObject({
      revision: 3,
      bots: {
        'bot-existing': {
          replyForward: {
            forwardAssistantText: true,
            forwardToolCalls: true,
            forwardToolResults: false,
          },
          status: 'stopped',
        },
      },
    });

    const configFile = configDomainStoragePaths(root, 'im-bots').configFile;
    expect(await fs.readFile(configFile, 'utf8')).toBe(originalSource);

    await applyPlan(host, 'im-bots', [{
      op: 'replace',
      path: '/bots/bot-existing/replyForward',
      value: {
        forwardAssistantText: true,
        forwardToolCalls: true,
        forwardToolResults: false,
      },
    }], 3);

    const saved = JSON.parse(await fs.readFile(configFile, 'utf8')) as {
      bots: Record<string, { replyForward: Record<string, unknown> }>;
    };
    expect(saved.bots['bot-existing']?.replyForward).toEqual({
      forwardAssistantText: true,
      forwardToolCalls: true,
      forwardToolResults: false,
    });
  });

  it('uses one Plan/apply/history/rollback transaction shape for all nine Domains', async () => {
    const { root, host, control, publications } = await fixture();
    expect(host.domains().map((domain) => domain.id)).toEqual([
      'app-settings',
      'browser-profiles',
      'im-bots',
      'inference',
      'inference-selections',
      'mcp',
      'model-catalog',
      'proxies',
      'task-definitions',
    ]);

    await applyPlan(host, 'app-settings', [{ op: 'replace', path: '/theme', value: 'dark' }], 0);
    await expect(host.show('app-settings')).resolves.toMatchObject({ revision: 1, theme: 'dark' });
    await expect(host.rollback('app-settings', 0)).resolves.toMatchObject({ revision: 2 });

    const proxyPlan = await applyPlan(host, 'proxies', [{
      op: 'add',
      path: '/proxies/proxy-a',
      value: {
        name: 'Proxy A',
        protocol: 'http',
        host: '127.0.0.1',
        port: 8080,
        password: 'global-proxy-secret',
        enabled: true,
      },
    }], 0);
    expect(JSON.stringify(proxyPlan)).toContain('global-proxy-secret');
    await expect(host.show('proxies')).resolves.toMatchObject({
      revision: 1,
      proxies: { 'proxy-a': { name: 'Proxy A', password: 'global-proxy-secret' } },
    });
    expect((await host.show<{ proxies: Record<string, unknown> }>('proxies')).proxies['proxy-a'])
      .toHaveProperty('password', 'global-proxy-secret');
    const browserPlan = await applyPlan(host, 'browser-profiles', [
      { op: 'add', path: '/groups/team', value: { name: 'Team' } },
      {
        op: 'add',
        path: '/environments/environment-a',
        value: {
          name: 'Environment A',
          groupId: 'team',
          identityPolicy: {
            timezone: { mode: 'ip' },
            geolocation: { mode: 'ip' },
            language: { mode: 'ip' },
          },
          proxyId: 'proxy-a',
        },
      },
    ], 0);
    const browser = await host.show<{
      revision: number;
      environments: Record<string, unknown>;
    }>('browser-profiles');
    expect(browser).toMatchObject({
      revision: 1,
      environments: { 'environment-a': { name: 'Environment A', status: 'idle', proxyId: 'proxy-a' } },
    });
    const browserFile = await fs.readFile(
      configDomainStoragePaths(root, 'browser-profiles').configFile,
      'utf8',
    );
    expect(browserFile).not.toContain('global-proxy-secret');
    expect(browserFile).not.toContain('enc:v');
    const storedBrowserPlan = await fs.readFile(path.join(
      configDomainStoragePaths(root, 'browser-profiles').plansDirectory,
      `${browserPlan.id}.json`,
    ), 'utf8');
    expect(storedBrowserPlan).not.toContain('global-proxy-secret');
    await expect(host.rollback('browser-profiles', 0)).resolves.toMatchObject({ revision: 2 });
    await expect(host.rollback('proxies', 0)).resolves.toMatchObject({ revision: 2 });

    const inferencePlan = await applyPlan(host, 'inference', [{
      op: 'replace', path: '/policies/ai/maxAttempts', value: 4,
    }], 0);
    expect(JSON.stringify(inferencePlan)).toContain('sk-plaintext-secret');
    expect(JSON.stringify(inferencePlan)).toContain('plain-header-secret');
    expect(control.runtime.capture()?.configRevision).toBe(1);
    await expect(host.rollback('inference', 0)).resolves.toMatchObject({ revision: 2 });
    expect(control.runtime.capture()?.configRevision).toBe(2);

    await applyPlan(host, 'inference-selections', [{
      op: 'add', path: '/ai', value: { providerId: 'primary', modelId: 'chat' },
    }], 0);
    await expect(host.show('inference-selections')).resolves.toMatchObject({
      revision: 1,
      ai: { providerId: 'primary', modelId: 'chat' },
    });
    await expect(host.rollback('inference-selections', 0)).resolves.toMatchObject({ revision: 2 });

    await applyPlan(host, 'mcp', [{
      op: 'add',
      path: '/mcpServers/context7',
      value: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
    }], 0);
    await expect(host.show('mcp')).resolves.toMatchObject({
      revision: 1,
      mcpServers: { context7: { command: 'npx' } },
    });
    await expect(host.rollback('mcp', 0)).resolves.toMatchObject({ revision: 2 });

    await applyPlan(host, 'model-catalog', [{
      op: 'add',
      path: '/models/custom~1local',
      value: {
        displayName: 'Local Chat',
        kind: 'ai',
        lifecycle: 'active',
        compatibleDrivers: ['fake'],
        inputModalities: ['text'],
        outputModalities: ['text'],
        capabilities: { streaming: true, tools: true },
        limits: { contextWindow: 50_000 },
      },
    }], 0);
    await expect(host.show('model-catalog')).resolves.toMatchObject({
      revision: 1,
      models: { 'custom/local': { displayName: 'Local Chat' } },
    });
    await expect(host.rollback('model-catalog', 0)).resolves.toMatchObject({ revision: 2 });

    await applyPlan(host, 'task-definitions', [{
      op: 'add',
      path: `/definitions/${DEFINITION_A_ID}`,
      value: {
        name: 'Task A',
        description: 'Test Task Definition',
        purpose: 'messaging',
        promptTemplate: 'Run the task.',
      },
    }], 0);
    await expect(host.show('task-definitions')).resolves.toMatchObject({
      revision: 1,
      definitions: { [DEFINITION_A_ID]: { name: 'Task A' } },
    });
    const botPlan = await applyPlan(host, 'im-bots', [{
      op: 'add',
      path: '/bots/bot-a',
      value: {
        channelType: 'feishu',
        name: 'Bot A',
        definitionId: DEFINITION_A_ID,
        appId: 'app-a',
        appSecret: 'im-bot-secret',
      },
    }], 0);
    expect(JSON.stringify(botPlan)).toContain('im-bot-secret');
    await expect(host.show('im-bots')).resolves.toMatchObject({
      revision: 1,
      bots: { 'bot-a': { name: 'Bot A', appSecret: 'im-bot-secret', status: 'stopped' } },
    });
    await expect(host.rollback('im-bots', 0)).resolves.toMatchObject({ revision: 2 });
    await expect(host.rollback('task-definitions', 0)).resolves.toMatchObject({ revision: 2 });

    for (const domain of host.domains()) {
      const history = await host.history(domain.id);
      expect(history, domain.id).toContain(0);
      expect(history.length, domain.id).toBeLessThanOrEqual(5);
      expect(path.dirname(configDomainStoragePaths(root, domain.id).configFile))
        .not.toBe(configDomainStoragePaths(root, domain.id).historyDirectory);
    }
    const appliedDomains = new Set(
      publications.filter((event) => event.source === 'apply').map((event) => event.domain),
    );
    expect(appliedDomains).toEqual(new Set([
      'app-settings',
      'browser-profiles',
      'task-definitions',
      'im-bots',
      'mcp',
      'proxies',
    ]));
  });

  it('projects one shared set of usable inference targets for runtime, UI, and selection reads', async () => {
    const { host, control } = await fixture();
    const partiallyAvailable = await host.createPatchPlan<ConfigPlan>('inference', [{
      op: 'add',
      path: '/providers/primary/models/broken',
      value: {
        catalogId: 'missing/model',
        upstreamId: 'broken',
        enabled: true,
        options: {},
      },
    }]);
    expect(partiallyAvailable.validation).toMatchObject({ valid: true });
    expect(partiallyAvailable.validation.issues).toContainEqual(expect.objectContaining({
      code: 'CATALOG_MODEL_NOT_FOUND',
      path: '/providers/primary/models/broken/catalogId',
      severity: 'warning',
    }));
    await expect(host.apply(partiallyAvailable.id, 0)).resolves.toMatchObject({ revision: 1 });
    expect(control.runtime.capture()?.targets.get('primary')?.has('chat')).toBe(true);
    expect(control.runtime.capture()?.targets.get('primary')?.has('broken')).toBe(false);

    const brokenSelection = await host.createPatchPlan<ConfigPlan>('inference-selections', [{
      op: 'add', path: '/ai', value: { providerId: 'primary', modelId: 'broken' },
    }]);
    expect(brokenSelection.validation).toMatchObject({
      valid: false,
      issues: [{ code: 'SELECTION_TARGET_NOT_FOUND' }],
    });
    await applyPlan(host, 'inference-selections', [{
      op: 'add', path: '/ai', value: { providerId: 'primary', modelId: 'chat' },
    }], 0);

    const unavailable = await host.createPatchPlan<ConfigPlan>('inference', [{
      op: 'replace',
      path: '/providers/primary/models/chat/catalogId',
      value: 'missing/model',
    }]);
    expect(unavailable.validation.valid).toBe(true);
    expect(unavailable.validation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'CATALOG_MODEL_NOT_FOUND', severity: 'warning' }),
    ]));
    await expect(host.apply(unavailable.id, 1)).resolves.toMatchObject({ revision: 2 });

    expect(control.runtime.capture()?.targets.size).toBe(0);
    await expect(host.show('inference-selections')).resolves.toEqual({
      schemaVersion: 1,
      revision: 1,
    });
    const unavailableQuery = await control.models('ai');
    expect(unavailableQuery.availableTargets).toEqual([]);
    expect(unavailableQuery.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'CATALOG_MODEL_NOT_FOUND', severity: 'warning' }),
    ]));

    const repaired = await host.createPatchPlan<ConfigPlan>('inference', [{
      op: 'replace',
      path: '/providers/primary/models/chat/catalogId',
      value: 'custom/chat',
    }]);
    expect(repaired.validation.valid).toBe(true);
    expect(repaired.validation.issues).toContainEqual(expect.objectContaining({
      path: '/providers/primary/models/broken/catalogId',
      severity: 'warning',
    }));
    await expect(host.apply(repaired.id, 2)).resolves.toMatchObject({ revision: 3 });

    await expect(host.show('inference-selections')).resolves.toMatchObject({
      ai: { providerId: 'primary', modelId: 'chat' },
    });
    await expect(control.models('ai')).resolves.toMatchObject({
      availableTargets: [{ providerId: 'primary', modelId: 'chat', catalogId: 'custom/chat' }],
    });
  });

  it('enforces cross-Domain references, impacts, lifecycle gates, and read-only fields', async () => {
    const { host, runningBots } = await fixture();
    await applyPlan(host, 'proxies', [{
      op: 'add',
      path: '/proxies/proxy-a',
      value: {
        name: 'Proxy A', protocol: 'http', host: '127.0.0.1', port: 8080, enabled: true,
      },
    }], 0);
    await applyPlan(host, 'inference', [{
      op: 'replace', path: '/providers/primary/connection/proxyId', value: 'proxy-a',
    }], 0);

    const missingProxy = await host.createPatchPlan<ConfigPlan>('inference', [{
      op: 'replace', path: '/providers/primary/connection/proxyId', value: 'missing-proxy',
    }]);
    expect(missingProxy.validation).toMatchObject({
      valid: false,
      issues: [{ code: 'INFERENCE_PROXY_NOT_FOUND' }],
    });
    const missingMcpProxy = await host.createPatchPlan<ConfigPlan>('mcp', [{
      op: 'add',
      path: '/mcpServers/remote',
      value: { url: 'https://mcp.example.test', proxyId: 'missing-proxy' },
    }]);
    expect(missingMcpProxy.validation).toMatchObject({
      valid: false,
      issues: [{ code: 'MCP_PROXY_NOT_FOUND' }],
    });
    await applyPlan(host, 'mcp', [{
      op: 'add',
      path: '/mcpServers/remote',
      value: { url: 'https://mcp.example.test', proxyId: 'proxy-a' },
    }], 0);
    const removeReferencedProxy = await host.createPatchPlan<ConfigPlan>('proxies', [{
      op: 'remove', path: '/proxies/proxy-a',
    }]);
    expect(removeReferencedProxy.validation).toMatchObject({
      valid: false,
      issues: [{ code: 'PROXY_STILL_REFERENCED' }],
    });

    await applyPlan(host, 'browser-profiles', [{
      op: 'add',
      path: '/environments/environment-a',
      value: {
        name: 'Environment A',
        identityPolicy: {
          timezone: { mode: 'ip' },
          geolocation: { mode: 'ip' },
          language: { mode: 'ip' },
        },
        proxyId: 'proxy-a',
      },
    }], 0);
    const removeBrowserProxy = await host.createPatchPlan<ConfigPlan>('proxies', [{
      op: 'remove', path: '/proxies/proxy-a',
    }]);
    expect(removeBrowserProxy.validation).toMatchObject({
      valid: false,
      issues: [{ code: 'PROXY_STILL_REFERENCED' }],
    });
    await applyPlan(host, 'task-definitions', [
      {
        op: 'add',
        path: `/definitions/${DEFINITION_A_ID}`,
        value: {
          name: 'Task A',
          description: 'Uses environment',
          purpose: 'messaging',
          promptTemplate: 'Run A.',
        },
      },
      {
        op: 'add',
        path: `/definitions/${DEFINITION_B_ID}`,
        value: {
          name: 'Task B',
          description: 'Second task',
          purpose: 'messaging',
          promptTemplate: 'Run B.',
        },
      },
      {
        op: 'add',
        path: `/definitions/${GENERAL_DEFINITION_ID}`,
        value: {
          name: 'General task',
          description: 'Not available to IM Bots',
          purpose: 'general',
          promptTemplate: 'Run generally.',
        },
      },
    ], 0);
    const removeUnboundEnvironment = await host.createPatchPlan<ConfigPlan>('browser-profiles', [{
      op: 'remove', path: '/environments/environment-a',
    }]);
    expect(removeUnboundEnvironment.validation.valid).toBe(true);

    const bindGeneralDefinition = await host.createPatchPlan<ConfigPlan>('im-bots', [{
      op: 'add',
      path: '/bots/bot-general',
      value: {
        channelType: 'openclaw-weixin',
        name: 'General Bot',
        definitionId: GENERAL_DEFINITION_ID,
      },
    }]);
    expect(bindGeneralDefinition.validation).toMatchObject({
      valid: false,
      issues: [{
        code: 'IM_BOT_TASK_DEFINITION_NOT_MESSAGING',
        path: '/bots/bot-general/definitionId',
      }],
    });

    await applyPlan(host, 'im-bots', [{
      op: 'add',
      path: '/bots/bot-a',
      value: {
        channelType: 'openclaw-weixin',
        name: 'Bot A',
        definitionId: DEFINITION_A_ID,
      },
    }], 0);
    const repurposeBoundDefinition = await host.createPatchPlan<ConfigPlan>(
      'task-definitions',
      [{
        op: 'replace',
        path: `/definitions/${DEFINITION_A_ID}/purpose`,
        value: 'general',
      }],
    );
    expect(repurposeBoundDefinition.validation).toMatchObject({
      valid: false,
      issues: [{
        code: 'TASK_DEFINITION_PURPOSE_INCOMPATIBLE_WITH_IM_BINDING',
        path: `/definitions/${DEFINITION_A_ID}/purpose`,
      }],
    });
    const bindSameDefinitionTwice = await host.createPatchPlan<ConfigPlan>('im-bots', [{
      op: 'add',
      path: '/bots/bot-b',
      value: {
        channelType: 'openclaw-weixin',
        name: 'Bot B',
        definitionId: DEFINITION_A_ID,
      },
    }]);
    expect(bindSameDefinitionTwice.validation).toMatchObject({
      valid: false,
      issues: [{
        code: 'IM_BOT_TASK_DEFINITION_ALREADY_BOUND',
        path: '/bots/bot-b/definitionId',
        details: {
          definitionId: DEFINITION_A_ID,
          ownerBotId: 'bot-a',
          conflictingBotId: 'bot-b',
        },
      }],
    });
    runningBots.add('bot-a');
    const rebindRunningBot = await host.createPatchPlan<ConfigPlan>('im-bots', [{
      op: 'replace',
      path: '/bots/bot-a/definitionId',
      value: DEFINITION_B_ID,
    }]);
    expect(rebindRunningBot.validation.valid).toBe(false);
    expect(rebindRunningBot.validation.issues).toContainEqual(expect.objectContaining({
      stage: 'lifecycle',
      message: expect.stringContaining('task_definition_locked'),
    }));

    const removeBoundDefinition = await host.createPatchPlan<ConfigPlan>('task-definitions', [{
      op: 'remove', path: `/definitions/${DEFINITION_A_ID}`,
    }]);
    expect(removeBoundDefinition.validation.valid).toBe(true);
    expect(removeBoundDefinition.impacts).toContainEqual(expect.objectContaining({
      code: 'TASK_DEFINITION_REMOVED',
      details: { affectedBots: ['bot-a'] },
    }));

    const missingSelection = await host.createPatchPlan<ConfigPlan>('inference-selections', [{
      op: 'add', path: '/ai', value: { providerId: 'primary', modelId: 'missing' },
    }]);
    expect(missingSelection.validation).toMatchObject({
      valid: false,
      issues: [{ code: 'SELECTION_TARGET_NOT_FOUND' }],
    });
    await applyPlan(host, 'inference-selections', [{
      op: 'add', path: '/ai', value: { providerId: 'primary', modelId: 'chat' },
    }], 0);
    const removeSelectedModel = await host.createPatchPlan<ConfigPlan>('inference', [{
      op: 'remove', path: '/providers/primary/models/chat',
    }]);
    expect(removeSelectedModel.validation.valid).toBe(false);
    expect(removeSelectedModel.validation.issues).toContainEqual(expect.objectContaining({
      code: 'INFERENCE_SELECTION_STILL_REFERENCED',
    }));
    expect(removeSelectedModel.impacts).toContainEqual(expect.objectContaining({
      code: 'INFERENCE_SELECTION_TARGET_REMOVED',
    }));

    await applyPlan(host, 'model-catalog', [{
      op: 'add',
      path: '/models/custom~1local',
      value: {
        displayName: 'Local Chat',
        kind: 'ai',
        lifecycle: 'active',
        compatibleDrivers: ['fake'],
        inputModalities: ['text'],
        outputModalities: ['text'],
        capabilities: { streaming: true, tools: true },
        limits: { contextWindow: 50_000 },
      },
    }], 0);
    await applyPlan(host, 'inference', [{
      op: 'replace',
      path: '/providers/primary/models/chat/catalogId',
      value: 'custom/local',
    }], 1);
    const removeReferencedCatalogModel = await host.createPatchPlan<ConfigPlan>('model-catalog', [{
      op: 'remove', path: '/models/custom~1local',
    }]);
    expect(removeReferencedCatalogModel.validation.valid).toBe(true);
    expect(removeReferencedCatalogModel.validation.issues).toContainEqual(expect.objectContaining({
      stage: 'semantic',
      severity: 'warning',
    }));

    const staleProxyPlan = await host.createPatchPlan<ConfigPlan>('proxies', [{
      op: 'add',
      path: '/proxies/proxy-b',
      value: {
        name: 'Proxy B', protocol: 'http', host: '127.0.0.2', port: 8081, enabled: true,
      },
    }]);
    expect(staleProxyPlan.validation.valid).toBe(true);
    await applyPlan(host, 'inference', [{
      op: 'replace', path: '/policies/ai/maxAttempts', value: 4,
    }], 2);
    const staleValidation = await host.validate<ConfigPlan>(staleProxyPlan.id);
    expect(staleValidation.validation).toMatchObject({
      valid: false,
      issues: [{ code: 'CONFIG_DEPENDENCY_REVISION_CHANGED' }],
    });

    const readOnlyPlans = await Promise.all([
      host.createPatchPlan<ConfigPlan>('browser-profiles', [{
        op: 'add', path: '/environments/environment-a/status', value: 'running',
      }]),
      host.createPatchPlan<ConfigPlan>('im-bots', [{
        op: 'add', path: '/bots/bot-a/status', value: 'running',
      }]),
      host.createPatchPlan<ConfigPlan>('im-bots', [{
        op: 'add', path: '/bots/bot-a/pluginAccountId', value: 'runtime-account',
      }]),
      host.createPatchPlan<ConfigPlan>('app-settings', [{
        op: 'add', path: '/auth', value: { token: 'forbidden' },
      }]),
    ]);
    for (const plan of readOnlyPlans) expect(plan.validation.valid).toBe(false);
  });

  it('exposes live browser and Bot lifecycle state through the local ConfigHost port', async () => {
    const { root, host, runningBots, runningEnvironments } = await fixture();
    await applyPlan(host, 'browser-profiles', [{
      op: 'add',
      path: '/environments/environment-a',
      value: {
        name: 'Environment A',
        identityPolicy: {
          timezone: { mode: 'ip' },
          geolocation: { mode: 'ip' },
          language: { mode: 'ip' },
        },
      },
    }], 0);
    await applyPlan(host, 'task-definitions', [
      {
        op: 'add',
        path: `/definitions/${DEFINITION_A_ID}`,
        value: {
          name: 'Task A',
          description: 'First messaging task',
          purpose: 'messaging',
          promptTemplate: 'Run A.',
        },
      },
      {
        op: 'add',
        path: `/definitions/${DEFINITION_B_ID}`,
        value: {
          name: 'Task B',
          description: 'Second messaging task',
          purpose: 'messaging',
          promptTemplate: 'Run B.',
        },
      },
    ], 0);
    await applyPlan(host, 'im-bots', [{
      op: 'add',
      path: '/bots/bot-a',
      value: {
        channelType: 'openclaw-weixin',
        name: 'Bot A',
        definitionId: DEFINITION_A_ID,
      },
    }], 0);
    runningEnvironments.add('environment-a');
    runningBots.add('bot-a');

    const server = new LocalConfigServer({
      rootDirectory: root,
      generation: 'integration-generation',
      endpointAdapter: createLocalConfigEndpointAdapter(),
      host,
    });
    await server.start();
    try {
      const client = await connectLocalConfigHost(root);
      let cliOutput = '';
      await expect(runConfigCli([
        'config', 'show', 'browser-profiles', '--root', root, '--json',
      ], {
        io: {
          stdout: (value) => { cliOutput += value; },
          stderr: () => undefined,
        },
      })).resolves.toBe(0);
      expect(JSON.parse(cliOutput)).toMatchObject({
        ok: true,
        command: 'config.show',
        data: { environments: { 'environment-a': { status: 'running' } } },
      });
      await expect(client.show('im-bots')).resolves.toMatchObject({
        bots: { 'bot-a': { status: 'running' } },
      });

      const browserDescriptor = await client.describe('browser-profiles');
      const environmentField = browserDescriptor.fields.find(
        (field) => field.pathTemplate === '/environments/{environmentId}',
      )!;
      const removeRunningEnvironment = await client.createPlan<ConfigPlan>('browser-profiles', {
        descriptorHash: browserDescriptor.descriptorHash,
        changes: [{
          op: 'remove',
          fieldId: environmentField.fieldId,
          bindings: { environmentId: 'environment-a' },
        }],
      });
      expect(removeRunningEnvironment.validation.valid).toBe(false);
      expect(removeRunningEnvironment.validation.issues).toContainEqual(expect.objectContaining({
        message: expect.stringContaining('currently running'),
      }));

      const botDescriptor = await client.describe('im-bots');
      const definitionField = botDescriptor.fields.find(
        (field) => field.pathTemplate === '/bots/{botId}/definitionId',
      )!;
      const rebindRunningBot = await client.createPlan<ConfigPlan>('im-bots', {
        descriptorHash: botDescriptor.descriptorHash,
        changes: [{
          op: 'set',
          fieldId: definitionField.fieldId,
          bindings: { botId: 'bot-a' },
          value: DEFINITION_B_ID,
        }],
      });
      expect(rebindRunningBot.validation.valid).toBe(false);
      expect(rebindRunningBot.validation.issues).toContainEqual(expect.objectContaining({
        stage: 'lifecycle',
        message: expect.stringContaining('task_definition_locked'),
      }));
    } finally {
      await server.stop();
    }
  });
});
