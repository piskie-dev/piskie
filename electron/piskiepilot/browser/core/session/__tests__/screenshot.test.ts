import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ElementHandle } from 'puppeteer-core';
import { takeScreenshot } from '../screenshot.js';
import { fakePage, fileFixture } from './observation-fixtures.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function files() { const fixture = await fileFixture(); roots.push(fixture.root); return fixture; }

describe('fixed-source screenshots', () => {
  it('captures default PNG viewport without custom scaling and preserves exact image bytes/MIME', async () => {
    const { files: storage } = await files(); const current = fakePage();
    const result = await takeScreenshot(current.page, { quality: 82.5 }, { files: storage });
    expect(current.page.screenshot).toHaveBeenCalledWith({ type: 'png', quality: undefined, fullPage: false, optimizeForSpeed: true });
    expect(result).toEqual({ text: "Took a screenshot of the current page's viewport.", image: { mimeType: 'image/png', data: 'AQID' } });
  });
  it.each(['jpeg', 'webp'] as const)('passes fractional quality through for %s and supports full page', async format => {
    const { files: storage } = await files(); const current = fakePage();
    const result = await takeScreenshot(current.page, { format, quality: 81.5, fullPage: true }, { files: storage });
    expect(current.page.screenshot).toHaveBeenCalledWith({ type: format, quality: 81.5, fullPage: true, optimizeForSpeed: true });
    expect(result.text).toBe('Took a screenshot of the full current page.');
    expect(result.image?.mimeType).toBe(`image/${format}`);
  });
  it('resolves and releases an element UID without an outer action wait', async () => {
    const { files: storage } = await files(); const current = fakePage();
    const element = { screenshot: vi.fn(async () => new Uint8Array([7])), dispose: vi.fn(async () => {}) } as unknown as ElementHandle;
    const resolver = vi.fn(async () => element);
    const result = await takeScreenshot(current.page, { uid: 'fixture_2' }, { files: storage, resolveUid: resolver });
    expect(resolver).toHaveBeenCalledWith('fixture_2', undefined);
    expect(result.text).toBe('Took a screenshot of node with uid "fixture_2".');
    expect(element.screenshot).toHaveBeenCalledWith({ type: 'png', quality: undefined, optimizeForSpeed: true });
    expect(element.dispose).toHaveBeenCalledOnce();
    expect(current.page.screenshot).not.toHaveBeenCalled();
  });
  it('rejects mutually exclusive UID/fullPage before resolving or capturing', async () => {
    const { files: storage } = await files(); const current = fakePage(); const resolveUid = vi.fn();
    await expect(takeScreenshot(current.page, { uid: 'fixture_2', fullPage: true }, { files: storage, resolveUid })).rejects.toThrow('Providing both "uid" and "fullPage" is not allowed.');
    expect(resolveUid).not.toHaveBeenCalled(); expect(current.page.screenshot).not.toHaveBeenCalled();
  });
  it('saves explicit files with the source extension and large images to host temporary storage', async () => {
    const { root, files: storage } = await files(); const current = fakePage();
    const explicit = await takeScreenshot(current.page, { format: 'webp', filePath: 'image.data' }, { files: storage });
    expect(explicit.filePath).toBe(path.join(root, 'image.webp'));
    expect(await fs.readFile(explicit.filePath!)).toEqual(Buffer.from([1, 2, 3]));
    expect(explicit.image).toBeUndefined();
    vi.mocked(current.page.screenshot).mockResolvedValue(new Uint8Array(2_000_000));
    const large = await takeScreenshot(current.page, {}, { files: storage });
    expect(large.image).toBeUndefined();
    expect(large.filePath?.startsWith(storage.tempDir + path.sep)).toBe(true);
    expect((await fs.stat(large.filePath!)).size).toBe(2_000_000);
    vi.mocked(current.page.screenshot).mockResolvedValue(new Uint8Array(1_999_999));
    expect((await takeScreenshot(current.page, {}, { files: storage })).image).toBeDefined();
  });
  it('validates file access before capture, propagates failures, and retains borrowed handles', async () => {
    const { root, files: storage } = await files(); const current = fakePage();
    await expect(takeScreenshot(current.page, { filePath: path.join(root, '..', 'outside.png') }, { files: storage })).rejects.toThrow('Access denied');
    expect(current.page.screenshot).not.toHaveBeenCalled();
    const element = { screenshot: vi.fn(async () => { throw new Error('fixture capture failure'); }), dispose: vi.fn() } as unknown as ElementHandle;
    await expect(takeScreenshot(current.page, { uid: 'fixture_2' }, { files: storage, element })).rejects.toThrow('fixture capture failure');
    expect(element.dispose).not.toHaveBeenCalled();
    await expect(takeScreenshot(current.page, { uid: 'fixture_2' }, { files: storage, resolveUid: async () => element })).rejects.toThrow('fixture capture failure');
    expect(element.dispose).toHaveBeenCalledOnce();
  });
});
