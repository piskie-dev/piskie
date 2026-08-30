import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InferenceControlPlane } from '../../control/control-plane.js';
import { InferenceConfigRepository, inferenceConfigPaths } from '../../control/config-repository.js';
import { InferenceSelectionStore } from '../../control/selection-store.js';
import { createFakeDriver } from '../../control/__tests__/fake-driver.js';
import { testConfig, testModel } from '../../control/__tests__/fixtures.js';
import { DriverRegistry } from '../../drivers/registry.js';
import type {
  ConfigDescriptor,
  ConfigFieldChange,
} from '../../../../shared/types/config.js';
import { resolvePiskieConfigRoot } from '../environment.js';
import { runConfigCli, type ConfigCliIo } from '../main.js';

const temporaryDirectories: string[] = [];

interface CliResult {
  code: number;
  stdout?: Record<string, unknown>;
  stderr?: Record<string, unknown>;
}

type ExecuteCli = (args: string[], stdin?: unknown) => Promise<CliResult>;

interface DescribedChange {
  op: 'set' | 'remove';
  pathTemplate: string;
  bindings?: Readonly<Record<string, string | number>>;
  value?: unknown;
  extensionId?: string;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-cli-'));
  temporaryDirectories.push(directory);
  await fs.mkdir(path.join(directory, 'catalog'), { recursive: true });
  await fs.mkdir(path.join(directory, 'config'), { recursive: true });
  await fs.writeFile(path.join(directory, 'catalog', 'models.json'), JSON.stringify({
    version: 'base-1',
    models: [testModel()],
  }), 'utf8');
  await fs.writeFile(path.join(directory, 'config', 'model-catalog.json'), JSON.stringify({
    version: 'local:0',
    revision: 0,
    models: [],
  }), 'utf8');
  const paths = inferenceConfigPaths(directory);
  const repository = new InferenceConfigRepository(paths);
  await repository.initialize(testConfig());
  const selections = new InferenceSelectionStore(paths);
  await fs.writeFile(paths.selectionFile, `${JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    ai: { providerId: 'primary', modelId: 'chat' },
  }, null, 2)}\n`, 'utf8');
  const drivers = new DriverRegistry();
  drivers.register(createFakeDriver());
  const control = new InferenceControlPlane({ repository, drivers, publisher: 'test' });
  let stdout = '';
  let stderr = '';
  let stdin = '';
  const io: ConfigCliIo = {
    stdin: async () => stdin,
    stdout: (value) => { stdout += value; },
    stderr: (value) => { stderr += value; },
  };
  const execute: ExecuteCli = async (args, input) => {
    stdout = '';
    stderr = '';
    stdin = input === undefined
      ? ''
      : typeof input === 'string' ? input : JSON.stringify(input);
    const code = await runConfigCli([...args, '--root', directory], {
      io,
      createControlPlane: () => control,
      createSelectionStore: () => selections,
    });
    return {
      code,
      stdout: stdout ? JSON.parse(stdout) as Record<string, unknown> : undefined,
      stderr: stderr ? JSON.parse(stderr) as Record<string, unknown> : undefined,
    };
  };
  return { execute, control, directory };
}

async function planRequest(
  execute: ExecuteCli,
  domain: string,
  changes: readonly DescribedChange[],
) {
  const described = await execute(['config', 'describe', domain, '--json']);
  const descriptor = described.stdout?.data as ConfigDescriptor;
  const resolved: ConfigFieldChange[] = changes.map((change) => {
    const field = descriptor.fields.find((candidate) => (
      candidate.pathTemplate === change.pathTemplate
      && candidate.extensionId === change.extensionId
    ));
    if (!field) throw new Error(`Descriptor field not found: ${domain}:${change.pathTemplate}`);
    if (change.op === 'remove') {
      return {
        op: 'remove',
        fieldId: field.fieldId,
        ...(change.bindings && { bindings: change.bindings }),
      };
    }
    return {
      op: 'set',
      fieldId: field.fieldId,
      ...(change.bindings && { bindings: change.bindings }),
      value: change.value,
    };
  });
  return { descriptorHash: descriptor.descriptorHash, changes: resolved };
}

async function createPlan(
  execute: ExecuteCli,
  domain: string,
  changes: readonly DescribedChange[],
): Promise<CliResult> {
  const request = await planRequest(execute, domain, changes);
  return execute(
    ['config', 'plan', domain, '--changes-stdin', '--json'],
    request,
  );
}

