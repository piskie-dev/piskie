import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { testModel } from '../../control/__tests__/fixtures.js';
import { CanonicalCatalogSource } from '../canonical-source.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

describe('CanonicalCatalogSource', () => {
  it('loads only the bundled base and ConfigHost-owned model-catalog document', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-canonical-catalog-'));
    directories.push(root);
    const source = new CanonicalCatalogSource({
      rootDirectory: root,
      now: () => new Date('2026-08-06T00:00:00.000Z'),
    });
    await fs.mkdir(path.dirname(source.paths.baseFile), { recursive: true });
    await fs.mkdir(path.dirname(source.paths.overlayFile), { recursive: true });
    await fs.writeFile(source.paths.baseFile, JSON.stringify({
      version: 'base:1',
      models: [testModel({ id: 'bundled/chat', source: { kind: 'bundled', version: 'base:1' } })],
    }));
    await fs.writeFile(source.paths.overlayFile, JSON.stringify({
      version: 'local:1',
      revision: 1,
      models: [testModel({ id: 'local/chat', source: { kind: 'local', version: 'local:1' } })],
    }));
    await fs.writeFile(path.join(root, 'catalog', 'models.local.json'), '{ invalid legacy Catalog');

    const snapshot = await source.load();

    expect(snapshot.version).toBe('base:1+local:1');
    expect([...snapshot.models.keys()]).toEqual(['bundled/chat', 'local/chat']);
  });

  it('validates an unpublished candidate without reading or replacing the canonical overlay', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-canonical-catalog-candidate-'));
    directories.push(root);
    const source = new CanonicalCatalogSource({
      rootDirectory: path.relative(process.cwd(), root),
    });
    await fs.mkdir(path.dirname(source.paths.baseFile), { recursive: true });
    await fs.mkdir(path.dirname(source.paths.overlayFile), { recursive: true });
    await fs.writeFile(source.paths.baseFile, JSON.stringify({
      version: 'base:1',
      models: [testModel({ id: 'bundled/chat', source: { kind: 'bundled', version: 'base:1' } })],
    }));
    const persisted = JSON.stringify({ version: 'local:0', revision: 0, models: [] });
    await fs.writeFile(source.paths.overlayFile, persisted);

    const snapshot = await source.loadCandidate({
      version: 'local:1',
      revision: 1,
      models: [testModel({ id: 'candidate/chat', source: { kind: 'local', version: 'local:1' } })],
    });

    expect(snapshot.models.has('candidate/chat')).toBe(true);
    expect(await fs.readFile(source.paths.overlayFile, 'utf8')).toBe(persisted);
  });
});
