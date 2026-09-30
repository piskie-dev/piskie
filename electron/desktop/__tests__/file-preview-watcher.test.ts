import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilePreviewWatcher, readFileRevision, resolvePreviewPath } from '../capabilities/file-preview-watcher.js';

const directories: string[] = [];
const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'preview-watch-')));
  directories.push(directory);
  const file = path.join(directory, 'sample.txt');
  fs.writeFileSync(file, 'alpha');
  return { directory, file, watcher: new FilePreviewWatcher() };
}

function fakeWatch() {
  const handle = Object.assign(new EventEmitter(), { close: vi.fn() });
  let change!: (event: string, filename: string | null) => void;
  const watch = vi.spyOn(fs, 'watch').mockImplementation((_directory, _options, listener) => {
    change = listener as typeof change;
    return handle as unknown as fs.FSWatcher;
  });
  return { handle, watch, change: (name: string | null = 'sample.txt') => change('rename', name) };
}

async function observe(watcher: FilePreviewWatcher, file: string, listener = vi.fn(), onError = vi.fn()) {
  const subscription = await watcher.observe(file, listener, undefined, onError);
  disposers.push(subscription.dispose);
  return { ...subscription, listener, onError };
}

async function expectRevision(listener: ReturnType<typeof vi.fn>, file: string, count: number) {
  await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(count), { interval: 20, timeout: 5_000 });
  const revision = await readFileRevision(file);
  expect(listener).toHaveBeenLastCalledWith(revision);
  return revision;
}

