import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CopyImageRequest } from '@shared/electron-contracts/desktop';
import { deferred, gifBytes, pngBytes } from '@/features/console/attachments/__tests__/fixtures';
import { copyImage, copyText } from '../clipboard';
import { acquireFilePreview, clearFilePreviews, releaseFilePreview } from '../file-preview';

const publish = vi.fn<(request: CopyImageRequest) => Promise<void>>();
const writeText = vi.fn<(text: string) => Promise<void>>();
const releasePreview = vi.fn(async () => undefined);
const previewUrl = 'piskie-attachment://preview/sample-image';
const preview = vi.fn(async () => ({ kind: 'image' as const, url: previewUrl, mediaType: 'image/gif', size: 12 }));
const animatedGif = gifBytes(2, 2, [
  { left: 0, top: 0, width: 2, height: 2 },
  { left: 0, top: 0, width: 2, height: 2 },
]);
// Two synthetic 2×2 solid-color frames, encoded losslessly with a 100 ms delay.
const animatedWebp = new Uint8Array(Buffer.from(
  'UklGRoQAAABXRUJQVlA4WAoAAAACAAAAAQAAAQAAQU5JTQYAAAAAAAAAAABBTk1GKAAAAAAAAAAAAAEAAAEAAGQAAAJWUDhMDwAAAC8BQAAABxD9j/4HIqL/AQBBTk1GKAAAAAAAAAAAAAEAAAEAAGQAAABWUDhMDwAAAC8BQAAABxDR//4HIqL/AQA=',
  'base64',
));

beforeEach(() => {
  publish.mockReset().mockResolvedValue(undefined);
  writeText.mockReset().mockResolvedValue(undefined);
  releasePreview.mockClear();
  preview.mockClear();
  vi.stubGlobal('window', { piskie: { desktop: { files: { copyImage: publish, preview, releasePreview } } } });
  vi.stubGlobal('navigator', { clipboard: { writeText } });
});

afterEach(() => {
  clearFilePreviews();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('clipboard service', () => {
  it('preserves source whitespace and waits for the actual text clipboard result', async () => {
    const pending = deferred<void>();
    writeText.mockReturnValueOnce(pending.promise);
    const settled = vi.fn();
    const operation = copyText('  first\r\n\tsecond\n').then(settled);
    expect(writeText).toHaveBeenCalledExactlyOnceWith('  first\r\n\tsecond\n');
    expect(settled).not.toHaveBeenCalled();
    pending.resolve();
    await operation;
    expect(settled).toHaveBeenCalledOnce();
    const failure = new Error('clipboard unavailable');
    writeText.mockRejectedValueOnce(failure);
    await expect(copyText('sample')).rejects.toBe(failure);
  });

  it.each(['/workspace/assets/sample image.gif', 'C:\\Example Folder\\sample.webp'])(
    'sends the original local path %s to the desktop', async (path) => {
      await copyImage({ kind: 'path', path });
      expect(publish).toHaveBeenCalledExactlyOnceWith({ kind: 'path', path });
    },
  );

  it.each(['http://images.example.test/sample.gif', 'https://images.example.test/sample.webp?version=1'])(
    'leaves cross-origin image reading to the desktop for %s', async (url) => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      await copyImage({ kind: 'url', url, name: 'sample image' });
      expect(publish).toHaveBeenCalledExactlyOnceWith({ kind: 'url', url, name: 'sample image' });
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: 'sample.gif', bytes: animatedGif },
    { name: 'sample.webp', bytes: animatedWebp },
    { name: 'diagram.png', bytes: pngBytes() },
  ])('passes every original byte of $name across the bridge as an ArrayBuffer', async ({ name, bytes }) => {
    await copyImage({ kind: 'blob', blob: new Blob([bytes]), name });
    const request = publish.mock.calls[0]![0];
    expect(request).toEqual({ kind: 'bytes', bytes: expect.any(ArrayBuffer), name });
    if (request.kind !== 'bytes') throw new Error('Expected bytes');
    expect(new Uint8Array(request.bytes)).toEqual(bytes);
  });

  it('reads a data URL without decoding or re-encoding its animation', async () => {
    const url = `data:image/gif;base64,${Buffer.from(animatedGif).toString('base64')}`;
    await copyImage({ kind: 'url', url });
    expect(publish).toHaveBeenCalledExactlyOnceWith({ kind: 'bytes', bytes: animatedGif.buffer, name: undefined });
  });

  it('keeps reading a clicked Blob URL when its view immediately revokes the URL', async () => {
    const url = URL.createObjectURL(new Blob([animatedWebp], { type: 'image/webp' }));
    const operation = copyImage({ kind: 'url', url });
    URL.revokeObjectURL(url);
    await operation;
    expect(publish).toHaveBeenCalledExactlyOnceWith({ kind: 'bytes', bytes: animatedWebp.buffer, name: undefined });
  });

  it.each(['success', 'failure'] as const)('holds a preview token through desktop publication: %s', async (outcome) => {
    await acquireFilePreview('/workspace/assets/sample.gif');
    const pending = deferred<void>();
    publish.mockReturnValueOnce(pending.promise);
    const settled = vi.fn();
    const operation = copyImage({ kind: 'url', url: previewUrl }).then(settled, settled);
    releaseFilePreview(previewUrl);
    expect(publish).toHaveBeenCalledExactlyOnceWith({ kind: 'preview', url: previewUrl });
    expect(releasePreview).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    const failure = new Error('publication failed');
    if (outcome === 'success') pending.resolve();
    else pending.reject(failure);
    await operation;
    expect(settled).toHaveBeenCalledExactlyOnceWith(outcome === 'success' ? undefined : failure);
    expect(releasePreview).toHaveBeenCalledExactlyOnceWith(previewUrl);
  });

  it('propagates image read failures without publishing incomplete bytes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(copyImage({ kind: 'url', url: 'blob:sample-missing' })).rejects.toThrow('Image read failed (404)');
    expect(publish).not.toHaveBeenCalled();
  });
});
