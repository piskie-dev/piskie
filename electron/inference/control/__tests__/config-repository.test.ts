import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configFileWriter } from '../../../config/core/atomic-file-writer.js';
import {
  ConfigRepositoryError,
  InferenceConfigRepository,
  inferenceConfigPaths,
} from '../config-repository.js';
import { testConfig } from './fixtures.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function repository(): Promise<InferenceConfigRepository> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-config-'));
  temporaryDirectories.push(directory);
  return new InferenceConfigRepository(inferenceConfigPaths(directory));
}

describe('InferenceConfigRepository', () => {
  it('ignores unknown persisted fields without rewriting the source document', async () => {
    const repo = await repository();
    const config = testConfig() as ReturnType<typeof testConfig> & Record<string, unknown>;
    config.removedRoutes = { default: 'primary' };
    const connection = config.providers.primary.connection as typeof config.providers.primary.connection
      & Record<string, unknown>;
    connection.removedEndpointMode = 'legacy';
    const aiPolicy = config.policies.ai as typeof config.policies.ai & Record<string, unknown>;
    aiPolicy.firstEventTimeoutMs = 60_000;
    await fs.mkdir(path.dirname(repo.paths.configFile), { recursive: true });
    await fs.writeFile(repo.paths.configFile, JSON.stringify(config));

    const loaded = await repo.read();
    expect(loaded).not.toHaveProperty('removedRoutes');
    expect(loaded.providers.primary.connection).not.toHaveProperty('removedEndpointMode');
    expect(loaded.policies.ai).not.toHaveProperty('firstEventTimeoutMs');
    const source = await fs.readFile(repo.paths.configFile, 'utf8');
    expect(source).toContain('removedEndpointMode');
    expect(source).toContain('firstEventTimeoutMs');

    config.revision = 'invalid' as never;
    await fs.writeFile(repo.paths.configFile, JSON.stringify(config));
    await expect(repo.read()).rejects.toMatchObject<ConfigRepositoryError>({ code: 'CONFIG_INVALID' });
  });

  it('persists plaintext secrets and immutable history snapshots', async () => {
    const repo = await repository();
    await repo.initialize(testConfig());
    const next = await repo.commit(testConfig(), 0);
    const source = await fs.readFile(repo.paths.configFile, 'utf8');

    expect(next.revision).toBe(1);
    expect(source).toContain('sk-plaintext-secret');
    expect(source).toContain('plain-header-secret');
    expect(await repo.history()).toEqual([0, 1]);
    expect((await repo.readRevision(0)).revision).toBe(0);
  });

  it('rejects a stale expected revision', async () => {
    const repo = await repository();
    await repo.initialize(testConfig());
    await repo.commit(testConfig(), 0);

    await expect(repo.commit(testConfig(), 0)).rejects.toMatchObject<ConfigRepositoryError>({
      code: 'CONFIG_REVISION_CONFLICT',
      details: { expectedRevision: 0, actualRevision: 1 },
    });
  });

  it('does not corrupt the current revision when the atomic replacement fails', async () => {
    const repo = await repository();
    await repo.initialize(testConfig());
    const failing = new InferenceConfigRepository(repo.paths, {
      writer: {
        create: (filePath, contents) => configFileWriter.create(filePath, contents),
        replace: async () => {
          throw new Error('injected write failure');
        },
      },
    });

    await expect(failing.commit(testConfig(), 0)).rejects.toMatchObject<ConfigRepositoryError>({
      code: 'CONFIG_WRITE_FAILED',
    });
    expect((await repo.read()).revision).toBe(0);
    expect(await repo.history()).toEqual([0]);
  });

  it('keeps only five snapshots outside the active config directory', async () => {
    const repo = await repository();
    await repo.initialize(testConfig());
    for (let expectedRevision = 0; expectedRevision < 7; expectedRevision++) {
      await repo.commit(testConfig(), expectedRevision);
    }

    expect((await fs.readdir(repo.paths.historyDirectory)).sort()).toEqual([
      '00000003.json',
      '00000004.json',
      '00000005.json',
      '00000006.json',
      '00000007.json',
    ]);
    expect(await repo.history()).toEqual([3, 4, 5, 6, 7]);
    expect(path.dirname(repo.paths.configFile)).not.toBe(repo.paths.historyDirectory);
    expect(await fs.readdir(path.dirname(repo.paths.configFile))).toEqual(['inference.json']);
    await expect(repo.readRevision(2)).rejects.toMatchObject<ConfigRepositoryError>({
      code: 'CONFIG_HISTORY_NOT_FOUND',
    });
  });
});
