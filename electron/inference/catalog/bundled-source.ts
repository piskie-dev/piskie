import fs from 'node:fs/promises';
import path from 'node:path';
import { BUNDLED_MODEL_CATALOG } from '../../../shared/ai-model-catalog/bundled.js';
import { configFileWriter } from '../../config/core/atomic-file-writer.js';
import { catalogDocumentSchema, type CatalogDocument } from './contracts.js';

export interface BundledCatalogPaths {
  baseFile: string;
  overlayFile: string;
}

/** Manifest of the signed website publication bundled with this build. */
export const bundledCatalogManifest = BUNDLED_MODEL_CATALOG.manifest;

export function bundledCatalogPaths(rootDirectory: string): BundledCatalogPaths {
  return {
    baseFile: path.join(rootDirectory, 'catalog', 'models.json'),
    overlayFile: path.join(rootDirectory, 'config', 'model-catalog.json'),
  };
}

/** The bundled publication with its provenance marked as shipped rather than downloaded. */
export function bundledInferenceCatalog(): CatalogDocument {
  const document = catalogDocumentSchema.parse(BUNDLED_MODEL_CATALOG.document);
  return {
    version: document.version,
    models: document.models.map((model) => ({
      ...model,
      source: { ...model.source, kind: 'bundled' as const },
    })),
  };
}

export async function ensureBundledInferenceCatalog(rootDirectory: string): Promise<BundledCatalogPaths> {
  const paths = bundledCatalogPaths(rootDirectory);
  let currentVersion: unknown;
  try {
    currentVersion = JSON.parse(await fs.readFile(paths.baseFile, 'utf8')).version;
  } catch {
    currentVersion = undefined;
  }
  if (currentVersion !== bundledCatalogManifest.version) {
    await configFileWriter.replace(paths.baseFile, `${JSON.stringify(bundledInferenceCatalog(), null, 2)}\n`);
  }
  return paths;
}
