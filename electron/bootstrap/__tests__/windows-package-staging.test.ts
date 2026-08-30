import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { moveDirectoryAcrossDevices } from '../../../scripts/package-windows-installer.mjs';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function createStagingDirectories() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'package-staging-'));
  temporaryDirectories.push(root);
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  await fs.mkdir(path.join(source, 'nested'), { recursive: true });
  await fs.writeFile(path.join(source, 'nested', 'asset.txt'), 'packaged asset', 'utf8');
  return { source, destination };
}

function crossDeviceError() {
  return Object.assign(new Error('cross-device move'), { code: 'EXDEV' });
}

describe('Windows package staging', () => {
  it('copies and removes the source when rename crosses filesystem volumes', async () => {
    const { source, destination } = await createStagingDirectories();
    const rename = vi.fn(async () => {
      throw crossDeviceError();
    });

    await moveDirectoryAcrossDevices(source, destination, { rename });

    expect(rename).toHaveBeenCalledOnce();
    await expect(fs.readFile(path.join(destination, 'nested', 'asset.txt'), 'utf8'))
      .resolves.toBe('packaged asset');
    await expect(fs.stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes a partial destination when the cross-volume copy fails', async () => {
    const { source, destination } = await createStagingDirectories();
    const copyFailure = new Error('copy failed');

    await expect(moveDirectoryAcrossDevices(source, destination, {
      rename: async () => {
        throw crossDeviceError();
      },
      copy: async (_source, target) => {
        await fs.mkdir(target, { recursive: true });
        await fs.writeFile(path.join(target, 'partial.txt'), 'partial', 'utf8');
        throw copyFailure;
      },
    })).rejects.toBe(copyFailure);

    await expect(fs.readFile(path.join(source, 'nested', 'asset.txt'), 'utf8'))
      .resolves.toBe('packaged asset');
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
