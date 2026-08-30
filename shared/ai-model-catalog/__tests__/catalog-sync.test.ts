import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import syncSelection from '../../../scripts/model-catalog/models-dev-selection.json' with { type: 'json' };
import { AI_MODEL_CATALOG } from '../index.js';

const syncedProviders = [
  'openai',
  'anthropic',
  'gemini',
  'deepseek',
  'zhipu',
  'minimax',
  'aliyun',
  'bedrock',
  'fireworks',
  'groq',
  'together',
  'openrouter',
] as const;

describe('models.dev catalog sync', () => {
  it('versions the bundled snapshot by the complete unified provider content', () => {
    const expected = createHash('sha256')
      .update(JSON.stringify(AI_MODEL_CATALOG.providers))
      .digest('hex');

    expect(AI_MODEL_CATALOG.contentHash).toBe(expected);
  });

  it('records models.dev provenance for every mapped provider', () => {
    for (const provider of syncedProviders) {
      const catalog = AI_MODEL_CATALOG.providers[provider];
      const aiModels = catalog?.models.filter((model) => model.kind !== 'image') ?? [];
      expect(aiModels.length, provider).toBeGreaterThan(0);
      expect(catalog?.inventorySource, provider).toMatchObject({
        id: 'models.dev',
        url: 'https://models.dev/api.json',
      });
      expect(catalog?.inventorySource?.sha256, provider).toMatch(/^[a-f0-9]{64}$/);
      expect(new Set(catalog?.models.map((model) => model.id)).size, provider)
        .toBe(catalog?.models.length);
      expect(aiModels.every((model) => /^\d{4}-\d{2}-\d{2}$/.test(model.releaseDate ?? '')), provider)
        .toBe(true);
    }
  });

  it('uses one global compatibility policy without provider-specific selections', () => {
    expect(syncSelection).not.toHaveProperty('providers');
    expect(syncSelection.policy).toEqual({
      outputModality: 'text',
      requireExclusiveOutputModality: true,
      requireToolCall: true,
    });

    const minimumInventory = {
      openai: 37,
      anthropic: 13,
      gemini: 16,
      zhipu: 13,
      bedrock: 100,
      fireworks: 16,
      groq: 6,
      together: 26,
      openrouter: 250,
    } as const;
    for (const [provider, minimum] of Object.entries(minimumInventory)) {
      const models = AI_MODEL_CATALOG.providers[provider as keyof typeof minimumInventory]?.models
        .filter((model) => model.kind !== 'image');
      expect(models?.length, provider)
        .toBeGreaterThanOrEqual(minimum);
    }
  });

  it('publishes the complete compatible OpenAI inventory without model-id exceptions', () => {
    const models = (AI_MODEL_CATALOG.providers.openai?.models ?? [])
      .filter((model) => model.kind !== 'image');
    const ids = models.map((model) => model.id);
    expect(ids).toEqual(expect.arrayContaining([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.6',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex',
    ]));
    expect(models.length).toBeGreaterThanOrEqual(37);
  });

  it('derives vision support from explicit image input instead of attachment support', () => {
    const visionCases = [
      ['deepseek', 'deepseek-chat', 'unsupported'],
      ['deepseek', 'deepseek-reasoner', 'unsupported'],
      ['fireworks', 'accounts/fireworks/models/minimax-m3', 'supported'],
    ] as const;

    for (const [provider, modelId, expected] of visionCases) {
      const model = AI_MODEL_CATALOG.providers[provider]?.models
        .find((entry) => entry.kind !== 'image' && entry.id === modelId);
      expect(model?.kind === 'image' ? undefined : model?.capabilityProfile.vision, `${provider}:${modelId}`)
        .toBe(expected);
    }
  });

  it('keeps image models in the same provider model list without static model ids', () => {
    const provider = AI_MODEL_CATALOG.providers.openai;
    const imageModels = provider?.models.filter((model) => model.kind === 'image') ?? [];

    expect(provider?.imageInventorySource).toMatchObject({
      id: 'models.dev',
      url: 'https://models.dev/api.json',
    });
    expect(imageModels.length).toBeGreaterThan(0);
    expect(imageModels.every((model) => model.outputModalities.includes('image'))).toBe(true);
  });

  it('records official image inventories for providers absent from models.dev image metadata', () => {
    const expectedSources = {
      aliyun: 'aliyun-docs',
      baidu: 'baidu-docs',
      zhipu: 'zhipu-docs',
    } as const;

    for (const [providerId, sourceId] of Object.entries(expectedSources)) {
      const provider = AI_MODEL_CATALOG.providers[providerId as keyof typeof expectedSources];
      const imageModels = provider?.models.filter((model) => model.kind === 'image') ?? [];
      expect(provider?.imageInventorySource?.id, providerId).toBe(sourceId);
      expect(provider?.imageInventorySource?.sha256, providerId).toMatch(/^[a-f0-9]{64}$/);
      expect(imageModels.length, providerId).toBeGreaterThan(0);
      expect(imageModels.every((model) => model.provenance.catalogVersion.startsWith(`${sourceId}:`)), providerId)
        .toBe(true);
    }
  });
});
