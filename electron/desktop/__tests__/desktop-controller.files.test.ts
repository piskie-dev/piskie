import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_OPERATIONS, DESKTOP_TOPICS } from '../../../shared/electron-contracts/desktop.js';
import type { HostFrame } from '../../../shared/electron-contracts/protocol.js';
import { createControllerCatalog } from '../../capabilities/catalog.js';
import { PortRouter } from '../../transport/electron/port-router.js';
import { WindowConnection } from '../../transport/electron/window-connection.js';
import { createDesktopController } from '../capabilities/desktop-controller.js';
import { FilePreviewWatcher, readFileRevision } from '../capabilities/file-preview-watcher.js';

const directories: string[] = [];
const connections: WindowConnection[] = [];

afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close('sample-cleanup')));
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const context = { generation: 'sample-generation', connectionId: 'sample-connection', windowId: 7, signal: new AbortController().signal };

class TestPort extends EventEmitter {
  readonly sent: HostFrame[] = [];
  postMessage(message: unknown): void { this.sent.push(message as HostFrame); }
  start(): void {}
  close(): void {}
  receive(data: unknown): void { this.emit('message', { data }); }
}

function connectionFixture() {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'preview-topic-')));
  directories.push(directory);
  const file = path.join(directory, 'sample.txt');
  fs.writeFileSync(file, 'alpha');
  const watcher = new FilePreviewWatcher();
  const controller = createDesktopController({
    fileRevision: readFileRevision,
    observeFile: watcher.observe.bind(watcher),
  } as never);
  const port = new TestPort();
  const router = new PortRouter(createControllerCatalog(controller), { phase: () => 'ready' });
  const connection = new WindowConnection(port, router, {
    generation: 'sample-generation', windowId: 7,
    welcome: {
      protocolVersion: 1, generation: 'sample-generation', capabilities: ['desktop'],
      runtime: { phase: 'ready', startedAt: 1, degraded: [] },
    },
  });
  connection.start();
  connections.push(connection);
  return { file, port, connection };
}

