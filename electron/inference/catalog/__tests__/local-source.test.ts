import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CatalogLoadError, LocalCatalogSource } from '../local-source.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function temporaryCatalog(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-catalog-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('LocalCatalogSource', () => {
  it('merges local capabilities without inheriting operational limits', async () => {
    const root = await temporaryCatalog();
    await fs.writeFile(path.join(root, 'base.json'), JSON.stringify({
      version: 'base-1',
      models: [{
        id: 'custom/chat',
        displayName: 'Chat',
        kind: 'ai',
        lifecycle: 'active',
        compatibleDrivers: ['fake'],
        inputModalities: ['text'],
        outputModalities: ['text'],
        capabilities: { streaming: true, tools: false },
        limits: { contextWindow: 8_000 },
        source: { kind: 'bundled', version: '1' },
      }],
    }));
    await fs.writeFile(path.join(root, 'local.json'), JSON.stringify({
      version: 'local-2',
      models: [{
        id: 'custom/chat',
        displayName: 'My Chat',
        capabilities: { tools: true },
        limits: { maxOutputTokens: 2_000 },
      }],
    }));

    const result = await new LocalCatalogSource({
      rootDirectory: root,
      basePath: 'base.json',
      overlayPaths: ['local.json'],
      now: () => new Date('2026-07-29T00:00:00.000Z'),
    }).load();

    expect(result.version).toBe('base-1+local-2');
    expect(result.models.get('custom/chat')).toMatchObject({
      displayName: 'My Chat',
      capabilities: { streaming: true, tools: true },
      limits: { maxOutputTokens: 2_000 },
      source: { kind: 'local', version: 'local-2' },
    });
  });

  it('rejects an overlay that cannot produce a complete model', async () => {
    const root = await temporaryCatalog();
    await fs.writeFile(path.join(root, 'base.json'), JSON.stringify({ version: 'base', models: [] }));
    await fs.writeFile(path.join(root, 'local.json'), JSON.stringify({
      version: 'local',
      models: [{ id: 'incomplete/model', capabilities: { tools: true } }],
    }));

    await expect(new LocalCatalogSource({
      rootDirectory: root,
      basePath: 'base.json',
      overlayPaths: ['local.json'],
    }).load()).rejects.toMatchObject<CatalogLoadError>({ code: 'CATALOG_INVALID_OVERLAY' });
  });
});
