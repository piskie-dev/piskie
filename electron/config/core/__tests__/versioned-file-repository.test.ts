import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigRepositoryError } from '../../contracts/repository.js';
import { configDomainStoragePaths } from '../storage-layout.js';
import { VersionedFileConfigRepository } from '../versioned-file-repository.js';

interface ExampleConfig {
  revision: number;
  enabled: boolean;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

describe('VersionedFileConfigRepository', () => {
  it('applies one unknown-field policy to nested persisted config objects', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-versioned-config-'));
    temporaryDirectories.push(root);
    const paths = configDomainStoragePaths(root, 'example');
    const schema = z.strictObject({
      revision: z.number().int().nonnegative(),
      nested: z.strictObject({ enabled: z.boolean() }),
    });
    const repository = new VersionedFileConfigRepository({
      domain: 'example',
      paths,
      codec: { parse: (raw) => schema.parse(raw) },
    });
    await fs.mkdir(path.dirname(paths.configFile), { recursive: true });
    await fs.writeFile(paths.configFile, JSON.stringify({
      revision: 0,
      removedRootField: true,
      nested: { enabled: true, removedNestedField: true },
    }));

    await expect(repository.read()).resolves.toEqual({
      revision: 0,
      nested: { enabled: true },
    });
    expect(await fs.readFile(paths.configFile, 'utf8')).toContain('removedNestedField');

    await fs.writeFile(paths.configFile, JSON.stringify({
      revision: 0,
      nested: { enabled: 'yes', removedNestedField: true },
    }));
    await expect(repository.read()).rejects.toMatchObject<ConfigRepositoryError>({
      code: 'CONFIG_INVALID',
    });
  });

  it('provides shared CAS, atomic persistence and bounded history to any Domain', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-versioned-config-'));
    temporaryDirectories.push(root);
    const paths = configDomainStoragePaths(root, 'example');
    const repository = new VersionedFileConfigRepository<ExampleConfig>({
      domain: 'example',
      paths,
      codec: {
        parse: (raw) => {
          if (!raw || typeof raw !== 'object') throw new TypeError('expected object');
          return raw as ExampleConfig;
        },
      },
    });
    await repository.initialize({ revision: 0, enabled: false });
    for (let expectedRevision = 0; expectedRevision < 6; expectedRevision++) {
      await repository.commit({ revision: expectedRevision, enabled: true }, expectedRevision);
    }

    expect(await repository.read()).toEqual({ revision: 6, enabled: true });
    expect(await repository.history()).toEqual([2, 3, 4, 5, 6]);
    expect(await fs.readdir(path.dirname(paths.configFile))).toEqual(['example.json']);
    await expect(repository.commit({ revision: 0, enabled: false }, 5)).rejects.toMatchObject<ConfigRepositoryError>({
      code: 'CONFIG_REVISION_CONFLICT',
      details: { domain: 'example', expectedRevision: 5, actualRevision: 6 },
    });
  });
});
