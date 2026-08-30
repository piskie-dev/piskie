import type { CatalogSnapshot, ModelDefinition } from '../../catalog/contracts.js';
import type { InferenceConfig } from '../config-schema.js';

export function testModel(overrides: Partial<ModelDefinition> = {}): ModelDefinition {
  return {
    id: 'custom/chat',
    displayName: 'Test Chat',
    kind: 'ai',
    lifecycle: 'active',
    compatibleDrivers: ['fake'],
    inputModalities: ['text'],
    outputModalities: ['text'],
    capabilities: { streaming: true, tools: false },
    limits: { contextWindow: 8_000 },
    source: { kind: 'local', version: '1' },
    ...overrides,
  };
}

export function testCatalog(model: ModelDefinition = testModel()): CatalogSnapshot {
  return {
    version: 'test-catalog',
    loadedAt: '2026-07-29T00:00:00.000Z',
    models: new Map([[model.id, model]]),
  };
}

export function testConfig(overrides: Partial<InferenceConfig> = {}): InferenceConfig {
  return {
    schemaVersion: 1,
    revision: 0,
    providers: {
      primary: {
        displayName: 'Primary',
        driver: 'fake',
        enabled: true,
        connection: {
          baseUrl: 'https://example.test/v1',
          auth: { kind: 'bearer', value: 'sk-plaintext-secret' },
          headers: { 'X-Custom': 'plain-header-secret' },
          proxyId: null,
        },
        models: {
          chat: {
            catalogId: 'custom/chat',
            upstreamId: 'wire-chat',
            enabled: true,
            options: {},
          },
        },
        driverOptions: {},
      },
    },
    policies: {
      ai: {
        maxAttempts: 3,
        connectTimeoutMs: 30_000,
        streamIdleTimeoutMs: 300_000,
        retryBaseDelayMs: 250,
      },
      image: {
        maxSubmitAttempts: 2,
        submitTimeoutMs: 60_000,
        operationTimeoutMs: 600_000,
        allowResubmitAfterAccepted: false,
      },
    },
    ...overrides,
  };
}
