import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => {
  class MiniEmitter {
    private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();

    on(event: string, listener: (...args: any[]) => void): this {
      const listeners = this.listeners.get(event) ?? new Set();
      listeners.add(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    once(event: string, listener: (...args: any[]) => void): this {
      const wrapped = (...args: any[]): void => {
        this.removeListener(event, wrapped);
        listener(...args);
      };
      return this.on(event, wrapped);
    }

    removeListener(event: string, listener: (...args: any[]) => void): this {
      this.listeners.get(event)?.delete(listener);
      return this;
    }

    emit(event: string, ...args: any[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
    }
  }

  let nextWindowId = 1;
  let nextContentsId = 100;

  class FakeWebContents extends MiniEmitter {
    readonly id = nextContentsId++;
    readonly protocolHandlers = new Map<
      string,
      (request: Request) => Response | Promise<Response>
    >();
    readonly protocol = {
      handle: vi.fn(
        (scheme: string, handler: (request: Request) => Response | Promise<Response>) => {
          this.protocolHandlers.set(scheme, handler);
        }
      ),
      unhandle: vi.fn((scheme: string) => {
        this.protocolHandlers.delete(scheme);
      }),
    };
    readonly session = {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      protocol: this.protocol,
    };
    readonly openDevTools = vi.fn();
    readonly setWindowOpenHandler = vi.fn();
    readonly executeJavaScript = vi.fn(async () => false);
    readonly reload = vi.fn();
  }

  class FakeBrowserWindow extends MiniEmitter {
    static readonly instances: FakeBrowserWindow[] = [];
    readonly id = nextWindowId++;
    private readonly contents = new FakeWebContents();
    readonly contentView = { addChildView: vi.fn(), removeChildView: vi.fn() };
    readonly show = vi.fn();
    readonly focus = vi.fn();
    readonly close = vi.fn(() => this.destroy());
    readonly restore = vi.fn();
    readonly setIcon = vi.fn();
    readonly setMenu = vi.fn();
    private destroyed = false;

    constructor(readonly options: unknown) {
      super();
      FakeBrowserWindow.instances.push(this);
    }

    get webContents(): FakeWebContents {
      if (this.destroyed) throw new TypeError('Object has been destroyed');
      return this.contents;
    }

    async loadURL(_url: string): Promise<void> {}
    isDestroyed(): boolean {
      return this.destroyed;
    }
    isMinimized(): boolean {
      return false;
    }
    getBounds(): { x: number; y: number; width: number; height: number } {
      return { x: 40, y: 20, width: 1200, height: 800 };
    }
    getNativeWindowHandle(): Buffer {
      const handle = Buffer.alloc(8);
      handle.writeUInt32LE(0x1234, 0);
      return handle;
    }
    destroy(): void {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('closed');
    }

    static reset(): void {
      FakeBrowserWindow.instances.length = 0;
      nextWindowId = 1;
      nextContentsId = 100;
    }
  }

  return {
    FakeBrowserWindow,
    dialog: {
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn(),
    },
    screen: {
      getDisplayMatching: vi.fn(() => ({
        workAreaSize: { width: 1512, height: 944 },
      })),
      getPrimaryDisplay: vi.fn(() => ({
        workAreaSize: { width: 1512, height: 944 },
      })),
    },
    shell: { openExternal: vi.fn() },
    fetch: vi.fn(
      async () =>
        new Response('image-bytes', {
          headers: { 'Content-Type': 'application/octet-stream' },
        })
    ),
  };
});

vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: electron.FakeBrowserWindow,
  WebContentsView: class {},
  dialog: electron.dialog,
  screen: electron.screen,
  shell: electron.shell,
  net: { fetch: electron.fetch },
  session: { fromPartition: vi.fn() },
}));

import { WindowRegistry } from '../window-registry.js';
import type { WindowConnection } from '../../transport/electron/window-connection.js';

beforeEach(() => {
  electron.FakeBrowserWindow.reset();
  vi.clearAllMocks();
});

async function registryFixture(development = false): Promise<{
  registry: WindowRegistry;
  session: Awaited<ReturnType<WindowRegistry['createMainWindow']>>;
}> {
  const registry = new WindowRegistry({
    rendererUrl: 'http://localhost:5174/',
    rendererBuildId: '0.1.0',
    platform: 'linux',
  });
  const session = await registry.createMainWindow({
    rendererUrl: 'http://localhost:5174/',
    preloadPath: '/app/preload.cjs',
    iconPath: '/app/icon.png',
    development,
  });
  return { registry, session };
}

