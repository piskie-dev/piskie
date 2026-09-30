import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
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
  writeBuffer: vi.fn(),
  writeImage: vi.fn(),
  image: { isEmpty: () => false, getSize: () => ({ width: 2, height: 2 }) },
  decodeImage: vi.fn(),
  readText: vi.fn(() => ''),
}));

const processes = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn: processes.spawn,
}));

vi.mock('electron', () => ({
  clipboard: {
    readBuffer: electron.readBuffer, readText: electron.readText, writeBuffer: electron.writeBuffer,
    writeImage: electron.writeImage, readImage: () => electron.image,
  },
  net: { isOnline: vi.fn(() => true) },
  shell: {
    openExternal: electron.openExternal,
    openPath: electron.openPath,
    showItemInFolder: electron.showItemInFolder,
  },
}));

vi.mock('../capabilities/image-clipboard-decoder.js', () => ({
  decodeClipboardImage: electron.decodeImage.mockImplementation(async () => electron.image),
}));

import { gifBytes } from '../../../src/features/console/attachments/__tests__/fixtures.js';
import { DesktopApplication } from '../capabilities/desktop-application.js';
import { createDesktopController } from '../capabilities/desktop-controller.js';
import { DESKTOP_OPERATIONS, DESKTOP_TOPICS, type WorkspaceInfo } from '../../../shared/electron-contracts/desktop.js';
import { createElectronPiskieClient } from '../../transport/electron/piskie-client.js';

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
    resolveFilePreviewPath: vi.fn<() => string | undefined>(),
    createFilePreviewUrl: vi.fn((_windowId: number, _filePath: string, _mediaType: string) => (
      'piskie-attachment://preview/opaque-token'
    )),
  };
  const appearance = {
    setColorScheme: vi.fn(),
  };
  const defaultWorkspaceDirectory = path.join(userDataDirectory, 'runtime-default');
  const paths = {
    getDefaultWorkspaceDir: () => defaultWorkspaceDirectory,
    ensureWorkspace: vi.fn(async () => { await fs.promises.mkdir(defaultWorkspaceDirectory, { recursive: true }); }),
  };
  const application = new DesktopApplication({
    name: 'Piskie',
    version: '0.1.0',
    userDataDirectory,
    paths,
    development: false,
    presentation: presentation as never,
    appearance,
    theme: {} as never,
    update: {} as never,
  });
  return { application, appearance, presentation, userDataDirectory, paths };
}

function pathIdentityFixture() {
  const base = fixture();
  const file = path.join(base.userDataDirectory, 'sample.txt ');
  const neighbor = path.join(base.userDataDirectory, 'sample.txt');
  fs.writeFileSync(file, 'chosen content');
  fs.writeFileSync(neighbor, 'nearby content');
  const controller = createDesktopController(base.application);
  const context = { generation: 'sample-generation', connectionId: 'sample-connection', windowId: 7, signal: new AbortController().signal };
  const request = async (id: string, input: unknown) => {
    const operation = controller.operations.find((candidate) => candidate.id === id)!;
    return operation.execute(context, operation.input.parse(input));
  };
  const getPathForFile = vi.fn(() => file);
  const { desktop } = createElectronPiskieClient({
    transport: { request } as never, version: 'test', platform: 'linux', getPathForFile,
  });
  return { ...base, file, neighbor, controller, context, desktop };
}

