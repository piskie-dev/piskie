#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PISKIE_TO_MODELS_DEV_PROVIDER,
  MODELS_DEV_URL,
} from './models-dev-config.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const providerDir = path.join(root, 'shared/ai-model-catalog/providers');
const selectionPath = path.join(import.meta.dirname, 'models-dev-selection.json');
const selection = JSON.parse(await fs.readFile(selectionPath, 'utf8'));

const catalogProviders = new Set(
  (await fs.readdir(providerDir))
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -5)),
);
const missingCatalogs = Object.keys(PISKIE_TO_MODELS_DEV_PROVIDER)
  .filter((provider) => !catalogProviders.has(provider));
if (missingCatalogs.length > 0) {
  throw new Error(`models.dev mapped providers missing catalogs: ${missingCatalogs.join(', ')}`);
}

const response = await fetch(MODELS_DEV_URL, {
  headers: { 'user-agent': 'piskie-model-catalog-sync' },
});
if (!response.ok) throw new Error(`models.dev: HTTP ${response.status}`);
const sourceText = await response.text();
const source = JSON.parse(sourceText);
const sourceHash = createHash('sha256').update(sourceText).digest('hex');

function state(value) {
  if (value === true) return 'supported';
  if (value === false) return 'unsupported';
  return 'unknown';
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeReleaseDate(value) {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (/^\d{4}-\d{2}$/.test(value)) return `${value}-01`;
  if (/^\d{4}$/.test(value)) return `${value}-01-01`;
  throw new Error(`models.dev returned an invalid release date: ${value}`);
}

const noReasoning = {
  mode: 'none',
  options: [{ kind: 'provider-default' }],
  defaultSelection: { kind: 'provider-default' },
  mandatory: false,
  transportPreset: 'none',
  replayPolicy: 'none',
};

const reasoningTransports = {
  openai: ['openai-effort', 'opaque-required'],
  anthropic: ['anthropic-adaptive-effort', 'visible'],
  gemini: ['gemini-effort', 'visible'],
  deepseek: ['deepseek-thinking', 'opaque-required'],
  zhipu: ['deepseek-thinking', 'opaque-required'],
  minimax: ['minimax-thinking', 'opaque-required'],
  aliyun: ['dashscope-enable-thinking', 'opaque-required'],
  bedrock: ['anthropic-adaptive-effort', 'visible'],
  fireworks: ['fireworks-reasoning', 'opaque-required'],
  groq: ['openai-effort', 'opaque-required'],
  together: ['together-reasoning', 'opaque-required'],
  openrouter: ['openrouter-reasoning', 'opaque-required'],
};

function reasoningFor(provider, sourceModel, existingReasoning) {
  if (existingReasoning) return existingReasoning;
  if (!sourceModel.reasoning) return noReasoning;
  const [transportPreset, replayPolicy] = reasoningTransports[provider] ?? ['none', 'none'];
  const options = sourceModel.reasoning_options ?? [];
  const effortOption = options.find((option) => option.type === 'effort');
  const hasToggle = options.some((option) => option.type === 'toggle');
  const efforts = (effortOption?.values ?? [])
    .filter((value) => ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value));

  // Toggle-capable transports must not expose fake effort levels that the adapter collapses.
  if (hasToggle || ['deepseek', 'zhipu', 'minimax', 'aliyun', 'fireworks', 'together'].includes(provider)) {
    return {
      mode: 'toggle',
      options: [{ kind: 'disabled' }, { kind: 'enabled' }],
      defaultSelection: { kind: 'enabled' },
      mandatory: false,
      transportPreset,
      replayPolicy,
    };
  }
  if (efforts.length > 0) {
    const selections = efforts.map((effort) => effort === 'none'
      ? { kind: 'disabled' }
      : { kind: 'effort', effort });
    const preferred = ['medium', 'high', 'low'].find((effort) => efforts.includes(effort));
    return {
      mode: 'effort',
      options: selections,
      defaultSelection: preferred ? { kind: 'effort', effort: preferred } : selections[0],
      mandatory: !efforts.includes('none'),
      transportPreset,
      replayPolicy,
    };
  }
  return {
    mode: 'toggle',
    options: [{ kind: 'disabled' }, { kind: 'enabled' }],
    defaultSelection: { kind: 'enabled' },
    mandatory: false,
    transportPreset,
    replayPolicy,
  };
}

