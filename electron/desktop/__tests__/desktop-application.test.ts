import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  openExternal: vi.fn(async () => undefined),
  openPath: vi.fn(async () => ''),
  showItemInFolder: vi.fn(),
  readBuffer: vi.fn(() => Buffer.alloc(0)),
  readText: vi.fn(() => ''),
}));

const processes = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: processes.spawn }));

vi.mock('electron', () => ({
  clipboard: { readBuffer: electron.readBuffer, readText: electron.readText },
  net: { isOnline: vi.fn(() => true) },
  shell: {
    openExternal: electron.openExternal,
    openPath: electron.openPath,
    showItemInFolder: electron.showItemInFolder,
  },
}));

import { DesktopApplication } from '../capabilities/desktop-application.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  processes.spawn.mockReset();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  electron.readBuffer.mockImplementation(() => Buffer.alloc(0));
  electron.readText.mockImplementation(() => '');
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'piskie-desktop-files-'));
  temporaryDirectories.push(userDataDirectory);
  const presentation = {
    releaseFilePreview: vi.fn(),
    createFilePreviewUrl: vi.fn((_windowId: number, _filePath: string, _mediaType: string) => (
      'piskie-attachment://preview/opaque-token'
    )),
  };
  const appearance = {
    setColorScheme: vi.fn(),
  };
  const application = new DesktopApplication({
    name: 'Piskie',
    version: '0.1.0',
    userDataDirectory,
    development: false,
    presentation: presentation as never,
    appearance,
    theme: {} as never,
    update: {} as never,
  });
  return { application, appearance, presentation, userDataDirectory };
}