function request(
  senderId: number,
  overrides: Partial<Parameters<WindowRegistry['authorize']>[0]> = {}
): Parameters<WindowRegistry['authorize']>[0] {
  return {
    senderId,
    frameUrl: 'http://localhost:5174/',
    isMainFrame: true,
    hello: {
      protocolVersion: 1,
      rendererBuildId: '0.1.0',
      windowNonce: 'nonce-one',
    },
    ...overrides,
  };
}

function connection(id: string): WindowConnection {
  return {
    id,
    close: vi.fn(async () => undefined),
  } as unknown as WindowConnection;
}

describe('WindowRegistry bootstrap authorization', () => {
  it('removes the native menu from the main window', async () => {
    const { registry, session } = await registryFixture();

    expect(session.window.setMenu).toHaveBeenCalledOnce();
    expect(session.window.setMenu).toHaveBeenCalledWith(null);
    await registry.stop('test');
  });

  it('updates the live main-window icon without recreating the window', async () => {
    const { registry, session } = await registryFixture();

    registry.setMainWindowIcon('/app/icon-on-light.png');

    expect(session.window.setIcon).toHaveBeenCalledWith('/app/icon-on-light.png');
    await registry.stop('test');
  });

  it('presents the main window after loading when ready-to-show is not emitted', async () => {
    const { registry, session } = await registryFixture();

    expect(session.window.show).toHaveBeenCalledOnce();
    expect(session.window.focus).toHaveBeenCalledOnce();

    session.window.emit('ready-to-show');
    expect(session.window.show).toHaveBeenCalledOnce();
    expect(session.window.focus).toHaveBeenCalledOnce();
    await registry.stop('test');
  });

  it('reloads a blank development renderer after its module graph fails to start', async () => {
    vi.useFakeTimers();
    try {
      const { registry, session } = await registryFixture(true);
      const contents = session.window.webContents as unknown as InstanceType<
        typeof electron.FakeBrowserWindow
      >['webContents'];
      contents.executeJavaScript.mockResolvedValue(true);

      contents.emit('did-finish-load');
      await vi.advanceTimersByTimeAsync(1_500);

      expect(contents.reload).toHaveBeenCalledOnce();
      await registry.stop('test');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not install blank-renderer recovery in production windows', async () => {
    vi.useFakeTimers();
    try {
      const { registry, session } = await registryFixture(false);
      const contents = session.window.webContents as unknown as InstanceType<
        typeof electron.FakeBrowserWindow
      >['webContents'];
      contents.executeJavaScript.mockResolvedValue(true);

      contents.emit('did-finish-load');
      await vi.advanceTimersByTimeAsync(1_500);

      expect(contents.executeJavaScript).not.toHaveBeenCalled();
      expect(contents.reload).not.toHaveBeenCalled();
      await registry.stop('test');
    } finally {
      vi.useRealTimers();
    }
  });

  it('projects the main window handle through a narrow presentation value', async () => {
    const { registry } = await registryFixture();
    expect(registry.pilotCallerWindow()).toEqual({ windowId: '0x1234' });
    expect(registry.pilotBrowserWindowSize()).toEqual({ width: 1024, height: 944 });
    expect(electron.screen.getDisplayMatching).toHaveBeenCalledWith({
      x: 40,
      y: 20,
      width: 1200,
      height: 800,
    });
    await registry.stop('test');
    expect(registry.pilotCallerWindow()).toEqual({});
    expect(registry.pilotBrowserWindowSize()).toBeUndefined();
  });

  it('rejects unknown senders, child frames, foreign URLs and wrong builds', async () => {
    const { registry, session } = await registryFixture();

    expect(registry.authorize(request(999))).toBeUndefined();
    expect(
      registry.authorize(request(session.webContentsId, { isMainFrame: false }))
    ).toBeUndefined();
    expect(
      registry.authorize(
        request(session.webContentsId, {
          frameUrl: 'https://example.com/',
        })
      )
    ).toBeUndefined();
    expect(
      registry.authorize(
        request(session.webContentsId, {
          hello: {
            protocolVersion: 1,
            rendererBuildId: 'wrong-build',
            windowNonce: 'nonce-two',
          },
        })
      )
    ).toBeUndefined();

    await registry.stop('test');
  });

  it('allows one connection per document and never closes it for hash routing', async () => {
    const { registry, session } = await registryFixture();
    const first = connection('connection-one');
    const authorized = registry.authorize(request(session.webContentsId));
    expect(authorized).toBeDefined();
    authorized!.attach(first);
    expect(session.snapshot().connections).toBe(1);
    expect(
      registry.authorize(
        request(session.webContentsId, {
          hello: {
            protocolVersion: 1,
            rendererBuildId: '0.1.0',
            windowNonce: 'nonce-two',
          },
        })
      )
    ).toBeUndefined();

    (session.window.webContents as any).emit(
      'did-start-navigation',
      {},
      'http://localhost:5174/#/settings',
      true,
      true
    );
    expect(first.close).not.toHaveBeenCalled();
    expect(session.snapshot()).toMatchObject({ navigationEpoch: 0, connections: 1 });

    (session.window.webContents as any).emit(
      'did-start-navigation',
      {},
      'http://localhost:5174/',
      false,
      true
    );
    expect(first.close).toHaveBeenCalledWith('main-frame-navigation');
    expect(session.snapshot()).toMatchObject({ navigationEpoch: 1, connections: 0 });
    expect(registry.authorize(request(session.webContentsId))).toBeUndefined();

    const secondAuthorization = registry.authorize(
      request(session.webContentsId, {
        hello: {
          protocolVersion: 1,
          rendererBuildId: '0.1.0',
          windowNonce: 'nonce-two',
        },
      })
    );
    expect(secondAuthorization).toBeDefined();
    await registry.stop('test');
  });

  it('invalidates the current connection and epoch after a renderer crash', async () => {
    const { registry, session } = await registryFixture();
    const active = connection('connection-one');
    registry.authorize(request(session.webContentsId))!.attach(active);

    (session.window.webContents as any).emit(
      'render-process-gone',
      {},
      { reason: 'crashed', exitCode: 1 }
    );
    expect(active.close).toHaveBeenCalledWith('renderer-gone');
    expect(session.snapshot()).toMatchObject({ navigationEpoch: 1, connections: 0 });

    const next = registry.authorize(
      request(session.webContentsId, {
        hello: {
          protocolVersion: 1,
          rendererBuildId: '0.1.0',
          windowNonce: 'nonce-after-crash',
        },
      })
    );
    expect(next).toBeDefined();
    await registry.stop('test');
  });

  it('releases the session after Electron destroys the owner window', async () => {
    const { registry, session } = await registryFixture();
    const active = connection('connection-one');
    registry.authorize(request(session.webContentsId))!.attach(active);

    session.window.destroy();
    await vi.waitFor(() => {
      expect(active.close).toHaveBeenCalledWith('window-closed');
    });

    expect(active.close).toHaveBeenCalledOnce();
    expect(session.snapshot()).toMatchObject({ disposed: true, connections: 0 });
    expect(registry.mainSession()).toBeUndefined();
    await expect(session.dispose('duplicate-release')).resolves.toBeUndefined();
    expect(active.close).toHaveBeenCalledOnce();
    await expect(registry.stop('test')).resolves.toBeUndefined();
  });

  it('streams file previews through opaque per-window tokens', async () => {
    const { registry, session } = await registryFixture();
    const sourcePath = '/tmp/private folder/screenshot.png';
    const previewUrl = registry.createFilePreviewUrl(session.id, sourcePath, 'image/png');
    expect(previewUrl).toMatch(/^piskie-attachment:\/\/preview\/[0-9a-f-]+$/);
    expect(previewUrl).not.toContain(sourcePath);

    const contents = session.window.webContents as unknown as InstanceType<
      typeof electron.FakeBrowserWindow
    >['webContents'];
    const handler = contents.protocolHandlers.get('piskie-attachment');
    expect(handler).toBeDefined();
    const response = await handler!(new Request(previewUrl));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('image-bytes');
    expect(electron.fetch).toHaveBeenCalledWith('file:///tmp/private%20folder/screenshot.png', {
      method: 'GET',
      headers: undefined,
    });
    await registry.stop('test');
    expect(contents.protocol.unhandle).toHaveBeenCalledWith('piskie-attachment');
  });

  it('rejects unknown and released preview tokens without touching the filesystem', async () => {
    const { registry, session } = await registryFixture();
    const contents = session.window.webContents as unknown as InstanceType<
      typeof electron.FakeBrowserWindow
    >['webContents'];
    const handler = contents.protocolHandlers.get('piskie-attachment')!;

    const unknown = await handler(new Request('piskie-attachment://preview/not-a-token'));
    expect(unknown.status).toBe(404);
    expect(electron.fetch).not.toHaveBeenCalled();

    const previewUrl = registry.createFilePreviewUrl(session.id, '/tmp/image.png', 'image/png');
    session.window.destroy();
    await vi.waitFor(() => expect(registry.mainSession()).toBeUndefined());
    const released = await handler(new Request(previewUrl));
    expect(released.status).toBe(404);
    expect(electron.fetch).not.toHaveBeenCalled();
    await registry.stop('test');
  });
});
