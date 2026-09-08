import fs from 'node:fs/promises';
import path from 'node:path';
import { AI_MODEL_CATALOG } from '../../../shared/ai-model-catalog/index.js';
import { configFileWriter } from '../../config/core/atomic-file-writer.js';
import { inferenceCatalogVersion, projectInferenceCatalog } from './projection.js';

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

export function bundledInferenceCatalog() {
  return projectInferenceCatalog(AI_MODEL_CATALOG, 'bundled');
}

export async function ensureBundledInferenceCatalog(rootDirectory: string): Promise<BundledCatalogPaths> {
  const paths = bundledCatalogPaths(rootDirectory);
  let currentVersion: unknown;
  try {
    currentVersion = JSON.parse(await fs.readFile(paths.baseFile, 'utf8')).version;
  } catch {
    currentVersion = undefined;
  }
  if (currentVersion !== inferenceCatalogVersion(AI_MODEL_CATALOG)) {
    await configFileWriter.replace(paths.baseFile, `${JSON.stringify(bundledInferenceCatalog(), null, 2)}\n`);
  }
  return paths;
}