describe('DesktopApplication file and URL handling', () => {
  it('applies the effective renderer color scheme to desktop presentation', () => {
    const { application, appearance } = fixture();

    application.setColorScheme('light');

    expect(appearance.setColorScheme).toHaveBeenCalledWith('light');
  });

  it.each(['win32', 'darwin'] as const)('opens files natively on %s and exposes image previews without reading Base64', async (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    const { application, presentation } = fixture();
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'piskie-external-file-'));
    temporaryDirectories.push(external);
    const file = path.join(external, 'result.png');
    fs.writeFileSync(file, 'file contents');
    const resolved = fs.realpathSync.native(file);

    await expect(application.previewFile(7, file)).resolves.toEqual({
      kind: 'image',
      url: 'piskie-attachment://preview/opaque-token',
      mediaType: 'image/png',
      size: Buffer.byteLength('file contents'),
    });
    expect(presentation.createFilePreviewUrl).toHaveBeenCalledWith(7, resolved, 'image/png');
    await expect(application.openPath(file)).resolves.toBeUndefined();
    expect(electron.openPath).toHaveBeenCalledWith(resolved);
  });

  it('finishes a Linux launch without waiting for inherited viewer streams to close', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const { application, userDataDirectory } = fixture();
    const file = path.join(userDataDirectory, 'sample 资料 #1%.txt');
    fs.writeFileSync(file, 'Fictional sample');
    const launcher = Object.assign(new EventEmitter(), { unref: vi.fn() });
    processes.spawn.mockReturnValue(launcher);

    const opening = application.openPath(file);
    expect(processes.spawn).toHaveBeenCalledWith('xdg-open', [fs.realpathSync.native(file)], expect.objectContaining({
      cwd: fs.realpathSync.native(userDataDirectory), detached: true, stdio: 'ignore',
      env: expect.objectContaining({ MM_NOTTTY: '1' }),
    }));
    // A viewer can keep inherited descriptors alive after the launcher exits.
    launcher.emit('exit', 0, null);
    await expect(opening).resolves.toBeUndefined();
    expect(electron.openPath).not.toHaveBeenCalled();
  });

  it.each(['linux', 'win32', 'darwin'] as const)('allows a slow system open on %s to succeed without a fabricated timeout', async (platform) => {
    vi.useFakeTimers();
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    const { application, userDataDirectory } = fixture();
    const launcher = Object.assign(new EventEmitter(), { unref: vi.fn() });
    processes.spawn.mockReturnValue(launcher);
    let finish!: (result: string) => void;
    if (platform !== 'linux') electron.openPath.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const fulfilled = vi.fn();
    const rejected = vi.fn();
    const opening = application.openPath(userDataDirectory);
    void opening.then(fulfilled, rejected);

    await vi.advanceTimersByTimeAsync(35_000);
    expect(fulfilled).not.toHaveBeenCalled();
    expect(rejected).not.toHaveBeenCalled();
    if (platform === 'linux') launcher.emit('exit', 0, null);
    else finish('');
    await expect(opening).resolves.toBeUndefined();
    await vi.runAllTimersAsync();
    expect(rejected).not.toHaveBeenCalled();
  });

  it.each(['ENOENT', 'EACCES', 'handler-failed'])('reports an actual Linux launch failure: %s', async (failure) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const { application, userDataDirectory } = fixture();
    const launcher = Object.assign(new EventEmitter(), { unref: vi.fn() });
    processes.spawn.mockReturnValue(launcher);
    const opening = application.openPath(userDataDirectory);
    if (failure === 'handler-failed') launcher.emit('exit', 4, null);
    else launcher.emit('error', Object.assign(new Error('Sample launcher unavailable'), { code: failure }));
    await expect(opening).rejects.toMatchObject({
      code: 'unavailable', message: 'The path could not be opened',
    });
  });

  it.each(['win32', 'darwin'] as const)('preserves the native %s launch failure', async (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    const { application, userDataDirectory } = fixture();
    electron.openPath.mockResolvedValueOnce('Failed to open path');
    await expect(application.openPath(userDataDirectory)).rejects.toMatchObject({
      code: 'unavailable', message: 'The path could not be opened',
    });
    expect(processes.spawn).not.toHaveBeenCalled();
  });

  it('resolves explicit event paths without consulting the later clipboard', async () => {
    const { application, presentation } = fixture();
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'piskie-clipboard-files-'));
    temporaryDirectories.push(external);
    const image = path.join(external, 'screen shot.png');
    const text = path.join(external, 'notes.md');
    fs.writeFileSync(image, 'png');
    fs.writeFileSync(text, 'notes');
    const uriList = 'file:///workspace/later-image.png';
    electron.readBuffer.mockImplementation((format: string) => (
      format === 'text/uri-list' ? Buffer.from(uriList) : Buffer.alloc(0)
    ));

    await expect(application.clipboardAttachments(11, { kind: 'paths', paths: [pathToFileURL(image).toString(), text] })).resolves.toEqual([
      {
        name: 'screen shot.png',
        path: fs.realpathSync.native(image),
        size: 3,
        kind: 'image',
        previewUrl: 'piskie-attachment://preview/opaque-token',
      },
      {
        kind: 'file', name: 'notes.md',
        path: fs.realpathSync.native(text),
        size: 5,
      },
    ]);
    expect(presentation.createFilePreviewUrl).toHaveBeenCalledWith(11, fs.realpathSync.native(image), 'image/png', true);
    expect(electron.readBuffer).not.toHaveBeenCalled();
    expect(electron.readText).not.toHaveBeenCalled();
  });

  it('returns ordinary document and archive paths without reading their contents', async () => {
    const { application, presentation, userDataDirectory } = fixture();
    const names = ['sample document.pdf', 'example.docx', 'sample.xlsx', 'example.zip', 'sample.bin'];
    const paths = names.map((name) => path.join(userDataDirectory, name));
    for (const file of paths) fs.writeFileSync(file, Buffer.from([0, 1, 2]));
    const read = vi.spyOn(fs.promises, 'readFile');
    await expect(application.clipboardAttachments(3, { kind: 'paths', paths })).resolves.toEqual(paths.map((file, index) => ({
      kind: 'file', name: names[index], path: fs.realpathSync.native(file), size: 3,
    })));
    expect(read).not.toHaveBeenCalled();
    expect(presentation.createFilePreviewUrl).not.toHaveBeenCalled();
    await expect(application.clipboardAttachments(3, { kind: 'paths', paths: [userDataDirectory] })).rejects.toThrow('A regular file is required');
  });

  it.each(['text/uri-list', 'public.file-url', 'NSFilenamesPboardType', 'FileNameW', 'text/plain'])('preserves an encoded Unicode filename from a %s buffer fixture', async (format) => {
    const { application, userDataDirectory } = fixture();
    const name = 'sample &lt; 资料 #1%25.pdf';
    const file = path.join(userDataDirectory, name);
    fs.writeFileSync(file, 'Sample');
    const content = format === 'NSFilenamesPboardType' ? `<array><string>${file.replaceAll('&', '&amp;')}</string></array>`
      : format === 'FileNameW' ? `${file}\0` : format === 'text/plain' ? file : pathToFileURL(file).toString();
    electron.readBuffer.mockImplementation((candidate: string) => candidate === format
      ? Buffer.from(content, format === 'FileNameW' ? 'utf16le' : 'utf8') : Buffer.alloc(0));
    const text = format === 'text/plain' ? content : '';
    electron.readText.mockReturnValue(text);
    await expect(application.clipboardAttachments(3, {
      kind: 'native', files: [{ name, size: 6 }], text,
    })).resolves.toEqual([{ kind: 'file', name, path: fs.realpathSync.native(file), size: 6 }]);
  });

  it('matches native event metadata to the immediate clipboard snapshot', async () => {
    const { application, userDataDirectory } = fixture();
    const image = path.join(userDataDirectory, 'example.png');
    fs.writeFileSync(image, 'sample');
    electron.readBuffer.mockImplementation((format: string) => format === 'text/uri-list' ? Buffer.from(pathToFileURL(image).toString()) : Buffer.alloc(0));
    const importing = application.clipboardAttachments(4, { kind: 'native', files: [{ name: 'example.png', size: 6 }], text: '' });
    electron.readBuffer.mockImplementation(() => Buffer.alloc(0));
    electron.readText.mockReturnValue('Later clipboard');
    await expect(importing).resolves.toEqual([expect.objectContaining({ kind: 'image', name: 'example.png' })]);
  });

  it('rejects changed or unverifiable native sources instead of importing another clipboard', async () => {
    const { application, presentation, userDataDirectory } = fixture();
    const image = path.join(userDataDirectory, 'example.png'); fs.writeFileSync(image, 'sample');
    electron.readBuffer.mockImplementation((format: string) => format === 'text/uri-list' ? Buffer.from(pathToFileURL(image).toString()) : Buffer.alloc(0));
    await expect(application.clipboardAttachments(4, { kind: 'native', files: [], text: '' })).rejects.toThrow('could not be matched');
    await expect(application.clipboardAttachments(4, { kind: 'native', files: [{ name: 'other.png', size: 6 }], text: '' })).rejects.toThrow('changed');
    expect(presentation.createFilePreviewUrl).not.toHaveBeenCalled();
  });

  it('fails an explicit batch atomically when any path cannot be resolved', async () => {
    const { application, presentation, userDataDirectory } = fixture();
    const image = path.join(userDataDirectory, 'example.png'); fs.writeFileSync(image, 'sample');
    await expect(application.clipboardAttachments(4, { kind: 'paths', paths: [image, path.join(userDataDirectory, 'missing.png')] })).rejects.toThrow('does not exist');
    expect(presentation.createFilePreviewUrl).not.toHaveBeenCalled();
  });

  it.each(['clipboard', 'preview'])('does not publish %s sources after cancellation during filesystem resolution', async (kind) => {
    const { application, presentation } = fixture();
    const controller = new AbortController();
    let resume!: (stats: fs.Stats) => void;
    vi.spyOn(fs.promises, 'realpath').mockResolvedValue('/workspace/sample.png');
    const stat = vi.spyOn(fs.promises, 'stat').mockReturnValue(new Promise<fs.Stats>((resolve) => { resume = resolve; }));
    const operation = kind === 'clipboard'
      ? application.clipboardAttachments(7, { kind: 'paths', paths: ['/workspace/sample.png'] }, controller.signal)
      : application.previewFile(7, '/workspace/sample.png', controller.signal);
    await Promise.resolve();
    expect(stat).toHaveBeenCalledOnce();
    controller.abort(new Error('Example request cancelled'));
    resume({ isFile: () => true, size: 8 } as fs.Stats);
    await expect(operation).rejects.toThrow('Example request cancelled');
    expect(presentation.createFilePreviewUrl).not.toHaveBeenCalled();
  });

  it('releases previously published batch tokens when a later source cannot be published', async () => {
    const { application, presentation } = fixture();
    vi.spyOn(fs.promises, 'realpath').mockImplementation(async (value) => String(value));
    vi.spyOn(fs.promises, 'stat').mockResolvedValue({ isFile: () => true, size: 8 } as fs.Stats);
    presentation.createFilePreviewUrl.mockReturnValueOnce('piskie-attachment://preview/first')
      .mockImplementationOnce(() => { throw new Error('Example window closed'); });
    await expect(application.clipboardAttachments(7, {
      kind: 'paths', paths: ['/workspace/first.png', '/workspace/second.png'],
    }, new AbortController().signal)).rejects.toThrow('Example window closed');
    expect(presentation.releaseFilePreview).toHaveBeenCalledExactlyOnceWith(7, 'piskie-attachment://preview/first');
  });

  it('previews bounded text and classifies unsupported binary files', async () => {
    const { application, presentation } = fixture();
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'piskie-preview-files-'));
    temporaryDirectories.push(external);
    const markdown = path.join(external, 'ROADMAP.md');
    const oversized = path.join(external, 'large.txt');
    const binary = path.join(external, 'payload.bin');
    const pdf = path.join(external, 'report.pdf');
    fs.writeFileSync(markdown, '# Roadmap\n\n- ship it\n');
    fs.writeFileSync(oversized, 'x'.repeat(400 * 1024));
    fs.writeFileSync(binary, Buffer.from([0x41, 0x00, 0x42]));
    fs.writeFileSync(pdf, 'not a real pdf');

    await expect(application.previewFile(7, markdown)).resolves.toEqual({
      kind: 'text',
      content: '# Roadmap\n\n- ship it\n',
      truncated: false,
      size: 21,
    });
    await expect(application.previewFile(7, oversized)).resolves.toMatchObject({
      kind: 'text',
      truncated: true,
      size: 400 * 1024,
    });
    await expect(application.previewFile(7, binary)).resolves.toEqual({
      kind: 'file',
      size: 3,
    });
    await expect(application.previewFile(7, pdf)).resolves.toEqual({
      kind: 'file',
      mediaType: 'application/pdf',
      size: 14,
    });
    expect(presentation.createFilePreviewUrl).not.toHaveBeenCalled();
  });

  it('reveals any existing absolute file or directory', () => {
    const { application } = fixture();
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'piskie-reveal-path-'));
    temporaryDirectories.push(external);
    const file = path.join(external, 'report.txt');
    fs.writeFileSync(file, 'private');

    application.revealPath(external);
    application.revealPath(file);

    expect(electron.showItemInFolder).toHaveBeenNthCalledWith(1, fs.realpathSync.native(external));
    expect(electron.showItemInFolder).toHaveBeenNthCalledWith(2, fs.realpathSync.native(file));
  });

  it('rejects relative or missing filesystem targets', async () => {
    const { application } = fixture();

    expect(() => application.revealPath('relative/file.txt')).toThrow('absolute path');
    await expect(application.previewFile(7, '/definitely/missing/piskie-path'))
      .rejects.toThrow('does not exist');
    await expect(application.openPath('relative/file.txt')).rejects.toThrow('absolute path');
    await expect(application.openPath('/missing/sample-document.txt')).rejects.toThrow('does not exist');
    expect(processes.spawn).not.toHaveBeenCalled();
    expect(electron.showItemInFolder).not.toHaveBeenCalled();
    expect(electron.openPath).not.toHaveBeenCalled();
  });

  it('allows HTTP(S) external URLs without embedded credentials', async () => {
    const { application } = fixture();
    await expect(application.openExternal('https://example.com/docs')).resolves.toBeUndefined();
    await expect(application.openExternal('file:///tmp/secret')).rejects.toThrow('scheme');
    await expect(application.openExternal('https://user:pass@example.com/')).rejects.toThrow(
      'credentials',
    );
    expect(electron.openExternal).toHaveBeenCalledOnce();
  });
});
