#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const providersDir = path.join(root, 'shared/ai-model-catalog/providers');
const outputPath = path.join(root, 'shared/ai-model-catalog/generated/catalog.json');
const check = process.argv.includes('--check');

function validateProviderCatalog(catalog, filename) {
  if (!catalog.provider || !catalog.version || !catalog.verifiedAt || !Array.isArray(catalog.models)) {
    throw new Error(`${filename}: invalid provider catalog header`);
  }
  const ids = new Set();
  for (const model of catalog.models) {
    if (!model.id || !model.name || model.provider !== catalog.provider) {
      throw new Error(`${filename}: invalid model entry ${model.id ?? '<missing>'}`);
    }
    if (ids.has(model.id)) throw new Error(`${filename}: duplicate model id ${model.id}`);
    ids.add(model.id);
    if (model.releaseDate && !/^\d{4}-\d{2}-\d{2}$/.test(model.releaseDate)) {
      throw new Error(`${filename}: invalid release date for ${model.id}: ${model.releaseDate}`);
    }
    if (model.kind === 'image') {
      if (!model.outputModalities?.includes('image') || !model.capabilityProfile?.generate) {
        throw new Error(`${filename}: invalid image model entry ${model.id}`);
      }
    } else if (!model.reasoning?.defaultSelection || !Array.isArray(model.reasoning.options)) {
      throw new Error(`${filename}: missing reasoning profile for ${model.id}`);
    }
    if (!model.provenance?.sourceUrls?.length || !model.provenance?.verifiedAt) {
      throw new Error(`${filename}: missing provenance for ${model.id}`);
    }
  }
}

const files = (await fs.readdir(providersDir)).filter((file) => file.endsWith('.json')).sort();
const providers = {};
let version = '';
for (const file of files) {
  const catalog = JSON.parse(await fs.readFile(path.join(providersDir, file), 'utf8'));
  validateProviderCatalog(catalog, file);
  providers[catalog.provider] = catalog;
  if (!version || catalog.version > version) version = catalog.version;
}

const contentHash = createHash('sha256').update(JSON.stringify(providers)).digest('hex');
const generated = {
  version,
  contentHash,
  generatedAt: `${version.slice(0, 10).replaceAll('.', '-') || '1970-01-01'}T00:00:00.000Z`,
  providers,
};
const next = `${JSON.stringify(generated, null, 2)}\n`;

if (check) {
  const current = await fs.readFile(outputPath, 'utf8').catch(() => '');
  if (current !== next) throw new Error('Generated model catalog is out of date; run npm run catalog:generate');
} else {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, next);
}
