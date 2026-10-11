import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigRepositoryError } from '../../contracts/repository.js';
import { configDomainStoragePaths } from '../storage-layout.js';
import { configFileWriter } from '../atomic-file-writer.js';
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

  it('holds dependency locks through replacement across repository instances and releases them after commit', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sample-config-dependencies-'));
    temporaryDirectories.push(root);
    const paths = configDomainStoragePaths(root, 'binding');
    const codec = { parse: (raw: unknown) => z.object({ revision: z.number(), enabled: z.boolean() }).parse(raw) };
    const dependencyOptions = { domain: 'model', paths: configDomainStoragePaths(root, 'model'), codec };
    const model = new VersionedFileConfigRepository(dependencyOptions);
    const otherWriter = new VersionedFileConfigRepository(dependencyOptions);
    let replacing!: () => void;
    let finishReplace!: () => void;
    const atReplace = new Promise<void>((resolve) => { replacing = resolve; });
    const finish = new Promise<void>((resolve) => { finishReplace = resolve; });
    let pause = false;
    const binding = new VersionedFileConfigRepository({
      domain: 'binding', paths, codec,
      writer: {
        create: (filePath, source) => configFileWriter.create(filePath, source),
        replace: async (filePath, source) => {
          if (pause && filePath === paths.configFile) {
            replacing();
            await finish;
          }
          await configFileWriter.replace(filePath, source);
        },
      },
    });
    await model.initialize({ revision: 0, enabled: true });
    await binding.initialize({ revision: 0, enabled: false });
    pause = true;
    const pending = binding.commit({ revision: 0, enabled: true }, 0, {
      dependencyDomains: ['model'],
      validate: async () => { expect(await model.read()).toEqual({ revision: 0, enabled: true }); },
    });
    await atReplace;
    try {
      await expect(otherWriter.commit({ revision: 0, enabled: false }, 0)).rejects.toMatchObject({
        code: 'CONFIG_LOCKED', details: { domain: 'model' },
      });
      await expect(binding.read()).resolves.toEqual({ revision: 0, enabled: false });
    } finally {
      finishReplace();
      await pending;
    }
    await expect(otherWriter.commit({ revision: 0, enabled: false }, 0)).resolves.toEqual({ revision: 1, enabled: false });
    await expect(binding.read()).resolves.toEqual({ revision: 1, enabled: true });
  });

  it('releases acquired locks after dependency contention and failed validation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sample-config-contention-'));
    temporaryDirectories.push(root);
    const codec = { parse: (raw: unknown) => z.object({ revision: z.number(), enabled: z.boolean() }).parse(raw) };
    const paths = configDomainStoragePaths(root, 'binding');
    const modelPaths = configDomainStoragePaths(root, 'model');
    const binding = new VersionedFileConfigRepository({ domain: 'binding', paths, codec });
    const model = new VersionedFileConfigRepository({ domain: 'model', paths: modelPaths, codec });
    await binding.initialize({ revision: 0, enabled: false });
    await model.initialize({ revision: 0, enabled: true });
    const held = await fs.open(modelPaths.lockFile, 'wx');
    try {
      await expect(binding.commit({ revision: 0, enabled: true }, 0, {
        dependencyDomains: ['model'], validate: async () => undefined,
      })).rejects.toMatchObject({ code: 'CONFIG_LOCKED', details: { domain: 'model' } });
      await expect(fs.access(paths.lockFile)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await held.close();
      await fs.unlink(modelPaths.lockFile);
    }
    await expect(binding.commit({ revision: 0, enabled: true }, 0, {
      dependencyDomains: ['model'], validate: async () => { throw new Error('Sample dependency changed'); },
    })).rejects.toThrow('Sample dependency changed');
    await expect(binding.read()).resolves.toEqual({ revision: 0, enabled: false });
    await expect(fs.readdir(path.dirname(paths.configFile))).resolves.toEqual(['binding.json', 'model.json']);
    await expect(binding.commit({ revision: 0, enabled: true }, 0)).resolves.toEqual({ revision: 1, enabled: true });
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
