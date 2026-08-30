import { describe, expect, it } from 'vitest';
import { DriverRegistry } from '../../drivers/registry.js';
import { findCompiledTarget, RuntimeSnapshotStore } from '../../execution/runtime-snapshot.js';
import { compileInferenceConfig } from '../compiler.js';
import { createFakeDriver } from './fake-driver.js';
import { testCatalog, testConfig, testModel } from './fixtures.js';

describe('compileInferenceConfig', () => {
  it('binds enabled models into an exact two-level target index', () => {
    const drivers = new DriverRegistry();
    drivers.register(createFakeDriver());
    const catalog = testCatalog(testModel({
      limits: { contextWindow: 8_000, maxOutputTokens: 2_000 },
    }));
    const snapshot = compileInferenceConfig(
      testConfig({ revision: 12 }),
      catalog,
      drivers,
      () => new Date('2026-07-29T01:00:00.000Z'),
    );

    expect(findCompiledTarget(snapshot, { providerId: 'primary', modelId: 'chat' })).toMatchObject({
      ref: { providerId: 'primary', modelId: 'chat' },
      upstreamModel: 'wire-chat',
      configRevision: 12,
      modelDefinition: {
        limits: { contextWindow: 8_000, maxOutputTokens: 2_000 },
      },
      ai: {
        generationDefaults: { maxOutputTokens: 2_000 },
      },
    });
    expect(findCompiledTarget(snapshot, { providerId: 'primary', modelId: 'missing' })).toBeUndefined();
  });

  it('keeps an in-flight snapshot stable after atomic publication', () => {
    const drivers = new DriverRegistry();
    drivers.register(createFakeDriver());
    const store = new RuntimeSnapshotStore();
    store.publish(compileInferenceConfig(testConfig({ revision: 1 }), testCatalog(), drivers));
    const captured = store.capture();

    store.publish(compileInferenceConfig(testConfig({ revision: 2 }), testCatalog(), drivers));

    expect(captured?.configRevision).toBe(1);
    expect(store.capture()?.configRevision).toBe(2);
  });

  it('keeps valid targets when a sibling binding is unavailable', () => {
    const drivers = new DriverRegistry();
    drivers.register(createFakeDriver());
    const config = testConfig();
    config.providers.primary!.models.broken = {
      ...config.providers.primary!.models.chat!,
      catalogId: 'missing/model',
    };

    const snapshot = compileInferenceConfig(config, testCatalog(), drivers);

    expect(findCompiledTarget(snapshot, { providerId: 'primary', modelId: 'chat' })).toBeDefined();
    expect(findCompiledTarget(snapshot, { providerId: 'primary', modelId: 'broken' })).toBeUndefined();
  });

  it('does not compile an AI target whose context window is missing', () => {
    const drivers = new DriverRegistry();
    drivers.register(createFakeDriver());
    const snapshot = compileInferenceConfig(
      testConfig(),
      testCatalog(testModel({ limits: {} })),
      drivers,
    );

    expect(findCompiledTarget(snapshot, { providerId: 'primary', modelId: 'chat' })).toBeUndefined();
  });
});