describe('piskie config CLI', () => {
  it('routes Plan commands through ConfigHost without a fixed inference Domain lookup', async () => {
    const source = await fs.readFile(
      path.resolve('electron/inference/config-cli/main.ts'),
      'utf8',
    );
    expect(source).not.toContain("configDomains.get('inference')");
    expect(source).toContain("action: 'validate'");
    expect(source).toContain('host.validate');
    expect(source).toContain('host.probe');
    expect(source).toContain('host.apply');
  });

  it('exposes only the canonical config command surface', async () => {
    const { execute } = await fixture();
    const help = await execute(['help', '--json']);
    const commands = (help.stdout?.data as { commands: string[] }).commands;

    expect(commands.some((entry) => entry.startsWith('piskie selections '))).toBe(false);
    expect(commands.some((entry) => entry.startsWith('piskie catalog '))).toBe(false);
    expect(commands.some((entry) => entry.includes('config schema'))).toBe(false);
    expect(commands.some((entry) => entry.includes('--patch-'))).toBe(false);
    expect(commands).toContain('piskie config plan <domain> --changes-stdin --json');
    await expect(execute(['config', 'schema', 'inference', '--json'])).resolves.toMatchObject({
      code: 2,
      stderr: { error: { code: 'CLI_ARGUMENT_INVALID' } },
    });
    await expect(execute(['selections', 'show', '--json'])).resolves.toMatchObject({
      code: 2,
      stderr: { error: { code: 'CLI_ARGUMENT_INVALID' } },
    });
  });

  it('discovers registered config domains and the effective fake Driver contract', async () => {
    const { execute } = await fixture();
    const domains = await execute(['config', 'domains', '--json']);
    const described = await execute(['config', 'describe', 'inference', '--json']);
    const describedDefinitions = await execute([
      'config', 'describe', 'task-definitions', '--json',
    ]);

    expect(domains).toMatchObject({
      code: 0,
      stdout: {
        command: 'config.domains',
        data: [
          { id: 'app-settings' },
          { id: 'browser-profiles' },
          { id: 'im-bots' },
          { id: 'inference' },
          { id: 'inference-selections' },
          { id: 'mcp' },
          { id: 'model-catalog' },
          { id: 'proxies' },
          { id: 'task-definitions' },
        ],
      },
    });
    const descriptor = described.stdout?.data as {
      descriptorHash: string;
      fields: Array<{
        fieldId: string;
        pathTemplate: string;
        bindings: Array<{ name: string; kind: string }>;
      }>;
      dynamicExtensions: Array<{ id: string; selector: { value: string } }>;
    };
    expect(described.code).toBe(0);
    expect(descriptor.descriptorHash).toMatch(/^[a-f0-9]{64}$/);
    expect(descriptor.fields).toContainEqual(expect.objectContaining({
      fieldId: expect.stringMatching(/^field_[a-f0-9]{24}$/),
      pathTemplate: '/providers/{providerId}/models/{modelId}/upstreamId',
      bindings: [
        { name: 'providerId', kind: 'record-key' },
        { name: 'modelId', kind: 'record-key' },
      ],
    }));
    expect(descriptor.dynamicExtensions).toEqual([
      expect.objectContaining({
        id: 'inference-driver:fake',
        selector: { path: '/providers/{providerId}/driver', value: 'fake' },
      }),
    ]);
    expect((domains.stdout?.data as Array<{ id: string; descriptorHash: string }>)
      .find((domain) => domain.id === 'inference')?.descriptorHash)
      .toBe(descriptor.descriptorHash);

    const definitionsDescriptor = describedDefinitions.stdout?.data as ConfigDescriptor;
    expect(definitionsDescriptor.description).toMatch(/reusable/i);
    expect(definitionsDescriptor.fields).toContainEqual(expect.objectContaining({
      pathTemplate: '/definitions/{definitionId}',
      bindings: [{ name: 'definitionId', kind: 'record-key' }],
    }));
  });

  it('describes every built-in Driver without bootstrapping config state', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-cli-describe-'));
    temporaryDirectories.push(directory);
    let stdout = '';
    const code = await runConfigCli([
      'config', 'describe', 'inference', '--root', directory, '--json',
    ], {
      io: {
        stdout: (value) => { stdout += value; },
        stderr: () => undefined,
      },
    });
    const result = JSON.parse(stdout) as {
      data: { dynamicExtensions: Array<{ id: string }> };
    };

    expect(code).toBe(0);
    expect(result.data.dynamicExtensions.map((extension) => extension.id)).toEqual([
      'inference-driver:anthropic-messages',
      'inference-driver:baidu-image',
      'inference-driver:comfyui-workflow',
      'inference-driver:dashscope-image',
      'inference-driver:gemini-image',
      'inference-driver:openai',
      'inference-driver:openrouter-image',
    ]);
    await expect(fs.stat(inferenceConfigPaths(directory).configFile)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not bootstrap or write config when the running Electron Host is unavailable', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-cli-fresh-'));
    temporaryDirectories.push(directory);
    let stderr = '';
    const code = await runConfigCli([
      'config', 'show', 'inference', '--root', directory, '--json',
    ], {
      io: {
        stdout: () => undefined,
        stderr: (value) => { stderr += value; },
      },
    });
    const result = JSON.parse(stderr) as { error: { code: string } };

    expect(code).toBe(1);
    expect(result.error.code).toBe('CONFIG_HOST_UNAVAILABLE');
    const paths = inferenceConfigPaths(directory);
    await expect(fs.stat(paths.configFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(paths.selectionFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns plaintext configuration through a stable JSON envelope', async () => {
    const { execute, control } = await fixture();
    const result = await execute(['config', 'show', 'inference', '--json']);
    expect(result).toMatchObject({
      code: 0,
      stdout: {
        ok: true,
        command: 'config.show',
        data: {
          revision: 0,
          providers: { primary: { connection: { auth: { value: 'sk-plaintext-secret' } } } },
        },
      },
    });
    expect(result.stderr).toBeUndefined();
    expect(control.runtime.capture()).toBeUndefined();
  });

  it('ignores legacy catalog references and queries only the canonical Catalog source', async () => {
    const legacyPath = 'catalog/models.local.json';
    const { execute, directory, control } = await fixture();
    const legacyContents = '{ legacy catalog must not be read';
    await fs.writeFile(path.join(directory, legacyPath), legacyContents, 'utf8');
    const persisted = JSON.parse(await fs.readFile(control.configRepository.paths.configFile, 'utf8')) as Record<string, unknown>;
    persisted.catalog = {
      base: { kind: 'local', path: 'catalog/models.json' },
      overlays: [{ kind: 'local', path: legacyPath }],
    };
    await fs.writeFile(
      control.configRepository.paths.configFile,
      `${JSON.stringify(persisted, null, 2)}\n`,
      'utf8',
    );

    const shown = await execute(['config', 'show', 'inference', '--json']);
    expect(shown).toMatchObject({
      code: 0,
      stdout: {
        data: {
          revision: 0,
        },
      },
    });
    expect(shown.stdout?.data).not.toHaveProperty('catalog');
    expect(control.runtime.capture()).toBeUndefined();

    const described = await execute(['config', 'describe', 'inference', '--json']);
    const fields = ((described.stdout?.data as { fields?: Array<{ pathTemplate: string }> })?.fields ?? []);
    expect(fields.some((field) => field.pathTemplate.startsWith('/catalog'))).toBe(false);

    await expect(execute(['models', 'query', '--gateway', 'ai', '--json'])).resolves.toMatchObject({
      code: 0,
      stdout: {
        data: {
          models: expect.arrayContaining([expect.objectContaining({ id: 'custom/chat' })]),
          availableTargets: [{ providerId: 'primary', modelId: 'chat', catalogId: 'custom/chat' }],
          issues: [],
        },
      },
    });
    expect(await fs.readFile(path.join(directory, legacyPath), 'utf8')).toBe(legacyContents);
  });

  it('completes plan, validate, apply, and verify without editing config files directly', async () => {
    const { execute } = await fixture();
    const planned = await createPlan(execute, 'inference', [{
      op: 'set',
      pathTemplate: '/providers/{providerId}/models/{modelId}/upstreamId',
      bindings: { providerId: 'primary', modelId: 'chat' },
      value: 'wire-cli-next',
    }]);
    const planId = ((planned.stdout!.data as Record<string, unknown>).id) as string;

    await expect(execute(['config', 'validate', planId, '--json'])).resolves.toMatchObject({
      code: 0,
      stdout: { data: { validation: { valid: true }, baseRevision: 0 } },
    });
    await expect(execute([
      'config', 'probe', planId,
      '--level', 'connectivity',
      '--provider', 'primary',
      '--model', 'chat',
      '--json',
    ])).resolves.toMatchObject({
      code: 0,
      stdout: {
        data: [expect.objectContaining({
          level: 'connectivity',
          providerId: 'primary',
          success: true,
        })],
      },
    });
    await expect(execute([
      'config', 'apply', planId, '--expected-revision', '0', '--json',
    ])).resolves.toMatchObject({
      code: 0,
      stdout: { data: { revision: 1, previousRevision: 0 } },
    });
    await expect(execute(['config', 'verify', 'inference', '--revision', '1', '--json'])).resolves.toMatchObject({
      code: 0,
      stdout: { data: { healthy: true, diskRevision: 1, inProcessRuntimeRevision: 1 } },
    });
  });

  it('resolves a persisted Plan when injected tests create a fresh in-process Host', async () => {
    const { execute } = await fixture();

    const planned = await createPlan(execute, 'inference', [{
      op: 'set',
      pathTemplate: '/policies/ai/maxAttempts',
      value: 4,
    }]);
    const planId = (planned.stdout?.data as { id: string }).id;

    await expect(execute(['config', 'validate', planId])).resolves.toMatchObject({
      code: 0,
      stdout: { data: { validation: { valid: true }, baseRevision: 0 } },
    });
    await expect(execute([
      'config', 'apply', planId, '--expected-revision', '0',
    ])).resolves.toMatchObject({
      code: 0,
      stdout: { data: { domain: 'inference', revision: 1 } },
    });
  });

  it('creates the same descriptor-bound Plan from a changes file', async () => {
    const { execute, directory } = await fixture();
    const changesFile = path.join(directory, 'candidate.changes.json');
    const request = await planRequest(execute, 'inference', [{
      op: 'set',
      pathTemplate: '/providers/{providerId}/models/{modelId}/upstreamId',
      bindings: { providerId: 'primary', modelId: 'chat' },
      value: 'wire-cli-from-file',
    }]);
    await fs.writeFile(changesFile, JSON.stringify(request), 'utf8');

    const planned = await execute([
      'config', 'plan', 'inference', '--changes-file', changesFile, '--json',
    ]);

    expect(planned).toMatchObject({
      code: 0,
      stdout: {
        command: 'config.plan',
        data: {
          domain: 'inference',
          baseRevision: 0,
          patch: [{
            op: 'add',
            path: '/providers/primary/models/chat/upstreamId',
            value: 'wire-cli-from-file',
          }],
        },
      },
    });
  });

  it('uses stable nonzero argument errors and exposes model/Driver discovery', async () => {
    const { execute } = await fixture();
    await expect(execute(['config', 'plan', 'inference', '--changes-stdin', '--json'], '')).resolves.toMatchObject({
      code: 2,
      stderr: { ok: false, error: { code: 'CLI_ARGUMENT_INVALID' } },
    });
    const described = await execute(['config', 'describe', 'inference', '--json']);
    await expect(execute(
      ['config', 'plan', 'inference', '--changes-stdin', '--json'],
      {
        descriptorHash: (described.stdout?.data as ConfigDescriptor).descriptorHash,
        changes: [{ op: 'set', fieldId: 'field_guessed', value: true }],
      },
    )).resolves.toMatchObject({
      code: 1,
      stderr: { error: { code: 'CONFIG_FIELD_NOT_FOUND' } },
    });
    await expect(execute(['drivers', 'schema', 'fake', '--json'])).resolves.toMatchObject({
      code: 0,
      stdout: { data: { id: 'fake', supportedGateways: ['ai'] } },
    });
    await expect(execute(['models', 'query', '--gateway', 'ai', '--json'])).resolves.toMatchObject({
      code: 0,
      stdout: {
        data: {
          catalogVersion: 'base-1+local:0',
          models: [{ id: 'custom/chat' }],
          availableTargets: [{ providerId: 'primary', modelId: 'chat', catalogId: 'custom/chat' }],
          issues: [],
        },
      },
    });
  });

  it('exposes only effective targets while preserving ignored-entry diagnostics', async () => {
    const { execute } = await fixture();
    const planned = await createPlan(execute, 'inference', [{
      op: 'set',
      pathTemplate: '/providers/{providerId}/models/{modelId}',
      bindings: { providerId: 'primary', modelId: 'broken' },
      value: {
        catalogId: 'missing/model',
        upstreamId: 'broken',
        enabled: true,
        options: {},
      },
    }]);
    expect(planned).toMatchObject({
      code: 0,
      stdout: {
        data: {
          validation: {
            valid: true,
            issues: [{ code: 'CATALOG_MODEL_NOT_FOUND', severity: 'warning' }],
          },
        },
      },
    });
    const planId = (planned.stdout?.data as { id: string }).id;
    await expect(execute([
      'config', 'apply', planId, '--expected-revision', '0', '--json',
    ])).resolves.toMatchObject({ code: 0, stdout: { data: { revision: 1 } } });

    await expect(execute(['models', 'query', '--gateway', 'ai', '--json'])).resolves.toMatchObject({
      code: 0,
      stdout: {
        data: {
          availableTargets: [{ providerId: 'primary', modelId: 'chat', catalogId: 'custom/chat' }],
          issues: [{ code: 'CATALOG_MODEL_NOT_FOUND', severity: 'warning' }],
        },
      },
    });

    const selection = await createPlan(execute, 'inference-selections', [{
      op: 'set',
      pathTemplate: '/ai',
      value: { providerId: 'primary', modelId: 'broken' },
    }]);
    expect(selection).toMatchObject({
      code: 0,
      stdout: { data: { validation: { valid: false, issues: [{ code: 'SELECTION_TARGET_NOT_FOUND' }] } } },
    });
  });

  it('updates exact selections with CAS and supports explicit clearing', async () => {
    const { execute } = await fixture();
    await expect(execute(['config', 'show', 'inference-selections', '--json'])).resolves.toMatchObject({
      code: 0,
      stdout: { data: { revision: 1, ai: { providerId: 'primary', modelId: 'chat' } } },
    });
    const replacePlan = await createPlan(execute, 'inference-selections', [{
      op: 'set',
      pathTemplate: '/ai',
      value: { providerId: 'primary', modelId: 'chat' },
    }]);
    const replacePlanId = (replacePlan.stdout?.data as { id: string }).id;
    await expect(execute([
      'config', 'apply', replacePlanId, '--expected-revision', '1', '--json',
    ])).resolves.toMatchObject({ code: 0, stdout: { data: { revision: 2 } } });

    const clearPlan = await createPlan(execute, 'inference-selections', [{
      op: 'remove',
      pathTemplate: '/ai',
    }]);
    const clearPlanId = (clearPlan.stdout?.data as { id: string }).id;
    await expect(execute([
      'config', 'apply', clearPlanId, '--expected-revision', '2', '--json',
    ])).resolves.toMatchObject({ code: 0, stdout: { data: { revision: 3 } } });
    const shown = await execute(['config', 'show', 'inference-selections', '--json']);
    expect(shown.stdout?.data).not.toHaveProperty('ai');
  });

  it('adds and removes local catalog models through schema-checked CAS commands', async () => {
    const { execute } = await fixture();
    const localModel = {
      id: 'custom/second-chat',
      displayName: 'Second Chat',
      kind: 'ai',
      lifecycle: 'active',
      compatibleDrivers: ['fake'],
      inputModalities: ['text'],
      outputModalities: ['text'],
      capabilities: { streaming: true, tools: true },
      limits: { contextWindow: 50_000 },
    };

    await expect(execute(['config', 'describe', 'model-catalog', '--json'])).resolves.toMatchObject({
      code: 0,
      stdout: { command: 'config.describe', data: { writeSchema: { type: 'object' } } },
    });
    const modelValue = { ...localModel };
    Reflect.deleteProperty(modelValue, 'id');
    const addPlan = await createPlan(execute, 'model-catalog', [{
      op: 'set',
      pathTemplate: '/models/{modelId}',
      bindings: { modelId: 'custom/second-chat' },
      value: modelValue,
    }]);
    const addPlanId = (addPlan.stdout?.data as { id: string }).id;
    await expect(execute([
      'config', 'apply', addPlanId, '--expected-revision', '0', '--json',
    ])).resolves.toMatchObject({
      code: 0,
      stdout: { data: { domain: 'model-catalog', previousRevision: 0, revision: 1 } },
    });
    await expect(execute(['config', 'show', 'model-catalog', '--json'])).resolves.toMatchObject({
      code: 0,
      stdout: { data: { revision: 1, models: { 'custom/second-chat': modelValue } } },
    });
    const removePlan = await createPlan(execute, 'model-catalog', [{
      op: 'remove',
      pathTemplate: '/models/{modelId}',
      bindings: { modelId: 'custom/second-chat' },
    }]);
    const removePlanId = (removePlan.stdout?.data as { id: string }).id;
    await expect(execute([
      'config', 'apply', removePlanId, '--expected-revision', '1', '--json',
    ])).resolves.toMatchObject({ code: 0, stdout: { data: { revision: 2 } } });
  });
});

describe('resolvePiskieConfigRoot', () => {
  it('supports an explicit root and one platform-neutral home default', () => {
    const customRoot = path.join(os.tmpdir(), 'custom root', '配置');
    const homeDirectory = path.join(os.tmpdir(), '100% User');

    expect(resolvePiskieConfigRoot({ PISKIE_CONFIG_ROOT: customRoot }, homeDirectory))
      .toBe(path.resolve(customRoot));
    expect(resolvePiskieConfigRoot({}, homeDirectory))
      .toBe(path.resolve(homeDirectory, '.piskie'));
  });
});