// Win32 filename normalization cannot create these two distinct trailing-space names.
describe.skipIf(process.platform === 'win32')('desktop filesystem path identity', () => {
  it('copies and pastes the OS path while a same-sized trimmed neighbor also exists', async () => {
    const { desktop, file, neighbor } = pathIdentityFixture();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    electron.readBuffer.mockImplementation((format: string) => format === 'text/uri-list'
      ? electron.writeBuffer.mock.lastCall![1] : Buffer.alloc(0));
    await expect(desktop.files.copyFile(file)).resolves.toBeUndefined();
    expect(electron.writeBuffer).toHaveBeenCalledExactlyOnceWith(
      'text/uri-list', Buffer.from(pathToFileURL(fs.realpathSync.native(file)).href + '\r\n'),
    );
    expect(electron.writeBuffer.mock.lastCall![1].toString()).toContain('sample.txt%20\r\n');
    electron.readBuffer.mockClear();
    const osPath = desktop.files.getPathForFile(new File(['chosen content'], 'sample.txt '));
    const pasted = await desktop.system.clipboardAttachments({ kind: 'paths', paths: [osPath, neighbor] });
    expect(pasted.map((item) => item.path)).toEqual([fs.realpathSync.native(file), fs.realpathSync.native(neighbor)]);
    expect(pasted.map((item) => fs.readFileSync(item.path, 'utf8'))).toEqual(['chosen content', 'nearby content']);
    expect(electron.readBuffer).not.toHaveBeenCalled();
  });

  it('opens, reveals, previews and observes the exact path through controller validation', async () => {
    const { desktop, file, neighbor, controller, context } = pathIdentityFixture();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const launcher = Object.assign(new EventEmitter(), { unref: vi.fn() });
    processes.spawn.mockReturnValue(launcher);
    const opening = desktop.system.openPath(file);
    expect(processes.spawn).toHaveBeenCalledWith('xdg-open', [fs.realpathSync.native(file)], expect.any(Object));
    launcher.emit('exit', 0, null);
    await opening;
    await desktop.system.revealPath(file);
    expect(electron.showItemInFolder).toHaveBeenCalledExactlyOnceWith(fs.realpathSync.native(file));
    const preview = await desktop.files.preview(file);
    expect(preview).toMatchObject({ kind: 'text', content: 'chosen content' });
    expect(await desktop.files.revision(file)).toBe(preview.revision);
    expect(await desktop.files.revision(neighbor)).not.toBe(preview.revision);
    const topic = controller.topics.find((candidate) => candidate.id === DESKTOP_TOPICS.fileChanges)!;
    const observation = await topic.open(context, topic.input.parse({ path: file }), vi.fn());
    try { expect(observation.snapshot).toBe(preview.revision); }
    finally { observation.dispose(); }
  });

  it('opens a workspace directory without selecting its trimmed neighbor', async () => {
    const { desktop, userDataDirectory } = pathIdentityFixture();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const directory = path.join(userDataDirectory, 'sample folder ');
    fs.mkdirSync(directory);
    fs.mkdirSync(directory.trimEnd());
    const launcher = Object.assign(new EventEmitter(), { unref: vi.fn() });
    processes.spawn.mockReturnValue(launcher);
    const opening = desktop.system.openWorkspace(directory);
    expect(processes.spawn).toHaveBeenCalledWith('xdg-open', [fs.realpathSync.native(directory)], expect.any(Object));
    launcher.emit('exit', 0, null);
    await opening;
  });

  it.each(['text/uri-list', 'public.file-url', 'NSFilenamesPboardType', 'FileNameW', 'text/plain'])('preserves native filename whitespace from a %s buffer fixture', async (format) => {
    const { desktop, file } = pathIdentityFixture();
    const content = format === 'NSFilenamesPboardType' ? `<array><string>${file}</string></array>`
      : format === 'FileNameW' ? `${file}\0` : pathToFileURL(file).href + '\r\n';
    electron.readBuffer.mockImplementation((candidate: string) => candidate === format
      ? Buffer.from(content, format === 'FileNameW' ? 'utf16le' : 'utf8') : Buffer.alloc(0));
    const text = format === 'text/plain' ? content : '';
    electron.readText.mockReturnValue(text);
    const pasted = await desktop.system.clipboardAttachments({
      kind: 'native', files: [{ name: 'sample.txt ', size: Buffer.byteLength('chosen content') }], text,
    });
    expect(pasted).toEqual([{
      kind: 'file', name: 'sample.txt ', path: fs.realpathSync.native(file), size: Buffer.byteLength('chosen content'),
    }]);
    expect(fs.readFileSync(pasted[0]!.path, 'utf8')).toBe('chosen content');
  });

  it('keeps surrounding whitespace as delimiters in plain-text path input', async () => {
    const { desktop, neighbor } = pathIdentityFixture();
    const text = ` \t${neighbor} \r\n`;
    electron.readText.mockReturnValue(text);
    const pasted = await desktop.system.clipboardAttachments({
      kind: 'native', files: [{ name: 'sample.txt', size: Buffer.byteLength('nearby content') }], text,
    });
    expect(pasted[0]!.path).toBe(fs.realpathSync.native(neighbor));
    expect(fs.readFileSync(pasted[0]!.path, 'utf8')).toBe('nearby content');
  });
});