function selectedModels(sourceModels) {
  return sourceModels
    .filter((model) => {
      const output = model.modalities?.output ?? ['text'];
      return output.includes(selection.policy.outputModality)
        && (!selection.policy.requireExclusiveOutputModality
          || output.every((modality) => modality === selection.policy.outputModality));
    })
    .filter((model) => !selection.policy.requireToolCall || model.tool_call === true)
    .sort((left, right) => (
      String(right.release_date ?? '').localeCompare(String(left.release_date ?? ''))
      || left.id.localeCompare(right.id)
    ));
}

function toEntry(provider, sourceModel, base) {
  const existingReasoning = base?.id === sourceModel.id ? base.reasoning : undefined;
  const reasoning = reasoningFor(provider, sourceModel, existingReasoning);
  const releaseDate = normalizeReleaseDate(sourceModel.release_date);
  const inputModalities = sourceModel.modalities?.input ?? [];
  const contextWindow = sourceModel.limit?.context;
  const maxOutputTokens = sourceModel.limit?.output;
  return {
    ...base,
    id: sourceModel.id,
    name: sourceModel.name || base.name || sourceModel.id,
    provider,
    capabilityProfile: {
      toolUse: state(sourceModel.tool_call),
      // attachment only means file attachment support; vision requires image input explicitly.
      vision: state(inputModalities.includes('image')),
      // models.dev currently has no dedicated streaming field; keep only a model-specific verified override.
      streaming: base?.capabilityProfile?.streaming ?? 'unknown',
    },
    reasoning,
    lifecycle: base?.lifecycle ?? 'active',
    ...(releaseDate ? { releaseDate } : {}),
    ...(contextWindow ? { contextWindow, maxContextWindow: contextWindow } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(base?.tags ? { tags: base.tags } : {}),
    ...(sourceModel.cost ? {
      pricing: {
        inputPerMillion: sourceModel.cost.input,
        outputPerMillion: sourceModel.cost.output,
      },
    } : {}),
    provenance: {
      sourceUrls: unique([
        'https://models.dev',
        ...(base?.provenance?.sourceUrls ?? []),
      ]),
      verifiedAt: selection.verifiedAt,
      catalogVersion: selection.version,
    },
  };
}

for (const [provider, sourceProviderId] of Object.entries(PISKIE_TO_MODELS_DEV_PROVIDER)) {
  const sourceProvider = source[sourceProviderId];
  if (!sourceProvider) throw new Error(`${provider}: models.dev provider ${sourceProviderId} not found`);

  const filePath = path.join(providerDir, `${provider}.json`);
  const current = JSON.parse(await fs.readFile(filePath, 'utf8'));
  const currentAiModels = current.models.filter((model) => model.kind !== 'image');
  const currentImageModels = current.models.filter((model) => model.kind === 'image');
  const currentById = new Map(currentAiModels.map((model) => [model.id, model]));
  const sourceModels = Object.values(sourceProvider.models ?? {});
  if (sourceModels.length === 0) throw new Error(`${provider}: models.dev returned an empty inventory`);
  const nextModels = selectedModels(sourceModels).map((sourceModel) => {
    const base = currentById.get(sourceModel.id) ?? {};
    return toEntry(provider, sourceModel, base);
  });
  if (nextModels.length === 0) throw new Error(`${provider}: unified selection returned no compatible models`);

  const next = {
    ...current,
    version: selection.version,
    verifiedAt: selection.verifiedAt,
    sourceUrls: unique(['https://models.dev', ...current.sourceUrls]),
    inventorySource: {
      id: 'models.dev',
      url: MODELS_DEV_URL,
      sha256: sourceHash,
    },
    models: [...nextModels, ...currentImageModels],
  };
  await fs.writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`[catalog:sync] ${provider}: ${nextModels.length} models from models.dev (${sourceHash.slice(0, 12)})`);
}

for (const [provider, reason] of Object.entries(selection.fallbackProviders ?? {})) {
  console.log(`[catalog:sync] ${provider}: fallback (${reason})`);
}
