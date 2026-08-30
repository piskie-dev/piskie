import fs from 'node:fs/promises';
import path from 'node:path';
import {
  AI_MODEL_CATALOG,
  type AIModelCatalogEntry,
  type ImageModelCatalogEntry,
  type ModelCatalogEntry,
} from '../../../shared/ai-model-catalog/index.js';
import { normalizeReasoningProfile } from '../../../shared/ai-model-catalog/reasoning-presets.js';
import { configFileWriter } from '../../config/core/atomic-file-writer.js';
import type { CatalogDocument, ModelDefinition } from './contracts.js';

const BUNDLED_SOURCE_VERSION = `${AI_MODEL_CATALOG.version}:${AI_MODEL_CATALOG.contentHash.slice(0, 16)}`;
const BUNDLED_VERSION = `piskie-inference-v3:${BUNDLED_SOURCE_VERSION}`;

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

export interface BundledCatalogPaths {
  baseFile: string;
  overlayFile: string;
}

export function bundledCatalogPaths(rootDirectory: string): BundledCatalogPaths {
  return {
    baseFile: path.join(rootDirectory, 'catalog', 'models.json'),
    overlayFile: path.join(rootDirectory, 'config', 'model-catalog.json'),
  };
}

export async function ensureBundledInferenceCatalog(rootDirectory: string): Promise<BundledCatalogPaths> {
  const paths = bundledCatalogPaths(rootDirectory);
  const currentVersion = await readVersion(paths.baseFile);
  if (currentVersion !== BUNDLED_VERSION) {
    await configFileWriter.replace(
      paths.baseFile,
      `${JSON.stringify(bundledInferenceCatalog(), null, 2)}\n`,
    );
  }
  return paths;
}

export function bundledInferenceCatalog(): CatalogDocument {
  const models: ModelDefinition[] = [];
  for (const [providerId, provider] of Object.entries(AI_MODEL_CATALOG.providers)) {
    if (!provider) continue;
    for (const entry of provider.models) models.push(projectModel(providerId, entry));
  }
  return {
    version: BUNDLED_VERSION,
    models: models.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function projectModel(providerId: string, entry: ModelCatalogEntry): ModelDefinition {
  if (entry.kind === 'image') return projectImageModel(providerId, entry);
  return projectAIModel(providerId, entry);
}

function projectAIModel(providerId: string, entry: AIModelCatalogEntry): ModelDefinition {
  const vision = capability(entry.capabilityProfile.vision);
  const tools = capability(entry.capabilityProfile.toolUse);
  const streaming = capability(entry.capabilityProfile.streaming);
  const reasoningProfile = normalizeReasoningProfile(entry.reasoning);
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
    source: {
      kind: 'bundled',
      version: BUNDLED_SOURCE_VERSION,
      updatedAt: entry.provenance.verifiedAt,
    },
  };
}

function projectImageModel(providerId: string, entry: ImageModelCatalogEntry): ModelDefinition {
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
    source: {
      kind: 'bundled',
      version: BUNDLED_SOURCE_VERSION,
      updatedAt: entry.provenance.verifiedAt,
    },
  };
}

function capability(value: 'supported' | 'unsupported' | 'unknown'): boolean | undefined {
  if (value === 'supported') return true;
  if (value === 'unsupported') return false;
  return undefined;
}

async function readVersion(filePath: string): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await fs.readFile(filePath, 'utf8')) as { version?: unknown };
    return typeof raw.version === 'string' ? raw.version : undefined;
  } catch {
    return undefined;
  }
}
