import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => {
  class MiniEmitter {
    private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

    on(event: string, listener: (...args: unknown[]) => void): this {
      const listeners = this.listeners.get(event) ?? new Set();
      listeners.add(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    removeListener(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.get(event)?.delete(listener);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
    }
  }

  class FakeWebContents extends MiniEmitter {
    private url = '';
    private destroyed = false;
    readonly navigationHistory = {
      canGoBack: vi.fn(() => false),
      canGoForward: vi.fn(() => false),
      goBack: vi.fn(),
      goForward: vi.fn(),
    };
    readonly loadFile = vi.fn(async () => undefined);
    readonly loadURL = vi.fn(async (url: string) => { this.url = url; });
    readonly reload = vi.fn();
    readonly stop = vi.fn();
    readonly close = vi.fn(() => { this.destroyed = true; });
    readonly getURL = vi.fn(() => this.url);
    readonly getTitle = vi.fn(() => '');
    readonly isLoading = vi.fn(() => false);
    readonly isDestroyed = vi.fn(() => this.destroyed);
    windowOpenHandler?: (details: { url: string }) => { action: 'deny' };

    setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void {
      this.windowOpenHandler = handler;
    }
  }

  class FakeWebContentsView {
    static latest?: FakeWebContentsView;
    static instances: FakeWebContentsView[] = [];
    readonly webContents = new FakeWebContents();
    readonly setBounds = vi.fn();

    constructor(readonly options: unknown) {
      FakeWebContentsView.latest = this;
      FakeWebContentsView.instances.push(this);
    }
  }

  class FakeBrowserWindow {
    readonly webContents = new MiniEmitter();
    readonly contentView = {
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
    };
    readonly isDestroyed = vi.fn(() => false);
  }

  const browserSession = {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  };

  return {
    browserSession,
    FakeBrowserWindow,
    FakeWebContentsView,
    reset() {
      FakeWebContentsView.latest = undefined;
      FakeWebContentsView.instances = [];
    },
  };
});

vi.mock('electron', () => ({
  BrowserWindow: electron.FakeBrowserWindow,
  WebContentsView: electron.FakeWebContentsView,
  session: { fromPartition: vi.fn(() => electron.browserSession) },
}));

import { EmbeddedBrowserSession } from '../embedded-browser-session.js';
import { EmbeddedBrowserRegistry } from '../embedded-browser-registry.js';

beforeEach(() => {
  electron.reset();
  vi.clearAllMocks();
});

describe('scoped embedded browser lifetimes', () => {
  const main = { agentId: 'session-alpha' };
  const worker = { agentId: 'session-alpha', workerId: 'worker-one' };
  const other = { agentId: 'session-beta' };

  function fixture() {
    const window = new electron.FakeBrowserWindow();
    return { window, registry: new EmbeddedBrowserRegistry(window as never) };
  }

  it('creates independent main, worker and conversation pages on demand', async () => {
    const { registry } = fixture();
    expect(registry.state(main).open).toBe(false);
    registry.setVisible(main, false);
    expect(electron.FakeWebContentsView.instances).toHaveLength(0);

    await registry.open(main).navigate('https://example.test/alpha');
    await registry.open(worker).navigate('https://example.test/worker');
    await registry.open(other).navigate('https://example.test/beta');
    expect(new Set([registry.get(main), registry.get(worker), registry.get(other)]).size).toBe(3);
    expect(registry.state(main).url).toBe('https://example.test/alpha');
    expect(registry.state(worker).url).toBe('https://example.test/worker');
    expect(registry.state(other).url).toBe('https://example.test/beta');
    const sessions = electron.FakeWebContentsView.instances.map((view) => (
      (view.options as { webPreferences: { session: unknown } }).webPreferences.session
    ));
    expect(new Set(sessions).size).toBe(1);
    registry.dispose();
  });

  it('switches and hides views without reloading and ignores another target cleanup', async () => {
    const { registry, window } = fixture();
    await registry.open(main).navigate('https://example.test/alpha');
    const first = electron.FakeWebContentsView.latest!;
    registry.setVisible(main, true);
    await registry.open(other).navigate('https://example.test/beta');
    const second = electron.FakeWebContentsView.latest!;
    registry.setVisible(other, true);
    expect(window.contentView.removeChildView).toHaveBeenLastCalledWith(first);
    expect(window.contentView.addChildView).toHaveBeenLastCalledWith(second);

    window.contentView.removeChildView.mockClear();
    registry.setVisible(main, false);
    expect(window.contentView.removeChildView).not.toHaveBeenCalled();
    registry.setVisible(other, false);
    registry.setVisible(main, true);
    expect(window.contentView.addChildView).toHaveBeenLastCalledWith(first);
    expect(first.webContents.loadURL).toHaveBeenCalledOnce();
    expect(first.webContents.close).not.toHaveBeenCalled();
    registry.dispose();
  });

  it('reuses a matching URL and leaves explicit refresh available', async () => {
    const { registry } = fixture();
    const page = registry.open(main);
    await page.navigate('https://example.test');
    await page.navigate('https://example.test/');
    const contents = electron.FakeWebContentsView.latest!.webContents;
    expect(contents.loadURL).toHaveBeenCalledOnce();
    page.reload();
    expect(contents.reload).toHaveBeenCalledOnce();
    registry.dispose();
  });

  it('destroys only the closed page and creates a fresh lifetime on reopening', async () => {
    const { registry } = fixture();
    const page = registry.open(main);
    await page.navigate('https://example.test/alpha');
    const first = electron.FakeWebContentsView.latest!;
    const sibling = registry.open(worker);
    registry.close(main);
    expect(first.webContents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
    expect(registry.state(main).open).toBe(false);
    expect(registry.get(worker)).toBe(sibling);

    registry.setVisible(main, true);
    await page.openLocalHtml('/tmp/example.html');
    expect(first.webContents.loadFile).not.toHaveBeenCalled();
    expect(registry.state(main).open).toBe(false);
    expect(registry.open(main)).not.toBe(page);
    expect(registry.state(main)).toMatchObject({ open: true, url: '' });
    registry.dispose();
  });

  it('releases removed workers and their parent conversation without affecting others', () => {
    const { registry } = fixture();
    registry.open(main);
    registry.open(worker);
    registry.open(other);
    registry.retainWorkers(main.agentId, new Set());
    expect(registry.get(worker)).toBeUndefined();
    expect(registry.state(main).open).toBe(true);
    registry.releaseAgent(main.agentId);
    expect(registry.get(main)).toBeUndefined();
    expect(registry.state(other).open).toBe(true);
    registry.dispose();
    expect(electron.FakeWebContentsView.instances.every((view) => view.webContents.isDestroyed())).toBe(true);
  });

  it('publishes the target on page changes and close events', async () => {
    const { registry } = fixture();
    const listener = vi.fn();
    registry.changes.subscribe(listener);
    await registry.open(worker).navigate('https://example.test/worker');
    electron.FakeWebContentsView.latest!.webContents.emit('did-navigate');
    expect(listener).toHaveBeenLastCalledWith({
      target: worker,
      state: expect.objectContaining({ open: true, url: 'https://example.test/worker' }),
    });
    registry.close(worker);
    expect(listener).toHaveBeenLastCalledWith({
      target: worker,
      state: expect.objectContaining({ open: false, url: '' }),
    });
    registry.dispose();
  });

  it('tolerates cancellation of a navigation by closing its page', async () => {
    const { registry } = fixture();
    const page = registry.open(main);
    let rejectLoad!: (error: Error) => void;
    electron.FakeWebContentsView.latest!.webContents.loadURL.mockImplementationOnce(() => (
      new Promise<void>((_resolve, reject) => { rejectLoad = reject; })
    ));
    const pending = page.navigate('https://example.test/slow');
    registry.close(main);
    rejectLoad(new Error('Page closed'));
    await expect(pending).resolves.toBe(true);
    expect(registry.state(main).open).toBe(false);
    registry.dispose();
  });
});

describe('EmbeddedBrowserSession local HTML navigation', () => {
  it('loads a local HTML file through the sandboxed embedded view', async () => {
    const browser = new EmbeddedBrowserSession(new electron.FakeBrowserWindow() as never);

    await browser.openLocalHtml('/tmp/example.html');

    expect(electron.FakeWebContentsView.latest?.webContents.loadFile)
      .toHaveBeenCalledWith('/tmp/example.html');
  });

  it('keeps file URLs out of general address navigation', async () => {
    const browser = new EmbeddedBrowserSession(new electron.FakeBrowserWindow() as never);

    await expect(browser.navigate('file:///tmp/example.html')).resolves.toBe(false);
    expect(electron.FakeWebContentsView.latest).toBeUndefined();
  });

  it('allows local HTML links while blocking other file navigations', async () => {
    const browser = new EmbeddedBrowserSession(new electron.FakeBrowserWindow() as never);
    await browser.openLocalHtml('/tmp/example.html');
    const contents = electron.FakeWebContentsView.latest!.webContents;

    expect(contents.windowOpenHandler?.({ url: 'file:///tmp/next.HTM' })).toEqual({ action: 'deny' });
    expect(contents.loadURL).toHaveBeenCalledWith('file:///tmp/next.HTM');

    contents.loadURL.mockClear();
    expect(contents.windowOpenHandler?.({ url: 'file:///tmp/notes.txt' })).toEqual({ action: 'deny' });
    expect(contents.loadURL).not.toHaveBeenCalled();

    const allowedEvent = { preventDefault: vi.fn() };
    contents.emit('will-navigate', allowedEvent, 'file:///tmp/next.html');
    expect(allowedEvent.preventDefault).not.toHaveBeenCalled();

    const blockedEvent = { preventDefault: vi.fn() };
    contents.emit('will-navigate', blockedEvent, 'file:///tmp/notes.txt');
    expect(blockedEvent.preventDefault).toHaveBeenCalledOnce();
  });
});