describe('file preview metadata', () => {
  it('uses the same metadata token as previews without opening or reading the body', async () => {
    const { file } = fixture();
    const open = vi.spyOn(fs.promises, 'open');
    const read = vi.spyOn(fs.promises, 'readFile');
    const syncRead = vi.spyOn(fs, 'readFileSync');
    const metadata = await resolvePreviewPath(file);
    const revision = await readFileRevision(file);
    expect(revision).toBe(metadata.revision);
    expect(revision).toMatch(/^\d+:\d+:/);
    expect(open).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(syncRead).not.toHaveBeenCalled();
  });

  it('expands home-relative paths, follows links, and returns null for missing targets', async () => {
    const { directory, file } = fixture();
    vi.spyOn(os, 'homedir').mockReturnValue(directory);
    const link = path.join(directory, 'sample-link.txt');
    fs.symlinkSync(file, link);
    expect(await readFileRevision('~/sample.txt')).toBe(await readFileRevision(link));
    fs.unlinkSync(file);
    await expect(readFileRevision(link)).resolves.toBeNull();
    await expect(readFileRevision('~/absent.txt')).resolves.toBeNull();
    await expect(resolvePreviewPath(file)).rejects.toMatchObject({ code: 'not-found' });
    await expect(readFileRevision('relative.txt')).rejects.toMatchObject({ code: 'invalid-input' });
  });

  it('distinguishes metadata access errors while retaining the existing preview error contract', async () => {
    const { file } = fixture();
    vi.spyOn(fs.promises, 'stat').mockRejectedValue(Object.assign(new Error('Sample permission denied'), { code: 'EACCES' }));
    await expect(readFileRevision(file)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(resolvePreviewPath(file)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('honors cancellation during metadata queries', async () => {
    const { file } = fixture();
    const stats = fs.statSync(file, { bigint: true });
    let resume!: (value: fs.BigIntStats) => void;
    const stat = vi.spyOn(fs.promises, 'stat').mockReturnValueOnce(new Promise((resolve) => { resume = resolve; }));
    const controller = new AbortController();
    const revision = readFileRevision(file, controller.signal);
    await vi.waitFor(() => expect(stat).toHaveBeenCalledOnce());
    controller.abort(new Error('Sample query cancelled'));
    resume(stats);
    await expect(revision).rejects.toThrow('Sample query cancelled');
  });
});

describe('FilePreviewWatcher real filesystem events', () => {
  it('detects writes, same-length writes, atomic replacements, deletion and recreation', async () => {
    const { file, directory, watcher } = fixture();
    const subscription = await observe(watcher, file);
    expect(subscription.snapshot).toBe(await readFileRevision(file));
    expect(subscription.listener).not.toHaveBeenCalled();
    fs.writeFileSync(file, 'fictional text');
    const changed = await expectRevision(subscription.listener, file, 1);
    expect(changed).not.toBe(subscription.snapshot);
    fs.writeFileSync(file, 'different text');
    const sameLength = await expectRevision(subscription.listener, file, 2);
    expect(sameLength).not.toBe(changed);
    const previousStats = fs.statSync(file);
    const replacement = path.join(directory, 'replacement.txt');
    fs.writeFileSync(replacement, 'alternate text');
    fs.utimesSync(replacement, previousStats.atime, previousStats.mtime);
    fs.renameSync(replacement, file);
    const replaced = await expectRevision(subscription.listener, file, 3);
    expect(replaced).not.toBe(sameLength);
    fs.unlinkSync(file);
    expect(await expectRevision(subscription.listener, file, 4)).toBeNull();
    fs.writeFileSync(file, 'rebuilt');
    expect(await expectRevision(subscription.listener, file, 5)).not.toBeNull();
    expect(subscription.onError).not.toHaveBeenCalled();
  });

  it('shares a directory watcher and path state, filters unrelated files, and closes after the last subscriber', async () => {
    const { file, directory, watcher } = fixture();
    const secondFile = path.join(directory, 'other.txt');
    fs.writeFileSync(secondFile, 'example');
    const watch = vi.spyOn(fs, 'watch');
    const stat = vi.spyOn(fs.promises, 'stat');
    const first = await observe(watcher, file);
    const second = await observe(watcher, file);
    const third = await observe(watcher, secondFile);
    expect(watch).toHaveBeenCalledExactlyOnceWith(directory, { recursive: false }, expect.any(Function));
    expect(stat).toHaveBeenCalledTimes(2);
    expect(second.snapshot).toBe(first.snapshot);
    const close = vi.spyOn(watch.mock.results[0]!.value as fs.FSWatcher, 'close');
    fs.writeFileSync(path.join(directory, 'unrelated.txt'), 'unrelated');
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(stat).toHaveBeenCalledTimes(2);
    expect(first.listener).not.toHaveBeenCalled();
    fs.writeFileSync(file, 'omega');
    await vi.waitFor(() => expect(first.listener).toHaveBeenCalledOnce(), { timeout: 5_000 });
    expect(second.listener).toHaveBeenCalledExactlyOnceWith(first.listener.mock.calls[0]![0]);
    expect(stat).toHaveBeenCalledTimes(3);
    expect(third.listener).not.toHaveBeenCalled();
    first.dispose();
    second.dispose();
    expect(close).not.toHaveBeenCalled();
    third.dispose();
    third.dispose();
    expect(close).toHaveBeenCalledOnce();
  });

  it('observes an initially missing file and survives its later creation', async () => {
    const { file, watcher } = fixture();
    fs.unlinkSync(file);
    const subscription = await observe(watcher, file);
    expect(subscription.snapshot).toBeNull();
    fs.writeFileSync(file, 'created');
    expect(await expectRevision(subscription.listener, file, 1)).not.toBeNull();
  });

  it('follows a linked file across target deletion, recreation and link retargeting', async () => {
    const { directory, watcher } = fixture();
    const firstDirectory = path.join(directory, 'first');
    const secondDirectory = path.join(directory, 'second');
    fs.mkdirSync(firstDirectory);
    fs.mkdirSync(secondDirectory);
    const firstFile = path.join(firstDirectory, 'target.txt');
    const secondFile = path.join(secondDirectory, 'target.txt');
    fs.writeFileSync(firstFile, 'alpha');
    fs.writeFileSync(secondFile, 'omega');
    const link = path.join(directory, 'linked.txt');
    fs.symlinkSync(firstFile, link);
    const subscription = await observe(watcher, link);
    expect(subscription.snapshot).toBe(await readFileRevision(firstFile));
    fs.unlinkSync(firstFile);
    expect(await expectRevision(subscription.listener, link, 1)).toBeNull();
    fs.writeFileSync(firstFile, 'renewed');
    await expectRevision(subscription.listener, link, 2);
    const replacement = path.join(directory, 'replacement-link');
    fs.symlinkSync(secondFile, replacement);
    fs.renameSync(replacement, link);
    expect(await expectRevision(subscription.listener, link, 3)).toBe(await readFileRevision(secondFile));
    fs.writeFileSync(firstFile, 'old target');
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(subscription.listener).toHaveBeenCalledTimes(3);
    fs.writeFileSync(secondFile, 'new target');
    await expectRevision(subscription.listener, link, 4);
    expect(subscription.onError).not.toHaveBeenCalled();
  });

  it('preserves physical symlink-dotdot semantics for resolution, revision and observation', async () => {
    const { directory, file: lexicalFile, watcher } = fixture();
    const physicalDirectory = path.join(directory, 'physical');
    const nested = path.join(physicalDirectory, 'nested');
    fs.mkdirSync(nested, { recursive: true });
    const physicalFile = path.join(physicalDirectory, 'sample.txt');
    fs.writeFileSync(physicalFile, 'physical contents');
    const link = path.join(directory, 'linked-directory');
    fs.symlinkSync(nested, link, 'junction');
    const target = `${link}${path.sep}..${path.sep}sample.txt`;
    const resolved = await resolvePreviewPath(target);
    expect(resolved.path).toBe(fs.realpathSync.native(physicalFile));
    expect(await readFileRevision(target)).toBe(await readFileRevision(physicalFile));
    expect(resolved.revision).not.toBe(await readFileRevision(lexicalFile));
    const subscription = await observe(watcher, target);
    const shared = await observe(watcher, target);
    expect(subscription.snapshot).toBe(resolved.revision);
    fs.writeFileSync(lexicalFile, 'unrelated lexical contents');
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(subscription.listener).not.toHaveBeenCalled();
    fs.writeFileSync(physicalFile, 'updated physical contents');
    await expectRevision(subscription.listener, target, 1);
    expect(shared.listener).toHaveBeenCalledExactlyOnceWith(subscription.listener.mock.calls[0]![0]);
    expect(subscription.onError).not.toHaveBeenCalled();
  });

  it('follows relative link targets without collapsing dotdot after another directory link', async () => {
    const { directory, file: lexicalFile, watcher } = fixture();
    const nested = path.join(directory, 'physical', 'nested');
    fs.mkdirSync(nested, { recursive: true });
    const physicalFile = path.join(directory, 'physical', 'sample.txt');
    fs.writeFileSync(physicalFile, 'physical contents');
    fs.symlinkSync(nested, path.join(directory, 'linked-directory'), 'junction');
    const link = path.join(directory, 'linked.txt');
    fs.symlinkSync(`linked-directory${path.sep}..${path.sep}sample.txt`, link);
    const subscription = await observe(watcher, link);
    expect(subscription.snapshot).toBe(await readFileRevision(physicalFile));
    expect(subscription.snapshot).not.toBe(await readFileRevision(lexicalFile));
    fs.writeFileSync(physicalFile, 'updated physical contents');
    await expectRevision(subscription.listener, link, 1);
    expect(subscription.onError).not.toHaveBeenCalled();
  });

  it('rebinds shared watches after replacing an ordinary parent and isolates the retired directory', async () => {
    const { directory, watcher } = fixture();
    const active = path.join(directory, 'active');
    const replacement = path.join(directory, 'replacement');
    const retired = path.join(directory, 'retired');
    fs.mkdirSync(active);
    fs.mkdirSync(replacement);
    const file = path.join(active, 'sample.txt');
    const other = path.join(active, 'other.txt');
    fs.writeFileSync(file, 'initial contents');
    fs.writeFileSync(other, 'other initial contents');
    fs.writeFileSync(path.join(replacement, 'sample.txt'), 'replacement contents');
    fs.writeFileSync(path.join(replacement, 'other.txt'), 'other replacement contents');
    const watch = vi.spyOn(fs, 'watch');
    const subscription = await observe(watcher, file);
    const second = await observe(watcher, other);
    const oldHandle = watch.mock.results[0]!.value as fs.FSWatcher;
    const close = vi.spyOn(oldHandle, 'close');
    fs.renameSync(active, retired);
    fs.renameSync(replacement, active);
    await expectRevision(subscription.listener, file, 1);
    await expectRevision(second.listener, other, 1);
    expect(close).toHaveBeenCalledOnce();
    expect(watch).toHaveBeenCalledTimes(2);
    const newClose = vi.spyOn(watch.mock.results[1]!.value as fs.FSWatcher, 'close');
    const shared = await observe(watcher, file);
    expect(shared.snapshot).toBe(await readFileRevision(file));
    const lstat = vi.spyOn(fs.promises, 'lstat');
    oldHandle.emit('error', Object.assign(new Error('Sample retired resource error'), { code: 'EMFILE' }));
    fs.writeFileSync(path.join(retired, 'sample.txt'), 'retired contents');
    fs.writeFileSync(path.join(retired, 'other.txt'), 'other retired contents');
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(lstat).not.toHaveBeenCalled();
    expect(subscription.listener).toHaveBeenCalledTimes(1);
    fs.writeFileSync(file, 'updated replacement contents');
    await expectRevision(subscription.listener, file, 2);
    expect(shared.listener).toHaveBeenCalledExactlyOnceWith(subscription.listener.mock.calls[1]![0]);
    fs.writeFileSync(file, 'second replacement update');
    await expectRevision(subscription.listener, file, 3);
    fs.writeFileSync(other, 'other replacement update');
    await expectRevision(second.listener, other, 2);
    expect(subscription.onError).not.toHaveBeenCalled();
    expect(second.onError).not.toHaveBeenCalled();
    subscription.dispose();
    second.dispose();
    expect(newClose).not.toHaveBeenCalled();
    shared.dispose();
    expect(newClose).toHaveBeenCalledOnce();
  });

  it('observes missing parent components through ancestor events and progressively follows their creation', async () => {
    const { directory, watcher } = fixture();
    const first = path.join(directory, 'absent');
    const parent = path.join(first, 'nested');
    const file = path.join(parent, 'sample.txt');
    const watch = vi.spyOn(fs, 'watch');
    const open = vi.spyOn(fs.promises, 'open');
    const read = vi.spyOn(fs.promises, 'readFile');
    const list = vi.spyOn(fs.promises, 'readdir');
    const subscription = await observe(watcher, file);
    expect(subscription.snapshot).toBeNull();
    expect(watch).toHaveBeenCalledExactlyOnceWith(directory, { recursive: false }, expect.any(Function));
    fs.mkdirSync(first);
    await vi.waitFor(() => expect(watch).toHaveBeenCalledWith(first, { recursive: false }, expect.any(Function)));
    expect(subscription.listener).not.toHaveBeenCalled();
    fs.mkdirSync(parent);
    fs.writeFileSync(file, 'created contents');
    await expectRevision(subscription.listener, file, 1);
    fs.writeFileSync(file, 'updated contents');
    await expectRevision(subscription.listener, file, 2);
    expect(open).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(subscription.onError).not.toHaveBeenCalled();
  });

  it('delivers null after deleting a parent directory and recovers after its recreation', async () => {
    const { directory, watcher } = fixture();
    const parent = path.join(directory, 'active');
    const file = path.join(parent, 'sample.txt');
    fs.mkdirSync(parent);
    fs.writeFileSync(file, 'initial contents');
    const subscription = await observe(watcher, file);
    const shared = await observe(watcher, file);
    fs.rmSync(parent, { recursive: true });
    expect(await expectRevision(subscription.listener, file, 1)).toBeNull();
    expect(shared.listener).toHaveBeenCalledExactlyOnceWith(null);
    fs.mkdirSync(parent);
    fs.writeFileSync(file, 'recreated contents');
    await expectRevision(subscription.listener, file, 2);
    fs.writeFileSync(file, 'updated recreated contents');
    await expectRevision(subscription.listener, file, 3);
    expect(shared.listener.mock.calls).toEqual(subscription.listener.mock.calls);
    expect(subscription.onError).not.toHaveBeenCalled();
  });

  it('keeps link and ancestor watches when a symlink is atomically retargeted to a missing parent', async () => {
    const { directory, file: initial, watcher } = fixture();
    const parent = path.join(directory, 'absent', 'nested');
    const target = path.join(parent, 'sample.txt');
    const link = path.join(directory, 'linked.txt');
    const replacement = path.join(directory, 'replacement-link');
    fs.symlinkSync(initial, link);
    const subscription = await observe(watcher, link);
    fs.symlinkSync(target, replacement);
    fs.renameSync(replacement, link);
    expect(await expectRevision(subscription.listener, link, 1)).toBeNull();
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(target, 'created target contents');
    expect(await expectRevision(subscription.listener, link, 2)).toBe(await readFileRevision(target));
    fs.writeFileSync(target, 'updated target contents');
    await expectRevision(subscription.listener, link, 3);
    fs.symlinkSync(initial, replacement);
    fs.renameSync(replacement, link);
    expect(await expectRevision(subscription.listener, link, 4)).toBe(await readFileRevision(initial));
    expect(subscription.onError).not.toHaveBeenCalled();
  });

  it('rebinds a file when a symlink in its parent path is replaced', async () => {
    const { directory, watcher } = fixture();
    for (const name of ['first', 'second']) {
      fs.mkdirSync(path.join(directory, name));
      fs.writeFileSync(path.join(directory, name, 'sample.txt'), name);
    }
    const link = path.join(directory, 'linked-directory');
    fs.symlinkSync(path.join(directory, 'first'), link, 'junction');
    const file = path.join(link, 'sample.txt');
    const subscription = await observe(watcher, file);
    const replacement = path.join(directory, 'replacement-directory');
    fs.symlinkSync(path.join(directory, 'second'), replacement, 'junction');
    fs.renameSync(replacement, link);
    const revision = await expectRevision(subscription.listener, file, 1);
    expect(revision).toBe(await readFileRevision(path.join(directory, 'second', 'sample.txt')));
    expect(revision).not.toBe(subscription.snapshot);
  });
});

describe('FilePreviewWatcher lifecycle and errors', () => {
  it('debounces relevant events, ignores unchanged metadata, and never reads contents', async () => {
    const { file, watcher } = fixture();
    const events = fakeWatch();
    const subscription = await observe(watcher, file);
    vi.useFakeTimers();
    const stat = vi.spyOn(fs.promises, 'stat').mockResolvedValue(fs.statSync(file, { bigint: true }));
    const open = vi.spyOn(fs.promises, 'open');
    const read = vi.spyOn(fs.promises, 'readFile');
    expect(vi.getTimerCount()).toBe(0);
    events.change('unrelated.txt');
    expect(vi.getTimerCount()).toBe(0);
    events.change();
    events.change();
    events.change(null);
    await vi.advanceTimersByTimeAsync(299);
    expect(stat).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    // Metadata setup uses real filesystem promises even when the debounce timer is mocked.
    vi.useRealTimers();
    await vi.waitFor(() => expect(stat).toHaveBeenCalledOnce(), { timeout: 2_000 });
    expect(subscription.listener).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('establishes the directory watch before capturing the initial revision', async () => {
    const { file, watcher } = fixture();
    const events = fakeWatch();
    const initial = await readFileRevision(file);
    events.watch.mockImplementationOnce(() => {
      fs.writeFileSync(file, 'changed during opening');
      return events.handle as unknown as fs.FSWatcher;
    });
    const subscription = await observe(watcher, file);
    expect(subscription.snapshot).toBe(await readFileRevision(file));
    expect(subscription.snapshot).not.toBe(initial);
  });

  it('delivers events received during an in-flight initial stat without polling it', async () => {
    const { file, watcher } = fixture();
    const events = fakeWatch();
    const stats = fs.statSync(file, { bigint: true });
    let resume!: (value: fs.BigIntStats) => void;
    const stat = vi.spyOn(fs.promises, 'stat').mockReturnValueOnce(new Promise((resolve) => { resume = resolve; }));
    const listener = vi.fn();
    const opening = watcher.observe(file, listener);
    await vi.waitFor(() => expect(stat).toHaveBeenCalledOnce());
    vi.useFakeTimers();
    fs.writeFileSync(file, 'changed during stat');
    events.change();
    await vi.advanceTimersByTimeAsync(900);
    expect(stat).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    resume(stats);
    const subscription = await opening;
    disposers.push(subscription.dispose);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(300);
    vi.useRealTimers();
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
    expect(listener).toHaveBeenCalledWith(await readFileRevision(file));
    expect(listener.mock.calls[0]![0]).not.toBe(subscription.snapshot);
  });

  it('rejects and releases an asynchronous watcher error during the initial stat', async () => {
    const { file, watcher } = fixture();
    const events = fakeWatch();
    let resume!: (value: fs.BigIntStats) => void;
    const stat = vi.spyOn(fs.promises, 'stat').mockReturnValueOnce(new Promise((resolve) => { resume = resolve; }));
    const listener = vi.fn();
    const opening = watcher.observe(file, listener);
    await vi.waitFor(() => expect(stat).toHaveBeenCalledOnce());
    events.handle.emit('error', Object.assign(new Error('Sample initial resource error'), { code: 'EMFILE' }));
    expect(events.handle.close).toHaveBeenCalledOnce();
    resume(fs.statSync(file, { bigint: true }));
    await expect(opening).rejects.toMatchObject({ code: 'unavailable' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('clears a queued timer when the last subscription is disposed', async () => {
    const { file, watcher } = fixture();
    const events = fakeWatch();
    const subscription = await observe(watcher, file);
    vi.useFakeTimers();
    events.change();
    expect(vi.getTimerCount()).toBe(1);
    subscription.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(events.handle.close).toHaveBeenCalledOnce();
    expect(subscription.listener).not.toHaveBeenCalled();
  });

  it('does not allocate a watcher if opening is cancelled during path resolution', async () => {
    const { file, watcher } = fixture();
    const events = fakeWatch();
    let resume!: (value: string) => void;
    vi.spyOn(fs.promises, 'realpath').mockReturnValueOnce(new Promise((resolve) => { resume = resolve; }));
    const controller = new AbortController();
    const opening = watcher.observe(file, vi.fn(), controller.signal);
    controller.abort(new Error('Sample opening cancelled'));
    resume(file);
    await expect(opening).rejects.toThrow('Sample opening cancelled');
    expect(events.watch).not.toHaveBeenCalled();
    const subscription = await observe(watcher, file);
    expect(subscription.snapshot).not.toBeNull();
    expect(events.watch).toHaveBeenCalledOnce();
  });

  it('closes immediately when cancelled during the first stat after establishing the watch', async () => {
    const { file, watcher } = fixture();
    const events = fakeWatch();
    const stats = fs.statSync(file, { bigint: true });
    let resume!: (value: fs.BigIntStats) => void;
    const stat = vi.spyOn(fs.promises, 'stat').mockReturnValueOnce(new Promise((resolve) => { resume = resolve; }));
    const controller = new AbortController();
    const listener = vi.fn();
    const opening = watcher.observe(file, listener, controller.signal);
    await vi.waitFor(() => expect(stat).toHaveBeenCalledOnce());
    expect(events.watch).toHaveBeenCalledOnce();
    controller.abort(new Error('Sample stat cancelled'));
    expect(events.handle.close).toHaveBeenCalledOnce();
    resume(stats);
    await expect(opening).rejects.toThrow('Sample stat cancelled');
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps a shared opening alive when only one waiting subscriber cancels', async () => {
    const { file, watcher } = fixture();
    const events = fakeWatch();
    let resume!: (value: fs.BigIntStats) => void;
    const stat = vi.spyOn(fs.promises, 'stat').mockReturnValueOnce(new Promise((resolve) => { resume = resolve; }));
    const controller = new AbortController();
    const first = watcher.observe(file, vi.fn(), controller.signal);
    const second = watcher.observe(file, vi.fn());
    await vi.waitFor(() => expect(stat).toHaveBeenCalledOnce());
    controller.abort(new Error('Sample subscriber cancelled'));
    expect(events.handle.close).not.toHaveBeenCalled();
    resume(fs.statSync(file, { bigint: true }));
    await expect(first).rejects.toThrow('Sample subscriber cancelled');
    const opened = await second;
    disposers.push(opened.dispose);
    expect(opened.snapshot).not.toBeNull();
    expect(events.watch).toHaveBeenCalledOnce();
  });

  it('suppresses an in-flight change stat after disposal', async () => {
    const { file, watcher } = fixture();
    const events = fakeWatch();
    const subscription = await observe(watcher, file);
    let resume!: (value: fs.BigIntStats) => void;
    const stat = vi.spyOn(fs.promises, 'stat').mockReturnValueOnce(new Promise((resolve) => { resume = resolve; }));
    fs.writeFileSync(file, 'updated');
    events.change();
    await vi.waitFor(() => expect(stat).toHaveBeenCalledOnce());
    subscription.dispose();
    expect(events.handle.close).toHaveBeenCalledOnce();
    resume(fs.statSync(file, { bigint: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(subscription.listener).not.toHaveBeenCalled();
    expect(subscription.onError).not.toHaveBeenCalled();
  });

  it.each(['EACCES', 'ENOSPC'])('rejects a real watch allocation failure: %s', async (code) => {
    const { file, watcher } = fixture();
    vi.spyOn(fs, 'watch').mockImplementation(() => { throw Object.assign(new Error('Sample watch failed'), { code }); });
    await expect(watcher.observe(file, vi.fn())).rejects.toMatchObject({ code: code === 'EACCES' ? 'forbidden' : 'unavailable' });
  });

  it('releases all shared subscriptions and reports an asynchronous watcher resource error', async () => {
    const { file, directory, watcher } = fixture();
    const events = fakeWatch();
    const first = await observe(watcher, file);
    const second = await observe(watcher, file);
    const otherFile = path.join(directory, 'other.txt');
    fs.writeFileSync(otherFile, 'example');
    const third = await observe(watcher, otherFile);
    events.handle.emit('error', Object.assign(new Error('Sample resource error'), { code: 'EMFILE' }));
    for (const subscription of [first, second, third]) {
      expect(subscription.onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'unavailable' }));
      expect(subscription.listener).not.toHaveBeenCalled();
    }
    expect(events.handle.close).toHaveBeenCalledOnce();
  });

  it('recovers if a parent disappears between metadata resolution and watch allocation', async () => {
    const { directory, watcher } = fixture();
    const parent = path.join(directory, 'active');
    const file = path.join(parent, 'sample.txt');
    fs.mkdirSync(parent);
    fs.writeFileSync(file, 'initial contents');
    const watch = fs.watch.bind(fs);
    const allocation = vi.spyOn(fs, 'watch').mockImplementationOnce(() => {
      fs.rmSync(parent, { recursive: true });
      throw Object.assign(new Error('Sample directory disappeared'), { code: 'ENOENT' });
    });
    allocation.mockImplementation(watch);
    const subscription = await observe(watcher, file);
    expect(subscription.snapshot).toBeNull();
    expect(allocation).toHaveBeenCalledWith(directory, { recursive: false }, expect.any(Function));
    fs.mkdirSync(parent);
    fs.writeFileSync(file, 'recreated contents');
    await expectRevision(subscription.listener, file, 1);
    fs.writeFileSync(file, 'updated recreated contents');
    await expectRevision(subscription.listener, file, 2);
    expect(subscription.onError).not.toHaveBeenCalled();
  });

  it.each(['EACCES', 'ENOSPC'])('reports a replacement-directory watch allocation failure to all shared targets: %s', async (code) => {
    const { directory, watcher } = fixture();
    const parent = path.join(directory, 'active');
    const replacement = path.join(directory, 'replacement');
    fs.mkdirSync(parent);
    fs.mkdirSync(replacement);
    const file = path.join(parent, 'sample.txt');
    const other = path.join(parent, 'other.txt');
    fs.writeFileSync(file, 'initial contents');
    fs.writeFileSync(other, 'other initial contents');
    const events = fakeWatch();
    const first = await observe(watcher, file);
    const second = await observe(watcher, other);
    fs.renameSync(parent, path.join(directory, 'retired'));
    fs.renameSync(replacement, parent);
    events.watch.mockImplementationOnce(() => {
      throw Object.assign(new Error('Sample replacement watch failed'), { code });
    });
    events.change('active');
    await vi.waitFor(() => expect(first.onError).toHaveBeenCalledOnce());
    for (const subscription of [first, second]) {
      expect(subscription.onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: code === 'EACCES' ? 'forbidden' : 'unavailable' }));
      expect(subscription.listener).not.toHaveBeenCalled();
    }
    expect(events.handle.close).toHaveBeenCalledOnce();
  });

  it('reports a newly unreadable parent instead of silently stopping detection', async () => {
    const { file, watcher } = fixture();
    const events = fakeWatch();
    const subscription = await observe(watcher, file);
    vi.spyOn(fs.promises, 'realpath').mockRejectedValueOnce(Object.assign(new Error('Sample parent inaccessible'), { code: 'EACCES' }));
    events.change();
    await vi.waitFor(() => expect(subscription.onError).toHaveBeenCalledOnce());
    expect(subscription.onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'forbidden' }));
    expect(events.handle.close).toHaveBeenCalledOnce();
    expect(subscription.listener).not.toHaveBeenCalled();
  });
});
