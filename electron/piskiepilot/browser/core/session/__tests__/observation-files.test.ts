import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveObservationFile, saveTemporaryObservationFile, validateObservationFile } from '../observation-files.js';
import { fileFixture } from './observation-fixtures.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() { const data = await fileFixture(); roots.push(data.root); return data; }

describe('host observation files', () => {
  it('resolves relative/absolute filenames and replaces extensions as upstream does', async () => {
    const { root, files } = await fixture();
    const result = await saveObservationFile(Buffer.from('fixture text'), 'nested/报告 data.bin', '.txt', files);
    expect(result.filename).toBe(path.join(root, 'nested/报告 data.txt'));
    expect(await fs.readFile(result.filename, 'utf8')).toBe('fixture text');
    expect((await fs.stat(result.filename)).mode & 0o777).toBe(0o600);
    expect(await validateObservationFile(path.join(root, 'result.json'), '.json', files)).toBe(path.join(root, 'result.json'));
  });
  it('rejects input and normalized output paths that escape configured roots', async () => {
    const { root, files } = await fixture();
    await expect(validateObservationFile('../outside.data', '.json', files)).rejects.toThrow('Access denied');
    const target = path.join(root, 'nested'); await fs.mkdir(target);
    const outside = path.join(root, '..');
    await fs.symlink(outside, path.join(target, 'output.json'));
    expect(await validateObservationFile('nested/output.data', '.json', files)).toBe(path.join(target, 'output.json'));
    await expect(saveObservationFile(Buffer.from('fixture data'), 'nested/output.data', '.json', files)).rejects.toThrow('Access denied');
  });
  it('canonicalizes allowed symlinks and keeps temporary outputs within the host directory', async () => {
    const { root, files } = await fixture();
    await fs.mkdir(path.join(root, 'actual')); await fs.symlink(path.join(root, 'actual'), path.join(root, 'alias'));
    expect(await validateObservationFile('alias/data.bin', '.json', files)).toBe(path.join(root, 'actual/data.json'));
    const first = await saveTemporaryObservationFile(Buffer.from([7, 8]), 'screenshot.png', files);
    const second = await saveTemporaryObservationFile(Buffer.from([9]), 'screenshot.png', files);
    expect(first.filepath).not.toBe(second.filepath);
    expect(first.filepath.startsWith(files.tempDir + path.sep)).toBe(true);
    expect(await fs.readFile(first.filepath)).toEqual(Buffer.from([7, 8]));
  });
});
