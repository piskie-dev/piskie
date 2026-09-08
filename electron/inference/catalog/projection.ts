import {
  type AIModelCatalogEntry,
  type GeneratedModelCatalog,
  type ImageModelCatalogEntry,
  type ModelCatalogEntry,
} from '../../../shared/ai-model-catalog/index.js';
import { normalizeReasoningProfile } from '../../../shared/ai-model-catalog/reasoning-presets.js';
import type { CatalogDocument, ModelDefinition } from './contracts.js';

type Provenance = ModelDefinition['source'];

const ANTHROPIC_MESSAGE_PROVIDERS = new Set([
  'anthropic',
  'deepseek',
  'zhipu',
  'minimax',
  'aliyun',
  'volcengine',
  'baidu',
  'fireworks',
]);

const IMAGE_DRIVER_BY_PROVIDER: Readonly<Record<string, string>> = {
  openai: 'openai',
  openrouter: 'openrouter-image',
  gemini: 'gemini-image',
  aliyun: 'dashscope-image',
  baidu: 'baidu-image',
  zhipu: 'openai',
};

export function inferenceCatalogVersion(catalog: GeneratedModelCatalog): string {
  return `piskie-inference-v3:${catalog.version}:${catalog.contentHash.slice(0, 16)}`;
}

export function projectInferenceCatalog(
  catalog: GeneratedModelCatalog,
  kind: 'bundled' | 'remote',
): CatalogDocument {
  const models: ModelDefinition[] = [];
  for (const [providerId, provider] of Object.entries(catalog.providers)) {
    if (!provider) continue;
    for (const entry of provider.models) {
      models.push(projectModel(providerId, entry, {
        kind,
        version: `${catalog.version}:${catalog.contentHash.slice(0, 16)}`,
        updatedAt: entry.provenance.verifiedAt,
      }));
    }
  }
  return {
    version: inferenceCatalogVersion(catalog),
    models: models.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function projectModel(providerId: string, entry: ModelCatalogEntry, source: Provenance): ModelDefinition {
  if (entry.kind === 'image') return projectImageModel(providerId, entry, source);
  return projectAIModel(providerId, entry, source);
}

function projectAIModel(providerId: string, entry: AIModelCatalogEntry, source: Provenance): ModelDefinition {
  const vision = capability(entry.capabilityProfile.vision);
  const tools = capability(entry.capabilityProfile.toolUse);
  const streaming = capability(entry.capabilityProfile.streaming);
  const reasoningProfile = providerId === 'xai' ? entry.reasoning : normalizeReasoningProfile(entry.reasoning);
  const reasoning = reasoningProfile.mode !== 'none';
  return {
    id: `${providerId}/${entry.id}`,
    displayName: entry.name,
    kind: 'ai',
    family: providerId,
    ...(entry.releaseDate && { releaseDate: entry.releaseDate }),
    lifecycle: entry.lifecycle,
    compatibleDrivers: ANTHROPIC_MESSAGE_PROVIDERS.has(providerId)
      ? ['anthropic-messages']
      : ['openai'],
    inputModalities: ['text', ...(vision === true ? ['image'] : [])],
    outputModalities: ['text'],
    capabilities: {
      ...(streaming !== undefined && { streaming }),
      ...(tools !== undefined && { tools }),
      ...(vision !== undefined && { vision }),
      reasoning,
    },
    reasoning: structuredClone(reasoningProfile),
    limits: {
      ...(entry.contextWindow && { contextWindow: entry.contextWindow }),
      ...(entry.maxOutputTokens && { maxOutputTokens: entry.maxOutputTokens }),
    },
    ...(entry.pricing && {
      pricing: Object.fromEntries(
        Object.entries(entry.pricing).filter((item): item is [string, number] => typeof item[1] === 'number'),
      ),
    }),
    source,
  };
}

function projectImageModel(providerId: string, entry: ImageModelCatalogEntry, source: Provenance): ModelDefinition {
  return {
    id: `${providerId}/${entry.id}`,
    displayName: entry.name,
    kind: 'image',
    family: providerId,
    ...(entry.releaseDate && { releaseDate: entry.releaseDate }),
    lifecycle: entry.lifecycle,
    compatibleDrivers: [IMAGE_DRIVER_BY_PROVIDER[providerId] ?? 'openai'],
    inputModalities: entry.inputModalities,
    outputModalities: entry.outputModalities,
    capabilities: {
      ...(capability(entry.capabilityProfile.generate) !== undefined && {
        generate: capability(entry.capabilityProfile.generate),
      }),
      ...(capability(entry.capabilityProfile.edit) !== undefined && {
        edit: capability(entry.capabilityProfile.edit),
      }),
      ...(capability(entry.capabilityProfile.referenceImages) !== undefined && {
        referenceImages: capability(entry.capabilityProfile.referenceImages),
      }),
      ...(capability(entry.capabilityProfile.mask) !== undefined && {
        mask: capability(entry.capabilityProfile.mask),
      }),
    },
    limits: entry.limits ?? {},
    ...(entry.pricing && {
      pricing: Object.fromEntries(
        Object.entries(entry.pricing).filter((item): item is [string, number] => typeof item[1] === 'number'),
      ),
    }),
    source,
  };
}

function capability(value: 'supported' | 'unsupported' | 'unknown'): boolean | undefined {
  if (value === 'supported') return true;
  if (value === 'unsupported') return false;
  return undefined;
}
