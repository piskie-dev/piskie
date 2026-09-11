import { afterEach, describe, expect, it, vi } from 'vitest';
import { createImageThumbnail } from '../thumbnail';

afterEach(() => vi.unstubAllGlobals());
describe('thumbnail decoder lifetime', () => {
  it.each([true, false])('limits the output edge and closes bitmap/canvas on encoder success=%s', async (success) => {
    const bitmap = { width: 2048, height: 1024, close: vi.fn() };
    const result = new Blob(['example']);
    const drawImage = vi.fn();
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }), toBlob: vi.fn((callback: BlobCallback) => callback(success ? result : null)) };
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));
    vi.stubGlobal('document', { createElement: () => canvas });
    const rendering = createImageThumbnail(new Blob(['source']));
    if (success) await expect(rendering).resolves.toBe(result);
    else await expect(rendering).rejects.toThrow('thumbnail');
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 256, 128);
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(canvas.width).toBe(0); expect(canvas.height).toBe(0);
  });
});
