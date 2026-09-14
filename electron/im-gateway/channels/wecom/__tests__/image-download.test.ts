import { afterEach, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { downloadAndSaveImages } from '../vendor/media-handler.js';

afterEach(() => vi.unstubAllGlobals());

it('decrypts each image with its own key, including a download retry', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const keys = [Buffer.alloc(32, 1), Buffer.alloc(32, 2)];
  const encrypted = keys.map((key) => {
    const cipher = crypto.createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
    return Buffer.concat([cipher.update(png), cipher.final()]);
  });
  let attempts = 0;
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith('/first') && attempts++ === 0) throw new Error('connection reset');
    return new Response(encrypted[url.endsWith('/first') ? 0 : 1]);
  });
  vi.stubGlobal('fetch', fetch);
  const saveBuffer = vi.fn(async (buffer: Buffer) => ({ path: `/output/image-${buffer.length}.png`, contentType: 'image/png', size: buffer.length }));
  const urls = ['https://media.example.test/first', 'https://media.example.test/second'];
  const result = await downloadAndSaveImages({
    imageUrls: urls, imageAesKeys: new Map(urls.map((url, index) => [url, keys[index]!.toString('base64')])),
    runtime: { log: vi.fn(), error: vi.fn() }, media: { saveBuffer }, account: {} as never, wsClient: {} as never,
  });
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(result).toHaveLength(2);
  expect(saveBuffer).toHaveBeenCalledTimes(2);
  expect(saveBuffer.mock.calls.map(([buffer]) => buffer)).toEqual([png, png]);
});
