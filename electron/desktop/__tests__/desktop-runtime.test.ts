import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
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
        this.listeners.get(event)?.delete(wrapped);
        listener(...args);
      };
      return this.on(event, wrapped);
    }

    emit(event: string, ...args: any[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
    }

    reset(): void {
      this.listeners.clear();
    }
  }

  const app = Object.assign(new MiniEmitter(), {
    whenReady: vi.fn(async () => undefined),
    exit: vi.fn(),
    dock: { setIcon: vi.fn() },
  });
  const getAllWindows = vi.fn((): unknown[] => []);
  const showErrorBox = vi.fn();

  class FakePortServer {
    static readonly instances: FakePortServer[] = [];
    readonly start = vi.fn();
    readonly stop = vi.fn(async () => undefined);
    private listening = false;

    constructor(readonly options: unknown) {
      FakePortServer.instances.push(this);
      this.start.mockImplementation(() => { this.listening = true; });
      this.stop.mockImplementation(async () => { this.listening = false; });
    }

    snapshot(): { listening: boolean; connectionCount: number } {
      return { listening: this.listening, connectionCount: 0 };
    }

    static reset(): void {
      FakePortServer.instances.length = 0;
    }
  }

  const createApplicationComposition = vi.fn(() => ({
    catalog: {
      operations: new Map(),
      topics: new Map(),
      capabilities: [],
    },
    releaseConnection: vi.fn(),
  }));
  const configServer = { stop: vi.fn(async () => undefined) };
  const startLocalConfigServer = vi.fn(async () => configServer);

  return {
    app,
    getAllWindows,
    showErrorBox,
    FakePortServer,
    createApplicationComposition,
    configServer,
    startLocalConfigServer,
  };
});

vi.mock('electron', () => ({
  app: harness.app,
  BrowserWindow: { getAllWindows: harness.getAllWindows },
  dialog: { showErrorBox: harness.showErrorBox },
}));

vi.mock('../../capabilities/application-composition.js', () => ({
  createApplicationComposition: harness.createApplicationComposition,
}));

vi.mock('../../transport/electron/bootstrap-listener.js', () => ({
  ElectronPortServer: harness.FakePortServer,
}));

vi.mock('../../config/host/local-transport.js', () => ({
  startLocalConfigServer: harness.startLocalConfigServer,
}));

import { DesktopRuntime } from '../desktop-runtime.js';

beforeEach(() => {
  harness.app.reset();
  harness.FakePortServer.reset();
  vi.clearAllMocks();
  harness.app.whenReady.mockResolvedValue(undefined);
  harness.getAllWindows.mockReturnValue([]);
  harness.app.dock.setIcon.mockReset();
  harness.configServer.stop.mockReset();
  harness.startLocalConfigServer.mockClear();
});

function fixture(options: {
  platform?: NodeJS.Platform;
  createWindow?: () => Promise<unknown>;
  stopBackend?: (reason: string) => Promise<unknown>;
} = {}) {
  let phase = 'created';
  const backend = {
    start: vi.fn(async () => {
      phase = 'ready';
      return {
        generation: 'generation-test',
        phase: 'ready',
        startedAt: 1,
        readyAt: 2,
        components: [],
        degradedCapabilities: [],
      };
    }),
    stop: vi.fn(async (reason: string) => {
      if (phase !== 'ready') throw new Error(`cannot stop from ${phase}`);
      if (options.stopBackend) return options.stopBackend(reason);
      phase = 'stopped';
      return shutdownReport(reason);
    }),
    snapshot: vi.fn(() => ({
      generation: 'generation-test',
      phase,
      startedAt: 1,
      degradedCapabilities: [],
    })),
    capabilities: vi.fn(() => ({
      userDataDirectory: '/tmp/piskie-desktop-runtime-test',
      inference: { inferenceHost: { configHost: { kind: 'test-config-host' } } },
    })),
    generation: 'generation-test',
  };
  const windows = {
    setConnectionReleaseHandler: vi.fn(),
    setMainWindowIcon: vi.fn(),
    createMainWindow: vi.fn(options.createWindow ?? (async () => ({ window: {} }))),
    markQuitting: vi.fn(),
    stop: vi.fn(async () => undefined),
    snapshot: vi.fn(() => ({ stopped: false, windows: [], auxiliaryWindows: 0 })),
    authorize: vi.fn(),
    mainSession: vi.fn(),
  };
  const runtime = new DesktopRuntime({
    backend: { runtime: backend } as never,
    windows: windows as never,
    mainWindow: {
      rendererUrl: 'http://localhost:5174/',
      preloadPath: '/app/preload.cjs',
      development: false,
    },
    icons: {
      light: '/app/icon-on-light.png',
      dark: '/app/icon-on-dark.png',
      windows: '/app/icon-windows.ico',
    },
    appInfo: { name: 'Piskie', version: '0.1.0', development: false },
    platform: options.platform ?? 'linux',
  });
  return { runtime, backend, windows };
}

function shutdownReport(reason: string) {
  return {
    generation: 'generation-test',
    phase: 'stopped',
    requestedAt: 3,
    finishedAt: 4,
    reason,
    components: [],
    verification: [],
    residualResources: [],
  } as const;
}

