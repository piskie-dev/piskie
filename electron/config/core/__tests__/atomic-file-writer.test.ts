import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CrossPlatformAtomicFileWriter } from '../atomic-file-writer.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

describe('CrossPlatformAtomicFileWriter', () => {
  it('atomically replaces a file without leaking temporary files', async () => {
    const root = await temporaryDirectory('piskie-atomic-writer-');
    const directory = path.join(root, '100% User', '配置 space');
    const filePath = path.join(directory, 'inference.json');
    const writer = new CrossPlatformAtomicFileWriter();

    await writer.replace(filePath, '{"revision":0}\n');
    await writer.replace(filePath, '{"revision":1}\n');

    expect(await fs.readFile(filePath, 'utf8')).toBe('{"revision":1}\n');
    expect(await fs.readdir(directory)).toEqual(['inference.json']);
  });

  it('creates immutable files once and preserves the first contents', async () => {
    const root = await temporaryDirectory('piskie-exclusive-writer-');
    const filePath = path.join(root, 'config-history', 'task-definitions', '00000001.json');
    const writer = new CrossPlatformAtomicFileWriter();

    await expect(writer.create(filePath, 'first')).resolves.toBe(true);
    await expect(writer.create(filePath, 'second')).resolves.toBe(false);
    expect(await fs.readFile(filePath, 'utf8')).toBe('first');
  });
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
