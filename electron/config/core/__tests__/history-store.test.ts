import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigRepositoryError } from '../../contracts/repository.js';
import { FileConfigHistoryStore } from '../file-history-store.js';
import {
  CONFIG_HISTORY_RETENTION,
  configDomainStoragePaths,
} from '../storage-layout.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

describe('FileConfigHistoryStore', () => {
  it('uses a shared five-snapshot retention policy', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-config-history-'));
    temporaryDirectories.push(root);
    const paths = configDomainStoragePaths(root, 'example');
    const store = new FileConfigHistoryStore<{ revision: number; value: string }>(
      'example',
      paths.historyDirectory,
      {
        serialize: (document) => `${JSON.stringify(document)}\n`,
        parse: (source) => JSON.parse(source) as { revision: number; value: string },
      },
    );
    for (let revision = 0; revision < 8; revision++) {
      await store.write({ revision, value: `value-${revision}` });
    }

    expect(await store.prune()).toEqual([0, 1, 2]);
    expect(await store.revisions()).toEqual([3, 4, 5, 6, 7]);
    expect(await store.read(7)).toEqual({ revision: 7, value: 'value-7' });
    expect(CONFIG_HISTORY_RETENTION).toBe(5);
  });

  it('keeps history and Plans outside the active configuration directory', () => {
    const root = path.join(os.tmpdir(), 'piskie-layout');
    const paths = configDomainStoragePaths(root, 'example');
    expect(paths.configFile).toBe(path.join(root, 'config', 'example.json'));
    expect(paths.historyDirectory).toBe(path.join(root, 'config-history', 'example'));
    expect(paths.plansDirectory).toBe(path.join(root, 'config-plans', 'example'));
    expect(path.dirname(paths.configFile)).not.toBe(paths.historyDirectory);
    expect(() => configDomainStoragePaths(root, '../unsafe')).toThrow(TypeError);
  });

  it('returns a stable missing-history error after retention cleanup', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-config-history-'));
    temporaryDirectories.push(root);
    const store = new FileConfigHistoryStore<{ revision: number }>(
      'example',
      configDomainStoragePaths(root, 'example').historyDirectory,
      {
        serialize: JSON.stringify,
        parse: (source) => JSON.parse(source) as { revision: number },
      },
    );

    await expect(store.read(0)).rejects.toMatchObject<ConfigRepositoryError>({
      code: 'CONFIG_HISTORY_NOT_FOUND',
      details: { domain: 'example', revision: 0 },
    });
  });
});
