#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OFFICIAL_IMAGE_CATALOG_SOURCES } from './image-catalog-sources.mjs';
import { MODELS_DEV_URL } from './models-dev-config.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const providerCatalogDirectory = path.join(root, 'shared/ai-model-catalog/providers');

const modelsDevSources = [
  { provider: 'openai', modelsDevProvider: 'openai' },
  { provider: 'openrouter', modelsDevProvider: 'openrouter' },
  { provider: 'gemini', modelsDevProvider: 'google' },
];

const verifiedAt = new Date().toISOString().slice(0, 10);
const [modelsDevText, ...officialSourceTexts] = await Promise.all([
  fetchText('models.dev', MODELS_DEV_URL),
  ...OFFICIAL_IMAGE_CATALOG_SOURCES.map((source) => fetchText(source.id, source.url)),
]);
const inventory = JSON.parse(modelsDevText);
const modelsDevHash = sha256(modelsDevText);
const updates = [];

for (const source of modelsDevSources) {
  const provider = inventory[source.modelsDevProvider];
  if (!provider) throw new Error(`models.dev provider not found: ${source.modelsDevProvider}`);
  const imageModels = Object.values(provider.models ?? {})
    .filter((model) => model.modalities?.output?.includes('image'))
    .map((model) => projectModelsDevModel(source, model, verifiedAt, modelsDevHash))
    .sort((left, right) => (
      String(right.releaseDate ?? '').localeCompare(String(left.releaseDate ?? ''))
      || left.id.localeCompare(right.id)
    ));
  assertNonEmptyInventory(source.provider, imageModels);
  updates.push({
    provider: source.provider,
    source: { id: 'models.dev', url: MODELS_DEV_URL, sha256: modelsDevHash },
    imageModels,
  });
}

for (const [index, source] of OFFICIAL_IMAGE_CATALOG_SOURCES.entries()) {
  const sourceText = officialSourceTexts[index];
  const sourceHash = sha256(sourceText);
  const imageModels = source.parse(sourceText).map((model) => ({
    ...model,
    provider: source.provider,
    provenance: {
      sourceUrls: [source.url],
      verifiedAt,
      catalogVersion: `${source.id}:${sourceHash}`,
    },
  }));
  assertNonEmptyInventory(source.provider, imageModels);
  updates.push({
    provider: source.provider,
    source: { id: source.id, url: source.url, sha256: sourceHash },
    imageModels,
  });
}

// Resolve and validate every update before writing any catalog file.
const staged = [];
for (const update of updates) {
  const providerCatalogPath = path.join(providerCatalogDirectory, `${update.provider}.json`);
  const current = JSON.parse(await fs.readFile(providerCatalogPath, 'utf8'));
  const aiModels = current.models.filter((model) => model.kind !== 'image');
  const previousImageSourceUrls = new Set(
    current.models
      .filter((model) => model.kind === 'image')
      .flatMap((model) => model.provenance?.sourceUrls ?? []),
  );
  if (current.imageInventorySource?.url) previousImageSourceUrls.add(current.imageInventorySource.url);
  const ids = new Set(aiModels.map((model) => model.id));
  for (const model of update.imageModels) {
    if (ids.has(model.id)) throw new Error(`${update.provider} catalog contains duplicate model id: ${model.id}`);
    ids.add(model.id);
  }
  const document = {
    ...current,
    version: `${current.version.split('+image.')[0]}+image.${update.source.sha256.slice(0, 12)}`,
    verifiedAt,
    sourceUrls: [
      ...new Set([
        ...current.sourceUrls.filter((url) => !previousImageSourceUrls.has(url)),
        update.source.url,
      ]),
    ],
    imageInventorySource: update.source,
    models: [...aiModels, ...update.imageModels],
  };
  staged.push({ providerCatalogPath, document, update });
}

const temporaryPaths = [];
try {
  for (const { providerCatalogPath, document } of staged) {
    const temporaryPath = `${providerCatalogPath}.tmp-${process.pid}`;
    temporaryPaths.push(temporaryPath);
    await fs.writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`);
  }
  for (let index = 0; index < staged.length; index += 1) {
    await fs.rename(temporaryPaths[index], staged[index].providerCatalogPath);
  }
} finally {
  await Promise.all(temporaryPaths.map((temporaryPath) => fs.rm(temporaryPath, { force: true })));
}

for (const { update } of staged) {
  console.log(
    `[catalog:image] ${update.provider}: ${update.imageModels.length} image models `
      + `(${update.source.id}:${update.source.sha256.slice(0, 12)})`,
  );
}

function projectModelsDevModel(source, model, verifiedAt, sourceHash) {
  const inputModalities = model.modalities?.input ?? [];
  const outputModalities = model.modalities?.output ?? [];
  const acceptsImages = inputModalities.includes('image');
  const releaseDate = normalizeReleaseDate(model.release_date);
  return {
    id: model.id,
    name: model.name || model.id,
    provider: source.provider,
    kind: 'image',
    ...(releaseDate && { releaseDate }),
    lifecycle: 'active',
    inputModalities,
    outputModalities,
    capabilityProfile: {
      generate: 'supported',
      edit: acceptsImages ? 'supported' : 'unsupported',
      referenceImages: acceptsImages ? 'supported' : 'unsupported',
      mask: 'unknown',
    },
    provenance: {
      sourceUrls: ['https://models.dev'],
      verifiedAt,
      catalogVersion: `models.dev-image:${sourceHash}`,
    },
  };
}

async function fetchText(sourceName, url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'piskie-image-model-catalog-sync' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${sourceName}: HTTP ${response.status}`);
  const text = await response.text();
  if (!text.trim()) throw new Error(`${sourceName}: empty response`);
  return text;
}

function assertNonEmptyInventory(provider, imageModels) {
  if (imageModels.length === 0) {
    throw new Error(`${provider}: image source returned an empty inventory; existing catalog was preserved`);
  }
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function normalizeReleaseDate(value) {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (/^\d{4}-\d{2}$/.test(value)) return `${value}-01`;
  if (/^\d{4}$/.test(value)) return `${value}-01-01`;
  throw new Error(`models.dev returned an invalid release date: ${value}`);
}
