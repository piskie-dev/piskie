import { runInNewContext } from 'node:vm';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_IMAGE_BYTES } from '../../../shared/utils/image-format.js';
import { deferred, pngBytes, gifBytes } from '../../../src/features/console/attachments/__tests__/fixtures.js';

const native = vi.hoisted(() => ({
  writeImage: vi.fn(), readImage: vi.fn(), fetch: vi.fn(),
  createFromBuffer: vi.fn(), createFromDataURL: vi.fn(),
  createWindow: vi.fn(), loadURL: vi.fn(), executeJavaScript: vi.fn(), destroy: vi.fn(),
  image: { isEmpty: () => false, getSize: () => ({ width: 2, height: 2 }) },
}));
vi.mock('electron', () => ({
  clipboard: { writeImage: native.writeImage, readImage: native.readImage },
  nativeImage: { createFromBuffer: native.createFromBuffer, createFromDataURL: native.createFromDataURL },
  BrowserWindow: class {
    constructor(options: unknown) { native.createWindow(options); }
    loadURL = native.loadURL;
    webContents = { executeJavaScript: native.executeJavaScript };
    isDestroyed = () => false;
    destroy = native.destroy;
  },
}));
import { copyImageContents } from '../capabilities/image-file-clipboard.js';

const decodedPng = `data:image/png;base64,${Buffer.from(pngBytes()).toString('base64')}`;
const fetchDataUrl = globalThis.fetch;
beforeEach(() => {
  native.createFromBuffer.mockReturnValue(native.image);
  native.createFromDataURL.mockReturnValue(native.image);
  native.readImage.mockReturnValue(native.image);
  native.loadURL.mockResolvedValue(undefined);
  native.executeJavaScript.mockResolvedValue(decodedPng);
  vi.stubGlobal('fetch', native.fetch);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

function bytesRequest(bytes: Uint8Array, name?: string) {
  return { kind: 'bytes' as const, bytes: new Uint8Array(bytes).buffer, name };
}
function imageFormats() {
  const jpeg = new Uint8Array([255, 216, 255, 194, 0, 8, 8, 0, 6, 0, 7, 1]);
  const bmp = Buffer.alloc(54); bmp.write('BM'); bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(7, 18); bmp.writeInt32LE(6, 22);
  const webp = Buffer.from('UklGRsQAAABXRUJQVlA4WAoAAAACAAAAAwAAAwAAQU5JTQYAAAAAAAAAAABBTk1GSgAAAAAAAAAAAAMAAAMAAGQAAAJWUDggMgAAADABAJ0BKgQABAABQCYloAADcAD+8ut///mwP/bz/wR6Af//0uD//pcH//S4P/SkAAAAQU5NRkYAAAAAAAAAAAADAAADAABkAAAAVlA4IC4AAAA0AQCdASoEAAQAAAAmJaAAA3AA/vtV4///S4P/+lwf/9Lg/9Lg//rV5Vesq6AA', 'base64');
  return [['png', pngBytes()], ['jpg', jpeg], ['gif', gifBytes(2, 2, [{ left: 0, top: 0, width: 2, height: 2 }, { left: 0, top: 0, width: 2, height: 2 }])], ['webp', webp], ['bmp', bmp], ['svg', Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><path d="M0 0h1"/></svg>')]] as const;
}

describe('native image content publication', () => {
  it.each(imageFormats())('decodes %s through the appropriate decoder and publishes native pixels', async (format, bytes) => {
    await copyImageContents(bytesRequest(bytes, 'sample.dat'), vi.fn());
    if (format === 'png') {
      expect(native.createFromBuffer).toHaveBeenCalledExactlyOnceWith(Buffer.from(bytes));
      expect(native.createWindow).not.toHaveBeenCalled();
    } else {
      expect(native.createWindow).toHaveBeenCalledExactlyOnceWith({
        show: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false },
      });
      const document = decodeURIComponent(native.loadURL.mock.lastCall![0]);
      expect(document).toContain("default-src 'none'; img-src data:; connect-src data:");
      expect(native.createFromDataURL).toHaveBeenCalledExactlyOnceWith(decodedPng);
      expect(native.destroy).toHaveBeenCalledOnce();
    }
    expect(native.writeImage).toHaveBeenCalledExactlyOnceWith(native.image);
    expect(native.readImage).toHaveBeenCalledOnce();
  });

  it('publishes decoded contents obtained from a local source', async () => {
    const source = '/sample folder/示例 #1%.png';
    const read = vi.fn(async () => pngBytes());
    await copyImageContents({ kind: 'path', path: source }, read);
    expect(read).toHaveBeenCalledExactlyOnceWith(source);
    expect(native.createFromBuffer).toHaveBeenCalledExactlyOnceWith(Buffer.from(pngBytes()));
    expect(native.writeImage).toHaveBeenCalledExactlyOnceWith(native.image);
  });

  it.each([Buffer.from('Not an image'), Buffer.from('<html><svg/></html>'), new Uint8Array(MAX_IMAGE_BYTES + 1)])('rejects unsupported or oversized bytes before publishing', async (bytes) => {
    await expect(copyImageContents(bytesRequest(bytes), vi.fn())).rejects.toMatchObject({ code: 'invalid-input' });
    expect(native.writeImage).not.toHaveBeenCalled();
  });

  it('passes original animated bytes to the browser bitmap decoder and draws a still image at its dimensions', async () => {
    const bytes = gifBytes(2, 2, [{ left: 0, top: 0, width: 2, height: 2 }, { left: 0, top: 0, width: 2, height: 2 }]);
    const bitmap = { width: 2, height: 2, close: vi.fn() };
    const decode = vi.fn(async (blob: Blob) => {
      expect(blob.type).toBe('image/gif');
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
      return bitmap;
    });
    const draw = vi.fn();
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: draw }), toDataURL: () => decodedPng };
    native.executeJavaScript.mockImplementationOnce((script) => runInNewContext(script, {
      fetch: fetchDataUrl, createImageBitmap: decode, document: { createElement: () => canvas },
    }));
    await copyImageContents(bytesRequest(bytes), vi.fn());
    expect(decode).toHaveBeenCalledOnce();
    expect(canvas).toMatchObject({ width: 2, height: 2 });
    expect(draw).toHaveBeenCalledExactlyOnceWith(bitmap, 0, 0);
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(native.writeImage).toHaveBeenCalledExactlyOnceWith(native.image);
  });

  it('decodes SVG as an image resource and uses its natural dimensions', async () => {
    const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="3" height="4"><path d="M0 0h1"/></svg>');
    const draw = vi.fn();
    const decode = vi.fn(async () => undefined);
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: draw }), toDataURL: () => decodedPng };
    native.executeJavaScript.mockImplementationOnce((script) => runInNewContext(script, {
      Image: class { src = ''; naturalWidth = 3; naturalHeight = 4; decode = decode; },
      document: { createElement: () => canvas },
    }));
    await copyImageContents(bytesRequest(bytes), vi.fn());
    expect(decode).toHaveBeenCalledOnce();
    expect(canvas).toMatchObject({ width: 3, height: 4 });
    expect(draw).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      src: `data:image/svg+xml;base64,${bytes.toString('base64')}`,
    }), 0, 0);
    expect(native.writeImage).toHaveBeenCalledExactlyOnceWith(native.image);
  });

  it.each(['native', 'browser'] as const)('rejects a real %s decode failure without publishing', async (decoder) => {
    if (decoder === 'native') native.createFromBuffer.mockReturnValueOnce({ isEmpty: () => true });
    else native.executeJavaScript.mockRejectedValueOnce(new Error('Sample image decode failed'));
    await expect(copyImageContents(bytesRequest(decoder === 'native' ? pngBytes() : gifBytes()), vi.fn()))
      .rejects.toMatchObject({ code: 'invalid-input' });
    expect(native.writeImage).not.toHaveBeenCalled();
    if (decoder === 'browser') expect(native.destroy).toHaveBeenCalledOnce();
  });

  it('reports native clipboard failure', async () => {
    native.writeImage.mockImplementationOnce(() => { throw new Error('Sample clipboard unavailable'); });
    await expect(copyImageContents(bytesRequest(pngBytes()), vi.fn())).rejects.toThrow('Sample clipboard unavailable');
    native.readImage.mockReturnValueOnce({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) });
    await expect(copyImageContents(bytesRequest(pngBytes()), vi.fn())).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('does not publish after cancellation during source preparation', async () => {
    const controller = new AbortController();
    const read = vi.fn(async () => { controller.abort(new Error('Sample cancellation')); return pngBytes(); });
    await expect(copyImageContents({ kind: 'path', path: '/sample/image.png' }, read, controller.signal)).rejects.toThrow('Sample cancellation');
    expect(native.writeImage).not.toHaveBeenCalled();
  });

  it('destroys a pending decoder on request cancellation and never publishes its late result', async () => {
    const controller = new AbortController();
    const pending = deferred<string>();
    native.executeJavaScript.mockReturnValueOnce(pending.promise);
    const copying = copyImageContents(bytesRequest(gifBytes()), vi.fn(), controller.signal);
    const rejected = expect(copying).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(native.executeJavaScript).toHaveBeenCalled());
    controller.abort();
    await rejected;
    expect(native.destroy).toHaveBeenCalledOnce();
    pending.resolve(decodedPng);
    await Promise.resolve();
    expect(native.writeImage).not.toHaveBeenCalled();
  });
});

