import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bundledCatalogManifest,
  bundledInferenceCatalog,
  ensureBundledInferenceCatalog,
} from '../bundled-source.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe('bundled inference catalog', () => {
  it('rewrites a stale base snapshot when the bundled publication changes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-bundled-catalog-'));
    directories.push(root);
    const catalogDirectory = path.join(root, 'catalog');
    const baseFile = path.join(catalogDirectory, 'models.json');
    await fs.mkdir(catalogDirectory, { recursive: true });
    await fs.writeFile(baseFile, JSON.stringify({
      version: 'catalog-v1:2026-01-01:0000000000000000',
      models: [],
    }));

    const paths = await ensureBundledInferenceCatalog(root);
    const stored = JSON.parse(await fs.readFile(paths.baseFile, 'utf8')) as {
      version: string;
      models: unknown[];
    };

    expect(stored.version).toBe(bundledCatalogManifest.version);
    expect(stored.models.length).toBeGreaterThan(0);
  });

  it('ships the published document with bundled provenance', () => {
    const catalog = bundledInferenceCatalog();

    expect(catalog.version).toBe(bundledCatalogManifest.version);
    expect(catalog.models.length).toBeGreaterThan(0);
    expect(new Set(catalog.models.map((model) => model.source.kind))).toEqual(new Set(['bundled']));
    expect(catalog.models.every((model) => model.source.version.length > 0)).toBe(true);
  });
});
