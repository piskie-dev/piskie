import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ writeBuffer: vi.fn(), readBuffer: vi.fn(), execFile: vi.fn() }));
vi.mock('electron', () => ({ clipboard: native }));
vi.mock('node:child_process', () => ({ execFile: native.execFile }));
import { publishFileReference } from '../capabilities/file-clipboard.js';

beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  native.readBuffer.mockImplementation(() => native.writeBuffer.mock.lastCall![1]);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe('native file clipboard platform boundary', () => {
  it.each([['linux', 'text/uri-list', '\r\n'], ['darwin', 'public.file-url', '']])('publishes the native %s file reference', async (platform, format, suffix) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    const source = '/sample folder/示例 #1%.txt';
    await publishFileReference(source);
    expect(native.writeBuffer).toHaveBeenCalledExactlyOnceWith(format, Buffer.from(pathToFileURL(source).href + suffix));
  });

  it('rejects when the native clipboard refuses the reference', async () => {
    native.readBuffer.mockReturnValue(Buffer.alloc(0));
    await expect(publishFileReference('/sample/document.txt')).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('publishes Windows FileDropList through a fixed STA script and sends paths only on stdin', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const end = vi.fn();
    native.execFile.mockImplementation((_command, _args, _options, callback) => {
      queueMicrotask(() => callback(null));
      return { stdin: { on: vi.fn(), end } };
    });
    const signal = new AbortController().signal;
    const source = 'C:\\sample files\\示例 $(example) \' document.txt';
    await publishFileReference(source, signal);
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
    await expect(publishFileReference('C:\\sample.txt')).rejects.toThrow('Sample clipboard locked');
  });
});
