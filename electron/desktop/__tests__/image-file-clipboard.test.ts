import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_IMAGE_BYTES } from '../../../shared/utils/image-format.js';
import { pngBytes, gifBytes } from '../../../src/features/console/attachments/__tests__/fixtures.js';

const native = vi.hoisted(() => ({ writeBuffer: vi.fn(), readBuffer: vi.fn(), fetch: vi.fn(), execFile: vi.fn() }));
vi.mock('electron', () => ({ clipboard: native }));
vi.mock('node:child_process', () => ({ execFile: native.execFile }));
import { copyImageFile, publishImageFile } from '../capabilities/image-file-clipboard.js';

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-image-copy-'));
  vi.spyOn(os, 'tmpdir').mockReturnValue(directory);
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  native.readBuffer.mockImplementation(() => native.writeBuffer.mock.lastCall![1]);
  vi.stubGlobal('fetch', native.fetch);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

function publishedPath(): string {
  return fileURLToPath(native.writeBuffer.mock.lastCall![1].toString().trim());
}
function bytesRequest(bytes: Uint8Array, name?: string) {
  return { kind: 'bytes' as const, bytes: new Uint8Array(bytes).buffer, name };
}
function rasterFormats() {
  const jpeg = new Uint8Array([255, 216, 255, 194, 0, 8, 8, 0, 6, 0, 7, 1]);
  const bmp = Buffer.alloc(54); bmp.write('BM'); bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(7, 18); bmp.writeInt32LE(6, 22);
  const webp = Buffer.from('UklGRsQAAABXRUJQVlA4WAoAAAACAAAAAwAAAwAAQU5JTQYAAAAAAAAAAABBTk1GSgAAAAAAAAAAAAMAAAMAAGQAAAJWUDggMgAAADABAJ0BKgQABAABQCYloAADcAD+8ut///mwP/bz/wR6Af//0uD//pcH//S4P/SkAAAAQU5NRkYAAAAAAAAAAAADAAADAABkAAAAVlA4IC4AAAA0AQCdASoEAAQAAAAmJaAAA3AA/vtV4///S4P/+lwf/9Lg/9Lg//rV5Vesq6AA', 'base64');
  return [['png', pngBytes()], ['jpg', jpeg], ['gif', gifBytes(2, 2, [{ left: 0, top: 0, width: 2, height: 2 }, { left: 0, top: 0, width: 2, height: 2 }])], ['webp', webp], ['bmp', bmp], ['svg', Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1"/></svg>')]] as const;
}

describe('image file preparation', () => {
  it.each(rasterFormats())('publishes original %s bytes using the actual format, with no transcoding', async (extension, bytes) => {
    await copyImageFile(bytesRequest(bytes, '../sample 资料.exe'), vi.fn());
    const file = publishedPath();
    expect(file.startsWith(path.join(directory, 'piskie', 'clipboard') + path.sep)).toBe(true);
    expect(path.basename(file)).toBe(`sample 资料.${extension}`);
    expect(fs.readFileSync(file)).toEqual(Buffer.from(bytes));
    expect(native.writeBuffer).toHaveBeenCalledOnce();
  });

  it('retains an original usable JPEG filename and extension', async () => {
    const jpeg = rasterFormats().find(([extension]) => extension === 'jpg')![1];
    await copyImageFile(bytesRequest(jpeg, 'Sample Photo.jpeg'), vi.fn());
    expect(path.basename(publishedPath())).toBe('Sample Photo.jpeg');
  });

  it('copies the existing local file reference after validating its bytes', async () => {
    const source = path.join(directory, 'sample #1%.gif');
    const bytes = gifBytes();
    fs.writeFileSync(source, bytes);
    const read = vi.fn(async () => ({ path: source, bytes }));
    await copyImageFile({ kind: 'path', path: source }, read);
    expect(read).toHaveBeenCalledWith(source);
    expect(publishedPath()).toBe(source);
    expect(fs.existsSync(path.join(directory, 'piskie'))).toBe(false);
  });

  it.each(['CON.svg', '../../', 'bad?:name.svg'])('creates a usable image filename from %s', async (name) => {
    await copyImageFile(bytesRequest(pngBytes(), name), vi.fn());
    expect(path.basename(publishedPath())).toMatch(/^[^<>:"/\\|?*]+\.png$/);
  });

  it('keeps independent published files for successive copies', async () => {
    await copyImageFile(bytesRequest(gifBytes(), 'sample.gif'), vi.fn());
    const first = publishedPath();
    await copyImageFile(bytesRequest(pngBytes(), 'sample.gif'), vi.fn());
    expect(fs.readFileSync(first)).toEqual(Buffer.from(gifBytes()));
    expect(publishedPath()).not.toBe(first);
  });

  it.each([Buffer.from('Not an image'), Buffer.from('<html><svg/></html>'), new Uint8Array(MAX_IMAGE_BYTES + 1)])('rejects unsupported or oversized bytes before publishing', async (bytes) => {
    await expect(copyImageFile(bytesRequest(bytes), vi.fn())).rejects.toThrow();
    expect(native.writeBuffer).not.toHaveBeenCalled();
  });

  it('does not publish when file preparation fails', async () => {
    vi.spyOn(fs.promises, 'writeFile').mockRejectedValueOnce(new Error('Sample disk full'));
    await expect(copyImageFile(bytesRequest(pngBytes()), vi.fn())).rejects.toThrow('Sample disk full');
    expect(native.writeBuffer).not.toHaveBeenCalled();
  });

  it('does not publish after cancellation during source preparation', async () => {
    const controller = new AbortController();
    const read = vi.fn(async () => { controller.abort(new Error('Sample cancellation')); return { path: '/sample/image.png', bytes: pngBytes() }; });
    await expect(copyImageFile({ kind: 'path', path: '/sample/image.png' }, read, controller.signal)).rejects.toThrow('Sample cancellation');
    expect(native.writeBuffer).not.toHaveBeenCalled();
  });
});

describe('bounded remote image reads', () => {
  it('follows HTTP(S) redirects and preserves the final original GIF', async () => {
    const signal = new AbortController().signal;
    const bytes = gifBytes();
    native.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://images.example.test/sample%20image.gif' } }))
      .mockResolvedValueOnce(new Response(bytes));
    await copyImageFile({ kind: 'url', url: 'http://example.test/start' }, vi.fn(), signal);
    expect(native.fetch.mock.calls).toEqual([
      ['http://example.test/start', { signal, redirect: 'manual', credentials: 'omit', cache: 'no-store' }],
      ['https://images.example.test/sample%20image.gif', { signal, redirect: 'manual', credentials: 'omit', cache: 'no-store' }],
    ]);
    expect(path.basename(publishedPath())).toBe('sample image.gif');
    expect(fs.readFileSync(publishedPath())).toEqual(Buffer.from(bytes));
  });

  it.each(['file:///sample/image.png', 'data:image/png;base64,eA==', 'ftp://example.test/image.png'])('rejects %s at both the initial URL and redirect boundary', async (url) => {
    await expect(copyImageFile({ kind: 'url', url }, vi.fn())).rejects.toThrow('HTTP or HTTPS');
    expect(native.fetch).not.toHaveBeenCalled();
    native.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: url } }));
    await expect(copyImageFile({ kind: 'url', url: 'https://example.test/image' }, vi.fn())).rejects.toThrow('HTTP or HTTPS');
    expect(native.fetch).toHaveBeenCalledOnce();
    expect(native.writeBuffer).not.toHaveBeenCalled();
  });

  it('terminates a redirect loop', async () => {
    native.fetch.mockImplementation(async () => new Response(null, { status: 302, headers: { location: '/again' } }));
    await expect(copyImageFile({ kind: 'url', url: 'https://example.test/image' }, vi.fn())).rejects.toThrow('redirects');
    expect(native.writeBuffer).not.toHaveBeenCalled();
  });

  it.each(['header', 'body'])('bounds the remote %s and cancels the stream', async (kind) => {
    const cancel = vi.fn();
    native.fetch.mockResolvedValue(new Response(new ReadableStream({
      start(controller) { if (kind === 'body') controller.enqueue(new Uint8Array(MAX_IMAGE_BYTES + 1)); }, cancel,
    }), { headers: kind === 'header' ? { 'content-length': String(MAX_IMAGE_BYTES + 1) } : {} }));
    await expect(copyImageFile({ kind: 'url', url: 'https://example.test/image' }, vi.fn())).rejects.toThrow('32 MiB');
    expect(cancel).toHaveBeenCalled();
    expect(native.writeBuffer).not.toHaveBeenCalled();
  });

  it('uses request cancellation while waiting for remote bytes', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    native.fetch.mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const copying = copyImageFile({ kind: 'url', url: 'https://example.test/image' }, vi.fn(), controller.signal);
    const rejected = expect(copying).rejects.toThrow();
    await vi.waitFor(() => expect(native.fetch).toHaveBeenCalled());
    controller.abort();
    await rejected;
    expect(cancel).toHaveBeenCalled();
    expect(native.writeBuffer).not.toHaveBeenCalled();
  });

  it('rejects actual network and HTTP failures', async () => {
    native.fetch.mockRejectedValueOnce(new Error('Sample connection failed'));
    await expect(copyImageFile({ kind: 'url', url: 'https://example.test/image' }, vi.fn())).rejects.toThrow('Sample connection failed');
    native.fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(copyImageFile({ kind: 'url', url: 'https://example.test/image' }, vi.fn())).rejects.toThrow('HTTP 404');
    expect(native.writeBuffer).not.toHaveBeenCalled();
  });
});