describe('bounded remote image reads', () => {
  it('follows HTTP(S) redirects and decodes the final original image', async () => {
    const signal = new AbortController().signal;
    const bytes = pngBytes();
    native.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://images.example.test/sample%20image.png' } }))
      .mockResolvedValueOnce(new Response(bytes));
    await copyImageContents({ kind: 'url', url: 'http://example.test/start' }, vi.fn(), signal);
    expect(native.fetch.mock.calls).toEqual([
      ['http://example.test/start', { signal, redirect: 'manual', credentials: 'omit', cache: 'no-store' }],
      ['https://images.example.test/sample%20image.png', { signal, redirect: 'manual', credentials: 'omit', cache: 'no-store' }],
    ]);
    expect(native.createFromBuffer).toHaveBeenCalledExactlyOnceWith(Buffer.from(bytes));
    expect(native.writeImage).toHaveBeenCalledExactlyOnceWith(native.image);
  });

  it.each(['file:///sample/image.png', 'data:image/png;base64,eA==', 'ftp://example.test/image.png'])('rejects %s at both the initial URL and redirect boundary', async (url) => {
    await expect(copyImageContents({ kind: 'url', url }, vi.fn())).rejects.toThrow('HTTP or HTTPS');
    expect(native.fetch).not.toHaveBeenCalled();
    native.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: url } }));
    await expect(copyImageContents({ kind: 'url', url: 'https://example.test/image' }, vi.fn())).rejects.toThrow('HTTP or HTTPS');
    expect(native.fetch).toHaveBeenCalledOnce();
    expect(native.writeImage).not.toHaveBeenCalled();
  });

  it('terminates a redirect loop', async () => {
    native.fetch.mockImplementation(async () => new Response(null, { status: 302, headers: { location: '/again' } }));
    await expect(copyImageContents({ kind: 'url', url: 'https://example.test/image' }, vi.fn())).rejects.toThrow('redirects');
    expect(native.writeImage).not.toHaveBeenCalled();
  });

  it.each(['header', 'body'])('bounds the remote %s and cancels the stream', async (kind) => {
    const cancel = vi.fn();
    native.fetch.mockResolvedValue(new Response(new ReadableStream({
      start(controller) { if (kind === 'body') controller.enqueue(new Uint8Array(MAX_IMAGE_BYTES + 1)); }, cancel,
    }), { headers: kind === 'header' ? { 'content-length': String(MAX_IMAGE_BYTES + 1) } : {} }));
    await expect(copyImageContents({ kind: 'url', url: 'https://example.test/image' }, vi.fn())).rejects.toThrow('32 MiB');
    expect(cancel).toHaveBeenCalled();
    expect(native.writeImage).not.toHaveBeenCalled();
  });

  it('uses request cancellation while waiting for remote bytes', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    native.fetch.mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const copying = copyImageContents({ kind: 'url', url: 'https://example.test/image' }, vi.fn(), controller.signal);
    const rejected = expect(copying).rejects.toThrow();
    await vi.waitFor(() => expect(native.fetch).toHaveBeenCalled());
    controller.abort();
    await rejected;
    expect(cancel).toHaveBeenCalled();
    expect(native.writeImage).not.toHaveBeenCalled();
  });

  it('rejects actual network and HTTP failures', async () => {
    native.fetch.mockRejectedValueOnce(new Error('Sample connection failed'));
    await expect(copyImageContents({ kind: 'url', url: 'https://example.test/image' }, vi.fn())).rejects.toThrow('Sample connection failed');
    native.fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(copyImageContents({ kind: 'url', url: 'https://example.test/image' }, vi.fn())).rejects.toThrow('HTTP 404');
    expect(native.writeImage).not.toHaveBeenCalled();
  });
});