describe('DesktopRuntime', () => {
  it('applies the effective application theme to live and reopened window icons', async () => {
    const { runtime, windows } = fixture();
    await runtime.run();
    expect(windows.createMainWindow).toHaveBeenLastCalledWith(expect.objectContaining({
      iconPath: '/app/icon-on-dark.png',
    }));

    runtime.setColorScheme('light');
    expect(windows.setMainWindowIcon).toHaveBeenCalledWith('/app/icon-on-light.png');

    harness.app.emit('activate');
    await Promise.resolve();
    expect(windows.createMainWindow).toHaveBeenLastCalledWith(expect.objectContaining({
      iconPath: '/app/icon-on-light.png',
    }));
    await runtime.requestQuit('test-complete');
  });

  it('keeps a dedicated high-contrast Windows icon across application themes', async () => {
    const { runtime, windows } = fixture({ platform: 'win32' });
    await runtime.run();
    expect(windows.createMainWindow).toHaveBeenLastCalledWith(expect.objectContaining({
      iconPath: '/app/icon-windows.ico',
    }));

    runtime.setColorScheme('light');
    expect(windows.setMainWindowIcon).toHaveBeenCalledWith('/app/icon-windows.ico');

    harness.app.emit('activate');
    await Promise.resolve();
    expect(windows.createMainWindow).toHaveBeenLastCalledWith(expect.objectContaining({
      iconPath: '/app/icon-windows.ico',
    }));
    await runtime.requestQuit('test-complete');
  });

  it('updates the macOS Dock icon from the effective application theme', async () => {
    const { runtime } = fixture({ platform: 'darwin' });
    await runtime.run();

    runtime.setColorScheme('light');

    expect(harness.app.dock.setIcon).toHaveBeenCalledWith('/app/icon-on-light.png');
    await runtime.requestQuit('test-complete');
  });

  it('keeps one backend and one bootstrap listener across macOS close/reopen', async () => {
    const { runtime, backend, windows } = fixture({ platform: 'darwin' });
    await runtime.run();
    expect(backend.start).toHaveBeenCalledOnce();
    expect(windows.createMainWindow).toHaveBeenCalledOnce();
    expect(harness.FakePortServer.instances[0]!.start).toHaveBeenCalledOnce();
    expect(harness.startLocalConfigServer).toHaveBeenCalledOnce();

    harness.app.emit('window-all-closed');
    await Promise.resolve();
    expect(backend.stop).not.toHaveBeenCalled();

    harness.app.emit('activate');
    await Promise.resolve();
    expect(windows.createMainWindow).toHaveBeenCalledTimes(2);
    expect(backend.start).toHaveBeenCalledOnce();
    expect(harness.FakePortServer.instances).toHaveLength(1);
    expect(harness.FakePortServer.instances[0]!.start).toHaveBeenCalledOnce();

    await runtime.requestQuit('test-complete');
  });

  it('coalesces concurrent quit sources and keeps the first reason', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { runtime, backend, windows } = fixture({
      stopBackend: async (reason) => {
        await gate;
        return shutdownReport(reason);
      },
    });
    await runtime.run();

    const menu = runtime.requestQuit('menu');
    const signal = runtime.requestQuit('SIGTERM');
    expect(signal).toBe(menu);
    release();

    await expect(menu).resolves.toMatchObject({ exitCode: 0 });
    expect(backend.stop).toHaveBeenCalledOnce();
    expect(backend.stop).toHaveBeenCalledWith('menu');
    expect(windows.stop).toHaveBeenCalledOnce();
    expect(harness.FakePortServer.instances[0]!.stop).toHaveBeenCalledOnce();
    expect(harness.configServer.stop).toHaveBeenCalledOnce();
    expect(harness.app.exit).toHaveBeenCalledOnce();
    expect(harness.app.exit).toHaveBeenCalledWith(0);
  });

  it('shuts the ready backend down and exits non-zero when window startup fails', async () => {
    const { runtime, backend, windows } = fixture({
      createWindow: async () => { throw new Error('renderer load failed'); },
    });

    await runtime.run();
    expect(harness.showErrorBox).toHaveBeenCalledWith(
      'Service startup failed',
      expect.stringContaining('renderer load failed'),
    );
    expect(windows.stop).toHaveBeenCalledWith('desktop-startup-failed');
    expect(backend.stop).toHaveBeenCalledWith('desktop-startup-failed');
    expect(harness.app.exit).toHaveBeenCalledWith(1);
  });

  it('does not create a backend or window after quit was requested before app readiness', async () => {
    let ready!: () => void;
    harness.app.whenReady.mockReturnValue(new Promise<void>((resolve) => { ready = resolve; }));
    const { runtime, backend, windows } = fixture();
    const run = runtime.run();
    const quit = runtime.requestQuit('SIGTERM');
    ready();

    await Promise.all([run, quit]);
    expect(backend.start).not.toHaveBeenCalled();
    expect(windows.createMainWindow).not.toHaveBeenCalled();
    expect(harness.app.exit).toHaveBeenCalledWith(1);
  });

  it('closes a ConfigHost endpoint that finishes starting during shutdown', async () => {
    let releaseEndpoint!: (server: typeof harness.configServer) => void;
    harness.startLocalConfigServer.mockReturnValueOnce(new Promise((resolve) => {
      releaseEndpoint = resolve;
    }));
    const { runtime, windows } = fixture();
    const run = runtime.run();
    await vi.waitFor(() => expect(harness.startLocalConfigServer).toHaveBeenCalledOnce());

    const quit = runtime.requestQuit('startup-race');
    releaseEndpoint(harness.configServer);
    await Promise.all([run, quit]);

    expect(harness.configServer.stop).toHaveBeenCalledOnce();
    expect(windows.createMainWindow).not.toHaveBeenCalled();
  });
});