describe('native clipboard platform boundary', () => {
  it.each([['linux', 'text/uri-list', '\r\n'], ['darwin', 'public.file-url', '']])('publishes the native %s file reference', async (platform, format, suffix) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    const source = '/sample folder/示例 #1%.gif';
    await publishImageFile(source);
    expect(native.writeBuffer).toHaveBeenCalledWith(format, Buffer.from(pathToFileURL(source).href + suffix));
  });

  it('rejects when the native clipboard refuses the reference', async () => {
    native.readBuffer.mockReturnValue(Buffer.alloc(0));
    await expect(publishImageFile('/sample/image.png')).rejects.toThrow('did not accept');
  });

  it('publishes Windows FileDropList through a fixed STA script and sends paths only on stdin', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const end = vi.fn();
    native.execFile.mockImplementation((_command, _args, _options, callback) => {
      queueMicrotask(() => callback(null));
      return { stdin: { on: vi.fn(), end } };
    });
    const signal = new AbortController().signal;
    const source = 'C:\\sample files\\示例 $(example) \' image.gif';
    await publishImageFile(source, signal);
    const [command, args, options] = native.execFile.mock.lastCall!;
    expect(command).toBe('powershell.exe');
    expect(args.slice(0, 4)).toEqual(['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand']);
    const script = Buffer.from(args[4], 'base64').toString('utf16le');
    expect(script).toContain('[System.Windows.Forms.Clipboard]::SetFileDropList($files)');
    expect(script).not.toContain(source);
    expect(end).toHaveBeenCalledWith(Buffer.from(source).toString('base64'));
    expect(options).toEqual({ windowsHide: true, signal });
    expect(native.writeBuffer).not.toHaveBeenCalled();
  });

  it('propagates an actual Windows helper failure', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    native.execFile.mockImplementation((_command, _args, _options, callback) => {
      queueMicrotask(() => callback(new Error('Sample clipboard locked')));
      return { stdin: { on: vi.fn(), end: vi.fn() } };
    });
    await expect(publishImageFile('C:\\sample.gif')).rejects.toThrow('Sample clipboard locked');
  });
});
