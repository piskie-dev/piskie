import { describe, expect, it, vi } from 'vitest';
import { DESKTOP_OPERATIONS, type CopyImageRequest } from '../../../shared/electron-contracts/desktop.js';
import { MAX_IMAGE_BYTES } from '../../../shared/utils/image-format.js';
import { createElectronPiskieClient } from '../../transport/electron/piskie-client.js';
import { createDesktopController } from '../capabilities/desktop-controller.js';

function fixture(id: string = DESKTOP_OPERATIONS.copyImage) {
  const copyImage = vi.fn(async () => undefined);
  const copyFile = vi.fn(async () => undefined);
  const controller = createDesktopController({ copyImage, copyFile } as never);
  const operation = controller.operations.find((candidate) => candidate.id === id)!;
  const signal = new AbortController().signal;
  const request = vi.fn(async (id: string, args: unknown) => {
    expect(id).toBe(operation.id);
    return operation.execute({ windowId: 7, signal } as never, operation.input.parse(args));
  });
  const client = createElectronPiskieClient({
    transport: { request } as never, platform: 'linux', version: 'test', getPathForFile: vi.fn(),
  });
  return { copyImage, copyFile, client, operation, signal };
}

describe('desktop file copy contract', () => {
  it('routes one unchanged file or directory path through the typed client with cancellation', async () => {
    const { client, copyFile, signal } = fixture(DESKTOP_OPERATIONS.copyFile);
    const path = '/sample folder/示例 ';
    await expect(client.desktop.files.copyFile(path)).resolves.toBeUndefined();
    expect(copyFile).toHaveBeenCalledExactlyOnceWith(path, signal);
    const failure = new Error('Sample clipboard failure');
    copyFile.mockRejectedValueOnce(failure);
    await expect(client.desktop.files.copyFile(path)).rejects.toBe(failure);
  });

  it.each([[], [''], [42], [{ path: '/sample/file.txt' }], ['/sample/file.txt', '/sample/other.txt']])(
    'rejects malformed external file copy arguments %j', (...input) => {
      const { operation } = fixture(DESKTOP_OPERATIONS.copyFile);
      expect(operation.input.safeParse(input).success).toBe(false);
    },
  );
});

describe('desktop image copy contract', () => {
  it.each<CopyImageRequest>([
    { kind: 'path', path: '/sample folder/image.gif' },
    { kind: 'preview', url: 'piskie-attachment://preview/sample-token' },
    { kind: 'url', url: 'https://example.test/image.webp', name: 'sample.webp' },
    { kind: 'bytes', bytes: new Uint8Array([1, 2, 3]).buffer, name: 'sample.png' },
  ])('routes $kind from the typed client through the controller with window ownership and cancellation', async (source) => {
    const { client, copyImage, signal } = fixture();
    await expect(client.desktop.files.copyImage(source)).resolves.toBeUndefined();
    expect(copyImage).toHaveBeenCalledWith(7, source, signal);
    if (source.kind === 'bytes') expect(copyImage.mock.lastCall![1].bytes).toBe(source.bytes);
  });

  it.each([
    { kind: 'bytes', bytes: [1, 2, 3] },
    { kind: 'bytes', bytes: new Uint8Array([1, 2, 3]) },
    { kind: 'bytes', bytes: new ArrayBuffer(MAX_IMAGE_BYTES + 1) },
    { kind: 'path', path: '/sample/image.png', extra: 'unexpected' },
    { kind: 'preview', url: '' },
    { kind: 'url', url: 3 },
  ])('rejects malformed external copy input', (input) => {
    const { operation } = fixture();
    expect(operation.input.safeParse([input]).success).toBe(false);
  });

  it('propagates actual failures through the client promise', async () => {
    const { client, copyImage } = fixture();
    copyImage.mockRejectedValueOnce(new Error('Sample clipboard failure'));
    await expect(client.desktop.files.copyImage({ kind: 'path', path: '/sample/image.png' })).rejects.toThrow('Sample clipboard failure');
  });
});
