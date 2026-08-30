import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CatalogOverlayDocument } from '../../catalog/contracts.js';
import {
  bundledCatalogPaths,
  ensureBundledInferenceCatalog,
} from '../../catalog/bundled-source.js';
import { emptyInferenceConfig } from '../../control/bootstrap-config.js';
import {
  InferenceConfigRepository,
  inferenceConfigPaths,
} from '../../control/config-repository.js';
import type { InferenceConfig } from '../../control/config-schema.js';
import { findCompiledTarget } from '../../execution/runtime-snapshot.js';
import { InferenceRuntimeHost } from '../runtime-host.js';
import { undocumentedWritableFields } from '../../../config/core/descriptor-builder.js';
import { createConfigDomainRegistry } from '../../../config/host/composition.js';
import { createDefaultControlPlane } from '../../config-cli/main.js';
import { configFileWriter } from '../../../config/core/atomic-file-writer.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('InferenceRuntimeHost', () => {
  it('bootstraps an empty plaintext domain and atomically reloads an externally committed revision', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-inference-host-'));
    directories.push(root);
    const configChanges: Array<{ revision: number; source: string }> = [];
    const host = new InferenceRuntimeHost({
      rootDirectory: root,
      now: () => new Date('2026-07-29T06:00:00.000Z'),
      onConfigChanged: (event) => configChanges.push(event),
    });
    const started = await host.initialize();

    expect(started).toMatchObject({
      bootstrap: { created: true, revision: 0 },
      currentRevision: 0,
      restoredHistoricalRevisions: [],
      historicalRevisionErrors: [],
    });
    expect(host.drivers.list().map((driver) => driver.manifest.id)).toEqual([
      'anthropic-messages',
      'baidu-image',
      'comfyui-workflow',
      'dashscope-image',
      'gemini-image',
      'openai',
      'openrouter-image',
    ]);
    const cliControl = createDefaultControlPlane(root);
    expect(cliControl.drivers().map((driver) => driver.id))
      .toEqual(host.drivers.list().map((driver) => driver.manifest.id));
    const descriptor = host.configHost.describe('inference');
    expect(createConfigDomainRegistry({ inference: cliControl }).describe('inference').descriptorHash)
      .toBe(descriptor.descriptorHash);
    for (const [domain, paths] of Object.entries({
      inference: [
        '/providers/{providerId}',
        '/providers/{providerId}/models/{modelId}',
        '/providers/{providerId}/models/{modelId}/defaultReasoning',
        '/policies/image/operationTimeoutMs',
      ],
      'inference-selections': ['/ai', '/image'],
      'model-catalog': ['/models/{modelId}'],
    })) {
      const fields = host.configHost.describe(domain).fields;
      for (const pathTemplate of paths) {
        expect(fields, `${domain}:${pathTemplate}`).toContainEqual(expect.objectContaining({
          pathTemplate,
          source: 'domain',
          mutability: 'write',
        }));
      }
    }
    expect(descriptor.dynamicExtensions.map((extension) => extension.id)).toEqual([
      'inference-driver:anthropic-messages',
      'inference-driver:baidu-image',
      'inference-driver:comfyui-workflow',
      'inference-driver:dashscope-image',
      'inference-driver:gemini-image',
      'inference-driver:openai',
      'inference-driver:openrouter-image',
    ]);
    expect(descriptor.fields).toContainEqual(expect.objectContaining({
      fieldId: expect.stringMatching(/^field_[a-f0-9]{24}$/),
      pathTemplate: '/providers/{providerId}/driverOptions/wireApi',
      bindings: [{ name: 'providerId', kind: 'record-key' }],
      extensionId: 'inference-driver:openai',
      description: 'Wire protocol shared by every AI model on this Provider.',
      changeImpact: 'Affects every AI model under this Provider.',
      recommendedProbe: 'smoke',
      billableProbe: true,
    }));
    expect(undocumentedWritableFields(descriptor)).toEqual([]);
    expect(host.configHost.domains().map((domain) => domain.id)).toEqual([
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
    for (const domain of host.configHost.domains()) {
      expect(undocumentedWritableFields(host.configHost.describe(domain.id)), domain.id).toEqual([]);
    }

    const overlay: CatalogOverlayDocument = {
      version: 'host-test:1',
      models: [{
        id: 'local/host-chat',
        displayName: 'Host Chat',
        kind: 'ai',
        lifecycle: 'active',
        compatibleDrivers: ['openai'],
        inputModalities: ['text'],
        outputModalities: ['text'],
        capabilities: { streaming: true, tools: true },
        limits: { contextWindow: 128_000 },
        source: { kind: 'local', version: '1' },
      }],
    };
    await configFileWriter.replace(
      bundledCatalogPaths(root).overlayFile,
      `${JSON.stringify(overlay, null, 2)}\n`,
    );
    const current = await host.repository.read();
    const candidate: InferenceConfig = {
      ...current,
      providers: {
        local: {
          displayName: 'Local OpenAI-compatible',
          driver: 'openai',
          enabled: true,
          connection: {
            baseUrl: 'http://127.0.0.1:9999/v1',
            auth: { kind: 'bearer', value: 'plain-local-key' },
            headers: {},
            proxyId: null,
          },
          models: {
            'org/model': {
              catalogId: 'local/host-chat',
              upstreamId: 'org/model',
              enabled: true,
              options: {},
            },
          },
          driverOptions: {},
        },
      },
    };
    await host.repository.commit(candidate, 0);
    await host.reloadFromDisk();
    await host.reloadFromDisk();

    const snapshot = host.control.runtime.capture();
    expect(snapshot?.configRevision).toBe(1);
    expect(findCompiledTarget(snapshot!, { providerId: 'local', modelId: 'org/model' })).toMatchObject({
      ref: { providerId: 'local', modelId: 'org/model' },
      upstreamModel: 'org/model',
      driverId: 'openai',
    });
    expect(await fs.readFile(host.paths.configFile, 'utf8')).toContain('plain-local-key');
    expect(configChanges).toEqual([
      expect.objectContaining({ revision: 1, source: 'external' }),
    ]);
    await host.close();
  });

  it('ignores legacy Catalog paths persisted inside inference configuration', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-inference-canonical-catalog-'));
    directories.push(root);
    await fs.mkdir(path.join(root, 'catalog'), { recursive: true });
    await fs.mkdir(path.join(root, 'config'), { recursive: true });
    await ensureBundledInferenceCatalog(root);

    const legacyOverlayPath = path.join(root, 'catalog', 'models.local.json');
    const legacyOverlay = '{ legacy Catalog must not be read';
    await fs.writeFile(legacyOverlayPath, legacyOverlay, 'utf8');
    await fs.writeFile(path.join(root, 'config', 'model-catalog.json'), `${JSON.stringify({
      version: 'local:0',
      revision: 0,
      models: [],
    }, null, 2)}\n`, 'utf8');
    const repository = new InferenceConfigRepository(inferenceConfigPaths(root));
    await repository.initialize(emptyInferenceConfig());
    const persisted = JSON.parse(
      await fs.readFile(repository.paths.configFile, 'utf8'),
    ) as Record<string, unknown>;
    persisted.catalog = {
      base: { kind: 'local', path: 'catalog/models.json' },
      overlays: [{ kind: 'local', path: 'catalog/models.local.json' }],
    };
    await fs.writeFile(repository.paths.configFile, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');

    const host = new InferenceRuntimeHost({
      rootDirectory: root,
      now: () => new Date('2026-08-06T05:00:00.000Z'),
    });
    try {
      const started = await host.initialize();
      const catalogDomain = host.configHost.domains()
        .find((domain) => domain.id === 'model-catalog');

      expect(started.issues).toEqual([]);
      expect(catalogDomain?.availability)
        .toEqual({ state: 'active', configurable: true, runtimeActive: true });
      const inference = await host.configHost.show<Record<string, unknown>>('inference');
      expect(inference).not.toHaveProperty('catalog');
      await expect(host.control.models('ai')).resolves.toMatchObject({ gateway: 'ai' });
      expect(host.control.runtime.capture()?.configRevision).toBe(0);
      expect(await fs.readFile(legacyOverlayPath, 'utf8')).toBe(legacyOverlay);
    } finally {
      await host.close();
    }
  });
});
