import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureFile, captureSource, readImageBytes } from '../capture';
import { IMAGE_LIMITS } from '../image-format';
import { pngBytes } from './fixtures';

afterEach(() => vi.unstubAllGlobals());

describe('image byte capture', () => {
  it('completes a real FileReader read and owns a distinct original-format Blob', async () => {
    const dom = new JSDOM();
    vi.stubGlobal('FileReader', dom.window.FileReader);
    vi.stubGlobal('Blob', dom.window.Blob);
    const file = new dom.window.File([pngBytes()], 'sample.png', { type: 'image/png' });
    const blob = await captureFile(file, new AbortController().signal);
    expect(blob).not.toBe(file);
    expect(blob.type).toBe('image/png');
    expect(new Uint8Array(await readImageBytes(blob, new AbortController().signal))).toEqual(pngBytes());
    dom.window.close();
  });

  it('cancels a direct FileReader when the batch is removed', async () => {
    const dom = new JSDOM();
    vi.stubGlobal('FileReader', dom.window.FileReader);
    const controller = new AbortController();
    const pending = captureFile(new dom.window.File([pngBytes()], 'sample.png'), controller.signal);
    controller.abort(new Error('removed'));
    await expect(pending).rejects.toThrow('removed');
    dom.window.close();
  });

  it('bounds a stream by actual bytes and cancels without reading the rest', async () => {
    const cancel = vi.fn();
    let pulls = 0;
    const body = new ReadableStream({ pull(control) { pulls++; control.enqueue(new Uint8Array(16)); }, cancel });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { headers: { 'Content-Length': '1' } })));
    await expect(captureSource('https://example.test/sample.png', 31, new AbortController().signal)).rejects.toThrow('batchBytes');
    expect(cancel).toHaveBeenCalledOnce();
    expect(pulls).toBeLessThanOrEqual(3);
  });

  it('captures a complete stream without retaining its source and detects its format', async () => {
    const bytes = pngBytes();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes)));
    const blob = await captureSource('https://example.test/sample.png', IMAGE_LIMITS.imageBytes, new AbortController().signal);
    expect(blob.type).toBe('image/png');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  });

  it('rejects empty streams instead of making a sendable attachment', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array())));
    await expect(captureSource('https://example.test/sample.png', 1024, new AbortController().signal)).rejects.toThrow('invalidImage');
  });
});
