import { describe, expect, it } from 'vitest';
import { DriverRegistry } from '../../drivers/registry.js';
import { createFakeDriver } from './fake-driver.js';
import { testCatalog, testConfig } from './fixtures.js';
import { parseInferenceConfig, validateInferenceSemantics } from '../validation.js';
import { inferenceConfigJsonSchema, inferenceConfigWriteSchema } from '../config-schema.js';

function registry(): DriverRegistry {
  const result = new DriverRegistry();
  result.register(createFakeDriver());
  return result;
}

describe('inference config validation', () => {
  it('keeps plaintext authentication and headers intact', () => {
    const config = testConfig();
    const result = parseInferenceConfig(JSON.parse(JSON.stringify(config)));

    expect(result.report.valid).toBe(true);
    expect(result.config?.providers.primary.connection.auth).toEqual({
      kind: 'bearer',
      value: 'sk-plaintext-secret',
    });
    expect(result.config?.providers.primary.connection.headers).toEqual({
      'X-Custom': 'plain-header-secret',
    });
  });

  it('rejects unknown fields outside the registered config contract', () => {
    const result = parseInferenceConfig({ ...testConfig(), routes: { default: 'forbidden' } });

    expect(result.report.valid).toBe(false);
    expect(result.config).toBeUndefined();
  });

  it('rejects the retired first-event timeout on new writes', () => {
    const config = testConfig();
    const candidate = {
      providers: config.providers,
      policies: structuredClone(config.policies),
    };
    Object.assign(candidate.policies.ai, { firstEventTimeoutMs: 60_000 });

    expect(inferenceConfigWriteSchema.safeParse(candidate).success).toBe(false);
  });

  it('still rejects invalid values for known fields', () => {
    const result = parseInferenceConfig({ ...testConfig(), revision: 'four' });

    expect(result.report).toMatchObject({
      valid: false,
      issues: [{ code: 'CONFIG_INVALID_TYPE', path: '/revision' }],
    });
  });

  it('describes the image timeout semantics for AI configuration clients', () => {
    const schema = inferenceConfigJsonSchema() as {
      properties?: {
        policies?: {
          properties?: {
            image?: {
              properties?: Record<string, { description?: string }>;
            };
          };
        };
      };
    };
    const image = schema.properties?.policies?.properties?.image?.properties;

    expect(image?.operationTimeoutMs?.description).toContain('synchronous OpenAI-compatible');
    expect(image?.submitTimeoutMs?.description).toContain('do not use this deadline');
  });

  it('does not turn a false catalog capability into an execution gate', () => {
    const report = validateInferenceSemantics(testConfig(), testCatalog(), registry());

    expect(testCatalog().models.get('custom/chat')?.capabilities.tools).toBe(false);
    expect(report).toEqual({ valid: true, issues: [] });
  });

  it('marks a dangling catalog binding unavailable without rejecting other models', () => {
    const config = testConfig();
    config.providers.primary.models.chat.catalogId = 'missing/model';
    const report = validateInferenceSemantics(config, testCatalog(), registry());

    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'CATALOG_MODEL_NOT_FOUND',
      path: '/providers/primary/models/chat/catalogId',
      severity: 'warning',
    }));
    expect(report.valid).toBe(true);
  });

  it('marks an AI model without an explicit context window unavailable', () => {
    const catalog = testCatalog();
    const model = catalog.models.get('custom/chat')!;
    catalog.models = new Map([['custom/chat', { ...model, limits: {} }]]);

    const report = validateInferenceSemantics(testConfig(), catalog, registry());

    expect(report).toMatchObject({
      valid: true,
      issues: [{
        code: 'MODEL_CONTEXT_WINDOW_MISSING',
        path: '/providers/primary/models/chat/catalogId',
        severity: 'warning',
      }],
    });
  });
});
