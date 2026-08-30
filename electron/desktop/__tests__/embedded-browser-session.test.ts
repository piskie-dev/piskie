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
    readonly navigationHistory = {
      canGoBack: vi.fn(() => false),
      canGoForward: vi.fn(() => false),
      goBack: vi.fn(),
      goForward: vi.fn(),
    };
    readonly loadFile = vi.fn(async () => undefined);
    readonly loadURL = vi.fn(async () => undefined);
    readonly reload = vi.fn();
    readonly stop = vi.fn();
    readonly close = vi.fn();
    readonly getURL = vi.fn(() => '');
    readonly getTitle = vi.fn(() => '');
    readonly isLoading = vi.fn(() => false);
    readonly isDestroyed = vi.fn(() => false);
    windowOpenHandler?: (details: { url: string }) => { action: 'deny' };

    setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void {
      this.windowOpenHandler = handler;
    }
  }

  class FakeWebContentsView {
    static latest?: FakeWebContentsView;
    readonly webContents = new FakeWebContents();
    readonly setBounds = vi.fn();

    constructor(readonly options: unknown) {
      FakeWebContentsView.latest = this;
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
    },
  };
});

vi.mock('electron', () => ({
  BrowserWindow: electron.FakeBrowserWindow,
  WebContentsView: electron.FakeWebContentsView,
  session: { fromPartition: vi.fn(() => electron.browserSession) },
}));

import { EmbeddedBrowserSession } from '../embedded-browser-session.js';

beforeEach(() => {
  electron.reset();
  vi.clearAllMocks();
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
