import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validatePathWithinRoots } from '../file-roots.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe('upload file roots', () => {
  it('allows canonical files inside a configured root', async () => {
    const root = await temporaryDirectory('piskie-upload-root-');
    const filePath = join(root, 'upload.txt');
    await writeFile(filePath, 'upload');

    await expect(validatePathWithinRoots(filePath, [root])).resolves.toBeUndefined();
  });

  it('rejects files outside roots and symlinks that escape a root', async () => {
    const root = await temporaryDirectory('piskie-upload-root-');
    const outside = await temporaryDirectory('piskie-upload-outside-');
    const outsideFile = join(outside, 'secret.txt');
    const link = join(root, 'escaped.txt');
    await writeFile(outsideFile, 'secret');
    await symlink(outsideFile, link);

    await expect(validatePathWithinRoots(outsideFile, [root])).rejects.toThrow('Access denied');
    await expect(validatePathWithinRoots(link, [root])).rejects.toThrow('Access denied');
  });
});
