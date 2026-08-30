import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalCatalogDocument } from '../../catalog/contracts.js';
import type { InferenceDriver } from '../../drivers/contracts.js';
import { DriverRegistry } from '../../drivers/registry.js';
import { RuntimeSnapshotStore } from '../../execution/runtime-snapshot.js';
import { InferenceControlPlane } from '../control-plane.js';
import { InferenceConfigRepository, inferenceConfigPaths } from '../config-repository.js';
import { createFakeDriver } from './fake-driver.js';
import { testConfig, testModel } from './fixtures.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

async function fixture(driver: InferenceDriver = createFakeDriver()) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-control-'));
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

  const repository = new InferenceConfigRepository(inferenceConfigPaths(directory));
  await repository.initialize(testConfig());
  const drivers = new DriverRegistry();
  drivers.register(driver);
  const runtime = new RuntimeSnapshotStore();
  const control = new InferenceControlPlane({
    repository,
    drivers,
    runtime,
    publisher: 'electron',
    now: () => new Date('2026-07-29T01:00:00.000Z'),
  });
  return { control, repository, runtime };
}

describe('InferenceControlPlane runtime hooks', () => {
  it('runs candidate smoke through the compiled gateway target instead of a Driver probe request', async () => {
    const attempts: Array<{ upstreamModel: string; request: unknown }> = [];
    const driver: InferenceDriver = {
      ...createFakeDriver(),
      compile: (input) => ({
        ref: { providerId: input.providerId, modelId: input.modelId },
        driverId: 'fake',
        upstreamModel: input.binding.upstreamId,
        catalogId: input.binding.catalogId,
        configRevision: input.configRevision,
        ai: {
          openAttempt: async function* (request) {
            attempts.push({ upstreamModel: input.binding.upstreamId, request });
            yield { kind: 'response.completed', stopReason: 'end_turn' };
          },
        },
      }),
      probeConnectivity: async () => {
        throw new Error('model smoke must not call Driver connectivity probing');
      },
    };
    const { control, repository } = await fixture(driver);
    const candidate = await repository.read();
    candidate.providers.primary!.models.chat!.upstreamId = 'wire-chat-candidate';

    await expect(control.probeConfigCandidate(candidate, 'smoke', {
      providerId: 'primary',
      modelId: 'chat',
    })).resolves.toMatchObject([{ success: true, modelId: 'chat' }]);
    expect(attempts).toEqual([{
      upstreamModel: 'wire-chat-candidate',
      request: {
        model: { providerId: 'primary', modelId: 'chat' },
        messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
        generation: { maxOutputTokens: 16 },
      },
    }]);
  });

  it('returns the same resolved binding metadata used by runtime compilation', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-control-resolved-model-'));
    temporaryDirectories.push(directory);
    await fs.mkdir(path.join(directory, 'catalog'), { recursive: true });
    await fs.mkdir(path.join(directory, 'config'), { recursive: true });
    const reasoning = {
      mode: 'effort' as const,
      options: [
        { kind: 'effort' as const, effort: 'low' as const },
        { kind: 'effort' as const, effort: 'medium' as const },
        { kind: 'effort' as const, effort: 'high' as const },
      ],
      defaultSelection: { kind: 'effort' as const, effort: 'medium' as const },
      mandatory: false,
      transportPreset: 'openai-effort' as const,
      replayPolicy: 'opaque-required' as const,
    };
    await fs.writeFile(path.join(directory, 'catalog', 'models.json'), JSON.stringify({
      version: 'base-1',
      models: [testModel({
        id: 'known/wire-chat',
        displayName: 'Known Chat',
        family: 'known',
        capabilities: { streaming: true, tools: true, vision: true, reasoning: true },
        reasoning,
        limits: { contextWindow: 128_000 },
        source: { kind: 'bundled', version: 'base-1' },
      })],
    }));
    await fs.writeFile(path.join(directory, 'config', 'model-catalog.json'), JSON.stringify({
      version: 'local:1',
      revision: 1,
      models: [testModel({
        id: 'local/chat',
        displayName: 'Local Binding',
        capabilities: { reasoning: false },
        limits: {},
        source: { kind: 'local', version: 'local:1' },
      })],
    }));
    const config = testConfig();
    config.providers.primary!.models.chat!.catalogId = 'local/chat';
    config.providers.primary!.models.chat!.upstreamId = 'wire-chat';
    const repository = new InferenceConfigRepository(inferenceConfigPaths(directory));
    await repository.initialize(config);
    const drivers = new DriverRegistry();
    drivers.register(createFakeDriver());
    const control = new InferenceControlPlane({ repository, drivers });

    const result = await control.models('ai');

    expect(result.models.find((model) => model.id === 'local/chat')).toMatchObject({
      displayName: 'Local Binding',
      family: 'known',
      capabilities: { streaming: true, tools: true, vision: true, reasoning: true },
      reasoning,
      limits: {},
      source: { kind: 'local', version: 'local:1' },
    });
    expect(result.availableTargets).not.toContainEqual(expect.objectContaining({
      providerId: 'primary',
      modelId: 'chat',
    }));
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'MODEL_CONTEXT_WINDOW_MISSING',
      severity: 'warning',
    }));
  });

  it('validates, probes, and publishes candidates without owning persistence transactions', async () => {
    const { control, repository, runtime } = await fixture();
    const candidate = await repository.read();
    candidate.revision = 1;
    candidate.providers.primary!.models.chat!.upstreamId = 'wire-chat-next';

    await expect(control.validateConfigCandidate(candidate)).resolves.toMatchObject({
      valid: true,
      issues: [],
    });
    await expect(control.probeConfigCandidate(candidate, 'smoke')).resolves.toMatchObject([{
      success: true,
      providerId: 'primary',
      modelId: 'chat',
    }]);
    await control.publishConfigCandidate(candidate);

    expect((await repository.read()).revision).toBe(0);
    expect(runtime.capture()).toMatchObject({ configRevision: 1 });
  });

  it('publishes the usable subset and reports an invalid model without changing disk', async () => {
    const { control, repository, runtime } = await fixture();
    const candidate = await repository.read();
    candidate.providers.primary!.models.broken = {
      ...candidate.providers.primary!.models.chat!,
      catalogId: 'missing/model',
    };

    await expect(control.validateConfigCandidate(candidate)).resolves.toMatchObject({
      valid: true,
      issues: [{
        code: 'CATALOG_MODEL_NOT_FOUND',
        path: '/providers/primary/models/broken/catalogId',
        severity: 'warning',
      }],
    });
    await expect(control.publishConfigCandidate(candidate)).resolves.toBeUndefined();
    expect((await repository.read()).revision).toBe(0);
    expect(runtime.capture()?.targets.get('primary')?.has('chat')).toBe(true);
    expect(runtime.capture()?.targets.get('primary')?.has('broken')).toBe(false);
  });

  it('isolates a Driver compilation failure to the affected target', async () => {
    const throwing: InferenceDriver = {
      ...createFakeDriver(),
      compile: () => {
        throw new Error('injected compiler failure');
      },
    };
    const { control, repository, runtime } = await fixture(throwing);
    const candidate = await repository.read();

    await expect(control.validateConfigCandidate(candidate)).resolves.toMatchObject({
      valid: true,
      issues: [{ code: 'DRIVER_COMPILE_FAILED', severity: 'warning' }],
    });
    await expect(control.publishConfigCandidate(candidate)).resolves.toBeUndefined();
    expect((await repository.read()).revision).toBe(0);
    expect(runtime.capture()?.targets.size).toBe(0);
  });

  it('validates and publishes catalog candidates without writing the catalog file', async () => {
    const { control, runtime } = await fixture();
    await control.loadCurrent();
    const initial = runtime.capture();
    const invalid: LocalCatalogDocument = {
      revision: 1,
      version: 'local:1',
      models: [testModel({
        compatibleDrivers: ['openai'],
        source: { kind: 'local', version: 'local:1' },
      })],
    };

    await expect(control.validateCatalogCandidate(invalid)).resolves.toMatchObject({
      valid: true,
      issues: [{ code: 'MODEL_DRIVER_INCOMPATIBLE', severity: 'warning' }],
    });
    await control.publishCatalogCandidate(invalid);
    expect(runtime.capture()).not.toBe(initial);
    expect(runtime.capture()?.targets.size).toBe(0);

    const valid: LocalCatalogDocument = {
      revision: 1,
      version: 'local:1',
      models: [testModel({
        displayName: 'Updated local model',
        source: { kind: 'local', version: 'local:1' },
      })],
    };
    await expect(control.validateCatalogCandidate(valid)).resolves.toEqual({ valid: true, issues: [] });
    await control.publishCatalogCandidate(valid);
    expect(runtime.capture()).toMatchObject({ catalogVersion: 'base-1+local:1' });
  });
});