describe('desktop file controller', () => {
  it('validates paths and passes the request window and cancellation signal to preview', async () => {
    const previewFile = vi.fn(async () => ({ kind: 'text', content: 'Sample', size: 6, truncated: false, revision: 'sample-token' }));
    const fileRevision = vi.fn(async () => 'sample-token');
    const controller = createDesktopController({ previewFile, fileRevision } as never);
    const preview = controller.operations.find(({ id }) => id === DESKTOP_OPERATIONS.previewFile)!;
    const revision = controller.operations.find(({ id }) => id === DESKTOP_OPERATIONS.fileRevision)!;
    for (const operation of [preview, revision]) {
      expect(operation.input.safeParse(['']).success).toBe(false);
      expect(operation.input.safeParse([42]).success).toBe(false);
      expect(operation.input.safeParse(['/sample/file.txt', 'extra']).success).toBe(false);
    }
    const target = '/sample/file.txt';
    await preview.execute(context, preview.input.parse([target]));
    expect(previewFile).toHaveBeenCalledExactlyOnceWith(7, target, context.signal);
    await expect(revision.execute(context, revision.input.parse([target]))).resolves.toBe('sample-token');
    expect(fileRevision).toHaveBeenCalledExactlyOnceWith(target, context.signal);
  });

  it('accepts only a strict path object and forwards emission, cancellation and errors', async () => {
    const opened = { snapshot: 'sample-token', dispose: vi.fn() };
    const observeFile = vi.fn(async () => opened);
    const controller = createDesktopController({ observeFile } as never);
    const topic = controller.topics.find(({ id }) => id === DESKTOP_TOPICS.fileChanges)!;
    for (const input of [undefined, '/sample/file.txt', {}, { path: '' }, { path: 42 }, { path: '/sample/file.txt', extra: true }]) {
      expect(topic.input.safeParse(input).success).toBe(false);
    }
    const emit = vi.fn();
    const onError = vi.fn();
    const router = new PortRouter(createControllerCatalog(controller), { phase: () => 'ready' });
    await expect(router.subscribe(context, topic.id, { path: '/sample/file.txt', extra: true }, emit, onError))
      .rejects.toMatchObject({ code: 'invalid-input' });
    expect(observeFile).not.toHaveBeenCalled();
    await expect(router.subscribe(context, topic.id, { path: '/sample/file.txt' }, emit, onError)).resolves.toBe(opened);
    expect(observeFile).toHaveBeenCalledExactlyOnceWith('/sample/file.txt', emit, context.signal, onError);
  });

  it('propagates initial subscription failures', async () => {
    const error = new Error('Sample watch unavailable');
    const controller = createDesktopController({ observeFile: vi.fn(async () => { throw error; }) } as never);
    const topic = controller.topics.find(({ id }) => id === DESKTOP_TOPICS.fileChanges)!;
    await expect(topic.open(context, { path: '/sample/file.txt' }, vi.fn())).rejects.toBe(error);
  });

  it('releases a real watcher on unsubscribe and on connection close', async () => {
    const { file, port, connection } = connectionFixture();
    const watch = vi.spyOn(fs, 'watch');
    for (const id of ['first', 'second']) {
      port.receive({ kind: 'subscribe', id, topic: DESKTOP_TOPICS.fileChanges, payload: { path: file } });
    }
    await vi.waitFor(() => expect(connection.snapshot().subscriptions).toBe(2));
    expect(watch).toHaveBeenCalledOnce();
    const close = vi.spyOn(watch.mock.results[0]!.value as fs.FSWatcher, 'close');
    const opened = port.sent.filter((frame) => frame.kind === 'subscribed');
    expect(opened[0]!.snapshot).toBe(await readFileRevision(file));
    port.receive({ kind: 'unsubscribe', subscriptionId: opened[0]!.subscriptionId });
    await vi.waitFor(() => expect(connection.snapshot().subscriptions).toBe(1));
    expect(close).not.toHaveBeenCalled();
    await connection.close('sample-window-closed');
    expect(close).toHaveBeenCalledOnce();
    expect(connection.snapshot().subscriptions).toBe(0);
  });

  it('closes the watcher during an in-flight subscription stat when its connection closes', async () => {
    const { file, port, connection } = connectionFixture();
    const stats = fs.statSync(file, { bigint: true });
    let resume!: (value: fs.BigIntStats) => void;
    const stat = vi.spyOn(fs.promises, 'stat').mockReturnValueOnce(new Promise((resolve) => { resume = resolve; }));
    const watch = vi.spyOn(fs, 'watch');
    port.receive({ kind: 'subscribe', id: 'opening', topic: DESKTOP_TOPICS.fileChanges, payload: { path: file } });
    await vi.waitFor(() => expect(stat).toHaveBeenCalledOnce());
    const close = vi.spyOn(watch.mock.results[0]!.value as fs.FSWatcher, 'close');
    await connection.close('sample-window-closed');
    expect(close).toHaveBeenCalledOnce();
    resume(stats);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(port.sent.filter((frame) => frame.kind === 'subscribed')).toHaveLength(0);
    expect(connection.snapshot().subscriptions).toBe(0);
  });

  it('reports a watcher error as a subscription fault and removes the active subscription', async () => {
    const { file, port, connection } = connectionFixture();
    const watch = vi.spyOn(fs, 'watch');
    port.receive({ kind: 'subscribe', id: 'opening', topic: DESKTOP_TOPICS.fileChanges, payload: { path: file } });
    await vi.waitFor(() => expect(connection.snapshot().subscriptions).toBe(1));
    const opened = port.sent.find((frame) => frame.kind === 'subscribed')!;
    const handle = watch.mock.results[0]!.value as fs.FSWatcher;
    const close = vi.spyOn(handle, 'close');
    handle.emit('error', Object.assign(new Error('Sample watch exhausted'), { code: 'ENOSPC' }));
    await vi.waitFor(() => expect(connection.snapshot().subscriptions).toBe(0));
    expect(port.sent).toContainEqual(expect.objectContaining({ kind: 'fault', id: opened.subscriptionId, fault: expect.objectContaining({ code: 'unavailable' }) }));
    expect(close).toHaveBeenCalledOnce();
  });
});