describe('DesktopApplication file and URL handling', () => {
  it('returns the default workspace path without creating the directory', () => {
    const { application, paths } = fixture();
    const workspace = paths.getDefaultWorkspaceDir();

    expect(application.defaultWorkspacePath()).toBe(workspace);
    expect(paths.ensureWorkspace).not.toHaveBeenCalled();
    expect(fs.existsSync(workspace)).toBe(false);
  });

  it('captures a preview source before release and copies its image contents', async () => {
    const { application, presentation, userDataDirectory } = fixture();
    const source = path.join(userDataDirectory, 'sample image.gif');
    fs.writeFileSync(source, gifBytes());
    presentation.resolveFilePreviewPath.mockReturnValue(source);
    const url = 'piskie-attachment://preview/sample-token';
    const copying = application.copyImage(7, { kind: 'preview', url });
    expect(presentation.resolveFilePreviewPath).toHaveBeenCalledWith(7, url);
    application.releasePreview(7, url);
    presentation.resolveFilePreviewPath.mockReturnValue(undefined);
    await copying;
    expect(electron.decodeImage).toHaveBeenCalledWith(Buffer.from(gifBytes()), 'image/gif', undefined);
    expect(electron.writeImage).toHaveBeenCalledExactlyOnceWith(electron.image);
    expect(fs.readFileSync(source)).toEqual(Buffer.from(gifBytes()));
    expect(fs.existsSync(source)).toBe(true);
    await expect(application.copyImage(8, { kind: 'preview', url })).rejects.toThrow('no longer available');
  });

  it('previews the physical text target when a directory symlink is followed by dotdot', async () => {
    const { application, userDataDirectory } = fixture();
    const nested = path.join(userDataDirectory, 'physical', 'nested');
    fs.mkdirSync(nested, { recursive: true });
    const physical = path.join(userDataDirectory, 'physical', 'sample.txt');
    const lexical = path.join(userDataDirectory, 'sample.txt');
    fs.writeFileSync(physical, 'physical contents');
    fs.writeFileSync(lexical, 'lexical contents');
    const link = path.join(userDataDirectory, 'linked-directory');
    fs.symlinkSync(nested, link, 'junction');
    const target = `${link}${path.sep}..${path.sep}sample.txt`;
    const preview = await application.previewFile(7, target);
    expect(preview).toMatchObject({ kind: 'text', content: 'physical contents' });
    expect(preview.revision).toBe(await application.fileRevision(physical));
    expect(preview.revision).not.toBe(await application.fileRevision(lexical));
  });

  it('copies the physical image target when a directory symlink is followed by dotdot', async () => {
    const { application, presentation, userDataDirectory } = fixture();
    const nested = path.join(userDataDirectory, 'physical', 'nested');
    fs.mkdirSync(nested, { recursive: true });
    const physical = path.join(userDataDirectory, 'physical', 'sample.gif');
    const lexical = path.join(userDataDirectory, 'sample.gif');
    fs.writeFileSync(physical, gifBytes());
    fs.writeFileSync(lexical, 'unrelated lexical contents');
    const link = path.join(userDataDirectory, 'linked-directory');
    fs.symlinkSync(nested, link, 'junction');
    const target = `${link}${path.sep}..${path.sep}sample.gif`;
    const preview = await application.previewFile(7, target);
    expect(preview.kind).toBe('image');
    expect(presentation.createFilePreviewUrl).toHaveBeenCalledWith(7, fs.realpathSync.native(physical), 'image/gif');
    await application.copyImage(7, { kind: 'path', path: target });
    expect(electron.decodeImage).toHaveBeenCalledWith(Buffer.from(gifBytes()), 'image/gif', undefined);
    expect(electron.writeImage).toHaveBeenCalledExactlyOnceWith(electron.image);
    expect(fs.readFileSync(physical)).toEqual(Buffer.from(gifBytes()));
    expect(fs.readFileSync(lexical, 'utf8')).toBe('unrelated lexical contents');
  });

  it('rejects a missing or directory copy source before publishing', async () => {
    const { application, userDataDirectory } = fixture();
    await expect(application.copyImage(7, { kind: 'path', path: path.join(userDataDirectory, 'missing.png') })).rejects.toThrow('does not exist');
    await expect(application.copyImage(7, { kind: 'path', path: userDataDirectory })).rejects.toThrow('image file');
    expect(electron.writeImage).not.toHaveBeenCalled();
  });

  it.each(['file', 'directory'] as const)('copies a canonical %s reference without reading its contents', async (kind) => {
    const { application, userDataDirectory } = fixture();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.spyOn(os, 'homedir').mockReturnValue(userDataDirectory);
    const target = path.join(userDataDirectory, 'sample 资料 #1%');
    if (kind === 'file') fs.writeFileSync(target, 'Sample contents');
    else fs.mkdirSync(target);
    const link = path.join(userDataDirectory, 'sample-link');
    fs.symlinkSync(target, link, kind === 'directory' ? 'junction' : 'file');
    const read = vi.spyOn(fs.promises, 'open');
    electron.readBuffer.mockImplementation(() => electron.writeBuffer.mock.lastCall![1]);
    await application.copyFile('~/sample-link');
    expect(electron.writeBuffer).toHaveBeenCalledExactlyOnceWith(
      'text/uri-list', Buffer.from(pathToFileURL(fs.realpathSync.native(target)).href + '\r\n'),
    );
    expect(read).not.toHaveBeenCalled();
    expect(electron.writeImage).not.toHaveBeenCalled();
  });

  it('rejects relative, missing and cancelled file copies before publication', async () => {
    const { application, userDataDirectory } = fixture();
    await expect(application.copyFile('relative/sample.txt')).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(application.copyFile(path.join(userDataDirectory, 'missing.txt'))).rejects.toMatchObject({ code: 'not-found' });
    await expect(application.copyFile(userDataDirectory, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
    expect(electron.writeBuffer).not.toHaveBeenCalled();
  });

  it.each(['implicit', 'recorded'] as const)('initializes the missing %s default workspace through its owner before describing it', async (selection) => {
    const { application, paths } = fixture();
    const workspace = paths.getDefaultWorkspaceDir();
    expect(fs.existsSync(workspace)).toBe(false);
    await expect(application.workspaceInfo(selection === 'implicit' ? undefined : workspace))
      .resolves.toEqual({ path: workspace, git: null });
    expect(paths.ensureWorkspace).toHaveBeenCalledExactlyOnceWith();
    expect(fs.statSync(workspace).isDirectory()).toBe(true);
  });

  it('reports a missing explicit workspace without creating it or the default directory', async () => {
    const { application, userDataDirectory, paths } = fixture();
    const workspace = path.join(userDataDirectory, 'missing-project');
    await expect(application.workspaceInfo(workspace)).resolves.toEqual({
      path: workspace, git: null, error: expect.stringContaining('ENOENT'),
    });
    expect(paths.ensureWorkspace).not.toHaveBeenCalled();
    expect(fs.existsSync(workspace)).toBe(false);
    expect(fs.existsSync(paths.getDefaultWorkspaceDir())).toBe(false);
  });

  it('keeps the default path and exposes initialization errors when that path is occupied by a file', async () => {
    const { application, paths } = fixture();
    const workspace = paths.getDefaultWorkspaceDir();
    fs.writeFileSync(workspace, 'Sample file');
    await expect(application.workspaceInfo()).resolves.toEqual({
      path: workspace, git: null, error: expect.stringContaining('EEXIST'),
    });
    expect(fs.readFileSync(workspace, 'utf8')).toBe('Sample file');
  });

  it('validates and routes branch creation from the public controller to real Git', async () => {
    const { application, paths } = fixture();
    const workspace = paths.getDefaultWorkspaceDir();
    await paths.ensureWorkspace();
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: workspace });
    const controller = createDesktopController(application);
    const create = controller.operations.find((operation) => operation.id === DESKTOP_OPERATIONS.createWorkspaceBranch)!;
    const context = { generation: 'sample-generation', connectionId: 'sample-connection', windowId: 1, signal: new AbortController().signal };
    const base = { kind: 'unborn', name: 'main' };
    expect(create.input.safeParse([workspace, 'feature/new']).success).toBe(false);
    expect(create.input.safeParse([workspace, 'feature/new', { ...base, extra: true }]).success).toBe(false);
    expect(create.input.safeParse([workspace, 'feature/new', { kind: 'detached', commit: '--invalid' }]).success).toBe(false);
    const result = await create.execute(context, create.input.parse([workspace, 'feature/new', base])) as WorkspaceInfo;
    expect(result.git).toMatchObject({ head: { kind: 'unborn', name: 'feature/new' }, dirtyFileCount: 0 });
    await expect(create.execute(context, create.input.parse([workspace, 'invalid name', result.git!.head])))
      .rejects.toThrow('not a valid branch name');
    expect((await application.workspaceInfo(workspace)).git?.head).toEqual({ kind: 'unborn', name: 'feature/new' });
  });

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
      revision: expect.any(String),
      url: 'piskie-attachment://preview/opaque-token',
      mediaType: 'image/png',
      size: Buffer.byteLength('file contents'),
    });
    expect(presentation.createFilePreviewUrl).toHaveBeenCalledWith(7, resolved, 'image/png');
    await expect(application.openPath(file)).resolves.toBeUndefined();
    expect(electron.openPath).toHaveBeenCalledWith(resolved);
  });

  it.each([
    ['vector.svg', 'image/svg+xml'],
    ['photo.avif', 'image/avif'],
    ['favicon.ico', 'image/vnd.microsoft.icon'],
  ])('exposes %s as a direct image preview', async (name, mediaType) => {
    const { application, presentation, userDataDirectory } = fixture();
    const file = path.join(userDataDirectory, name);
    fs.writeFileSync(file, 'fictional image bytes');

    await expect(application.previewFile(7, file)).resolves.toEqual({
      kind: 'image',
      revision: expect.any(String),
      url: 'piskie-attachment://preview/opaque-token',
      mediaType,
      size: Buffer.byteLength('fictional image bytes'),
    });
    expect(presentation.createFilePreviewUrl).toHaveBeenCalledWith(
      7,
      fs.realpathSync.native(file),
      mediaType,
    );
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
  });

  it('imports a directory path without reading it or treating its name as an image', async () => {
    const { application, presentation, userDataDirectory } = fixture();
    const directory = path.join(userDataDirectory, 'sample folder.png');
    fs.mkdirSync(directory);

    await expect(application.clipboardAttachments(3, { kind: 'paths', paths: [directory] })).resolves.toEqual([{
      kind: 'file',
      name: 'sample folder.png',
      path: fs.realpathSync.native(directory),
      size: 0,
    }]);
    expect(presentation.createFilePreviewUrl).not.toHaveBeenCalled();
    await expect(application.previewFile(3, directory)).resolves.toEqual({ kind: 'directory', revision: expect.any(String) });
  });

  it('keeps preview-only image formats out of model image attachments', async () => {
    const { application, presentation, userDataDirectory } = fixture();
    const names = ['vector.svg', 'photo.avif', 'favicon.ico'];
    const paths = names.map((name) => path.join(userDataDirectory, name));
    for (const file of paths) fs.writeFileSync(file, 'fictional image bytes');

    await expect(application.clipboardAttachments(3, { kind: 'paths', paths })).resolves.toEqual(
      paths.map((file, index) => ({
        kind: 'file',
        name: names[index],
        path: fs.realpathSync.native(file),
        size: Buffer.byteLength('fictional image bytes'),
      })),
    );
    expect(presentation.createFilePreviewUrl).not.toHaveBeenCalled();
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
      revision: expect.any(String),
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
      revision: expect.any(String),
      size: 3,
    });
    await expect(application.previewFile(7, pdf)).resolves.toEqual({
      kind: 'file',
      revision: expect.any(String),
      mediaType: 'application/pdf',
      size: 14,
    });
    expect(presentation.createFilePreviewUrl).not.toHaveBeenCalled();
  });

  it.each(['sample folder', '.示例目录', 'sample folder.png', 'sample folder.md'])(
    'describes the directory %s without reading its contents or creating an image preview', async (name) => {
      const { application, presentation, userDataDirectory } = fixture();
      const directory = path.join(userDataDirectory, name);
      fs.mkdirSync(directory);
      const open = vi.spyOn(fs.promises, 'open');
      const read = vi.spyOn(fs.promises, 'readFile');
      const list = vi.spyOn(fs.promises, 'readdir');

      await expect(application.previewFile(7, directory)).resolves.toEqual({ kind: 'directory', revision: expect.any(String) });

      expect(open).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(list).not.toHaveBeenCalled();
      expect(presentation.createFilePreviewUrl).not.toHaveBeenCalled();
    },
  );

  it('previews a complete home-relative file path with spaces and Unicode', async () => {
    const { application, userDataDirectory } = fixture();
    vi.spyOn(os, 'homedir').mockReturnValue(userDataDirectory);
    const file = path.join(userDataDirectory, 'sample folder', '示例 notes.md');
    fs.mkdirSync(path.dirname(file));
    const content = '# Sample\n\nExample contents.\n';
    fs.writeFileSync(file, content);

    await expect(application.previewFile(7, '~/sample folder/示例 notes.md')).resolves.toEqual({
      kind: 'text',
      revision: expect.any(String),
      content,
      truncated: false,
      size: Buffer.byteLength(content),
    });
  });

  it.each(['sample.txt', 'sample.png', 'sample.pdf', 'sample.bin', 'sample-directory'])('matches metadata queries to the %s preview revision', async (name) => {
    const { application, userDataDirectory } = fixture();
    const target = path.join(userDataDirectory, name);
    if (name === 'sample-directory') fs.mkdirSync(target);
    else fs.writeFileSync(target, name.endsWith('.bin') ? Buffer.from([0, 1, 2]) : 'Sample text');
    const revision = await application.fileRevision(target);
    const preview = await application.previewFile(7, target);
    expect(preview.revision).toBe(revision);
  });

  it('keeps the pre-read revision when a file is replaced between stat and open', async () => {
    const { application, userDataDirectory } = fixture();
    const file = path.join(userDataDirectory, 'sample.txt');
    fs.writeFileSync(file, 'before');
    const revision = await application.fileRevision(file);
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args) => {
      const replacement = path.join(userDataDirectory, 'replacement.txt');
      fs.writeFileSync(replacement, 'after!');
      fs.renameSync(replacement, file);
      return open(...args);
    });
    const preview = await application.previewFile(7, file);
    expect(preview).toMatchObject({ kind: 'text', content: 'after!', revision });
    expect(preview.revision).not.toBe(await application.fileRevision(file));
  });

  it('keeps the pre-read revision when an open handle reads the old file after replacement', async () => {
    const { application, userDataDirectory } = fixture();
    const file = path.join(userDataDirectory, 'sample.txt');
    fs.writeFileSync(file, 'before');
    const revision = await application.fileRevision(file);
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      const replacement = path.join(userDataDirectory, 'replacement.txt');
      fs.writeFileSync(replacement, 'after!');
      fs.renameSync(replacement, file);
      return handle;
    });
    const preview = await application.previewFile(7, file);
    expect(preview).toMatchObject({ kind: 'text', content: 'before', revision });
    expect(preview.revision).not.toBe(await application.fileRevision(file));
  });

  it('limits asynchronous preview reads to 384 KiB plus one byte', async () => {
    const { application, userDataDirectory } = fixture();
    const file = path.join(userDataDirectory, 'large.txt');
    fs.writeFileSync(file, 'x'.repeat(512 * 1024));
    const open = fs.promises.open.bind(fs.promises);
    const lengths: number[] = [];
    vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      const read = handle.read.bind(handle);
      vi.spyOn(handle, 'read').mockImplementation((...readArgs: Parameters<typeof handle.read>) => {
        lengths.push(readArgs[2] as number);
        return read(...readArgs);
      });
      return handle;
    });
    const preview = await application.previewFile(7, file);
    expect(preview).toMatchObject({ kind: 'text', truncated: true });
    expect(lengths).toEqual([384 * 1024 + 1]);
  });

  it('reveals home-relative files, directories, and the home directory with canonical paths', () => {
    const { application, userDataDirectory } = fixture();
    vi.spyOn(os, 'homedir').mockReturnValue(userDataDirectory);
    const directory = path.join(userDataDirectory, 'sample folder');
    fs.mkdirSync(directory);
    const file = path.join(directory, '示例 notes.md');
    fs.writeFileSync(file, 'Sample contents');
    fs.symlinkSync(directory, path.join(userDataDirectory, 'linked folder'), 'junction');

    for (const [input, target] of [
      ['~', userDataDirectory],
      ['~/', userDataDirectory],
      ['~/sample folder', directory],
      ['~/sample folder/示例 notes.md', file],
      ['~/linked folder/示例 notes.md', file],
    ]) {
      application.revealPath(input);
      expect(electron.showItemInFolder).toHaveBeenLastCalledWith(fs.realpathSync.native(target));
    }
  });

  it('describes home-relative directories and keeps missing paths as errors', async () => {
    const { application, presentation, userDataDirectory } = fixture();
    vi.spyOn(os, 'homedir').mockReturnValue(userDataDirectory);
    fs.mkdirSync(path.join(userDataDirectory, 'sample folder', '.示例目录.png'), { recursive: true });
    const open = vi.spyOn(fs.promises, 'open');
    const read = vi.spyOn(fs.promises, 'readFile');

    for (const target of ['~', '~/', '~/sample folder', '~/sample folder/.示例目录.png']) {
      await expect(application.previewFile(7, target)).resolves.toEqual({ kind: 'directory', revision: expect.any(String) });
    }
    expect(open).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(presentation.createFilePreviewUrl).not.toHaveBeenCalled();
    await expect(application.previewFile(7, '~/missing.txt')).rejects.toMatchObject({
      code: 'not-found', message: 'The requested path does not exist',
    });
    expect(() => application.revealPath('~/missing.txt')).toThrow('The requested path does not exist');
    expect(electron.showItemInFolder).not.toHaveBeenCalled();
  });

  it.each(['~sample/file.txt', '$HOME/file.txt'])('rejects unsupported shell path syntax: %s', async (target) => {
    const { application } = fixture();

    await expect(application.previewFile(7, target)).rejects.toThrow('absolute path');
    expect(() => application.revealPath(target)).toThrow('absolute path');
    await expect(application.openPath(target)).rejects.toThrow('absolute path');
    expect(processes.spawn).not.toHaveBeenCalled();
    expect(electron.showItemInFolder).not.toHaveBeenCalled();
    expect(electron.openPath).not.toHaveBeenCalled();
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
    await expect(application.previewFile(7, 'relative/file.txt')).rejects.toThrow('absolute path');
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
