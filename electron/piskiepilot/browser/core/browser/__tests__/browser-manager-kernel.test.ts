import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../webrtc-preferences.js', () => ({
  ensureWebrtcPreferences: vi.fn().mockResolvedValue(undefined),
}));

import puppeteer from 'puppeteer-core';
import { BrowserManager } from '../browser-manager.js';
import { getUserDataRoot } from '@electron/piskiepilot/paths.js';
import { fingerprintBrowser } from '../../../fingerprint/runtime.js';
import { BrowserAutomationSession } from '../../session/browser-automation-session.js';
import { WindowController } from '../window-controller.js';
import type { BrowserLaunchSpec } from '../browser-launch-spec.js';
import { getNetworkRequest } from '../../../skills/browser/index.js';

type TestBrowserManager = {
  initialized: boolean;
  instances: Map<string, unknown>;
  readPersistedBrowserConfig(browserId: string): Promise<unknown>;
  savePersisted(browserId: string, config: unknown): Promise<void>;
  deletePersisted(browserId: string): Promise<void>;
};

const manager = BrowserManager as unknown as TestBrowserManager;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function mockKernel(browser = fakeBrowser()) {
  vi.spyOn(fingerprintBrowser, 'launch').mockResolvedValue({
    seed: 1, config: { platform: 'linux' }, browserWSEndpoint: 'ws://example.test/browser',
  } as never);
  vi.spyOn(fingerprintBrowser, 'has').mockReturnValue(true);
  vi.spyOn(fingerprintBrowser, 'getPid').mockReturnValue(undefined);
  const stop = vi.spyOn(fingerprintBrowser, 'stop').mockResolvedValue(true);
  const connect = vi.spyOn(puppeteer, 'connect').mockResolvedValue(browser as never);
  browser.disconnect.mockImplementation(async () => { browser.emitDisconnected(); });
  return { browser, stop, connect };
}

function launchSpec(browserId: string, userDataId: string): BrowserLaunchSpec {
  return {
    generation: `generation-${browserId}`,
    browserId,
    userDataId,
    proxy: {
      server: 'http://127.0.0.1:8080',
      username: 'browser-user',
      password: 'browser-password',
      bypassList: ['localhost'],
    },
    identity: {
      language: 'zh-CN',
      timezone: 'Asia/Shanghai',
    },
    fingerprint: {
      platform: 'windows',
      hardwareConcurrency: 12,
      webrtc: 'proxy',
    },
    backgroundMode: true,
  };
}

function fakeBrowser() {
  let connected = true;
  const disconnectedListeners: Array<() => void> = [];
  return {
    disconnect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    get connected() {
      return connected;
    },
    on: vi.fn((event: string, listener: () => void) => {
      if (event === 'disconnected') disconnectedListeners.push(listener);
    }),
    process: vi.fn(() => null),
    wsEndpoint: vi.fn(() => 'ws://resolved-external'),
    emitDisconnected: () => {
      connected = false;
      for (const listener of disconnectedListeners) listener();
    },
  };
}

beforeEach(() => {
  manager.instances.clear();
  manager.initialized = true;

  vi.spyOn(manager, 'readPersistedBrowserConfig').mockResolvedValue(null);
  vi.spyOn(manager, 'savePersisted').mockResolvedValue(undefined);
  vi.spyOn(manager, 'deletePersisted').mockResolvedValue(undefined);
  vi.spyOn(BrowserAutomationSession, 'create').mockResolvedValue({ dispose: vi.fn() } as never);
  vi.spyOn(WindowController, 'initialize').mockResolvedValue(undefined);
});

afterEach(() => {
  manager.instances.clear();
  vi.restoreAllMocks();
});

describe('BrowserManager stop cancellation', () => {
  it('retains startup ownership when initialization and process cleanup both fail', async () => {
    const { stop } = mockKernel();
    stop.mockResolvedValueOnce(true).mockRejectedValue(new Error('Process termination failed'));
    vi.mocked(BrowserAutomationSession.create).mockRejectedValue(new Error('Session initialization failed'));
    await expect(BrowserManager.getOrCreate('browser-a', {
      launchSpec: launchSpec('browser-a', 'profile-a'),
    })).rejects.toThrow('startup cleanup failed');
    await expect(BrowserManager.close('browser-a')).rejects.toThrow('startup cleanup failed');
    expect(BrowserManager.ownedIds()).toEqual(['browser-a']);
    expect(manager.deletePersisted).not.toHaveBeenCalled();
  });

  it('releases a stuck response body and queued calls while still waiting for process shutdown', async () => {
    const { stop } = mockKernel();
    const bodyStarted = deferred<void>();
    const processStopped = deferred<boolean>();
    vi.mocked(BrowserAutomationSession.create).mockResolvedValue({
      dispose: vi.fn(),
      throwIfDialogOpen: vi.fn(),
      getNetworkRequestId: () => 1,
      getNetworkRequestById: () => ({
        hasPostData: () => false,
        response: () => ({ buffer: () => { bodyStarted.resolve(); return new Promise(() => {}); } }),
      }),
    } as never);
    await BrowserManager.getOrCreate('browser-a', { launchSpec: launchSpec('browser-a', 'profile-a') });
    stop.mockClear();
    stop.mockReturnValueOnce(processStopped.promise);
    const controller = new AbortController();
    const reason = new Error('Task stopped');
    const reading = getNetworkRequest({ browserId: 'browser-a', reqid: 1, signal: controller.signal });
    await bodyStarted.promise;
    const operation = vi.fn();
    const queued = BrowserManager.runExclusive('browser-a', operation, controller.signal);
    let closed = false;
    const closing = BrowserManager.close('browser-a').then(() => { closed = true; });
    const repeatedClose = BrowserManager.close('browser-a');
    controller.abort(reason);
    await expect(reading).rejects.toBe(reason);
    await expect(queued).rejects.toBe(reason);
    expect(operation).not.toHaveBeenCalled();
    expect(closed).toBe(false);
    processStopped.resolve(true);
    await Promise.all([closing, repeatedClose]);
    expect(stop).toHaveBeenCalledOnce();
    expect(BrowserManager.ownedIds()).toEqual([]);
  });

  it('registers startup before filesystem reads and prevents a late launch after stop', async () => {
    const config = deferred<unknown>();
    vi.mocked(manager.readPersistedBrowserConfig).mockReturnValue(config.promise);
    const launch = vi.spyOn(fingerprintBrowser, 'launch');
    const starting = BrowserManager.getOrCreate('browser-a', { launchSpec: launchSpec('browser-a', 'profile-a') });
    expect(BrowserManager.ownedIds()).toEqual(['browser-a']);
    const outcome = expect(starting).rejects.toThrow('terminated');
    await BrowserManager.close('browser-a');
    await outcome;
    config.resolve(null);
    await Promise.resolve();
    expect(launch).not.toHaveBeenCalled();
    expect(BrowserManager.ownedIds()).toEqual([]);
  });

  it('cancels a connection waiter and closes startup without waiting for Puppeteer connect', async () => {
    const { stop, connect, browser } = mockKernel();
    const connection = deferred<never>();
    connect.mockReturnValue(connection.promise);
    const starting = BrowserManager.getOrCreate('browser-a', { launchSpec: launchSpec('browser-a', 'profile-a') });
    const startedOutcome = expect(starting).rejects.toThrow('terminated');
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    stop.mockClear();
    const controller = new AbortController();
    const reason = new Error('Task stopped');
    const operation = vi.fn();
    const waiting = BrowserManager.runExclusive('browser-a', operation, controller.signal);
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    await BrowserManager.close('browser-a');
    await startedOutcome;
    expect(stop).toHaveBeenCalledWith('profile-a');
    expect(operation).not.toHaveBeenCalled();
    connection.resolve(browser as never);
    await Promise.resolve();
    expect(browser.disconnect).toHaveBeenCalled();
    expect(BrowserManager.ownedIds()).toEqual([]);
  });

  it('closes the original process when stop interrupts transport recovery', async () => {
    const { browser, stop, connect } = mockKernel();
    await BrowserManager.getOrCreate('browser-a', { launchSpec: launchSpec('browser-a', 'profile-a') });
    vi.mocked(manager.readPersistedBrowserConfig).mockResolvedValue({
      userDataId: 'profile-a', wsEndpoint: 'ws://example.test/browser',
    });
    browser.emitDisconnected();
    connect.mockReturnValue(new Promise(() => {}));
    const operation = vi.fn();
    const waiting = BrowserManager.runExclusive('browser-a', operation);
    const outcome = expect(waiting).rejects.toThrow('terminated');
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    stop.mockClear();
    await BrowserManager.close('browser-a');
    await outcome;
    expect(stop).toHaveBeenCalledOnce();
    expect(operation).not.toHaveBeenCalled();
    expect(BrowserManager.ownedIds()).toEqual([]);
  });
});

describe('BrowserManager managed-kernel launch', () => {
  it('uses fingerprint-chromium for a bound profile and preserves launch settings', async () => {
    const browser = fakeBrowser();
    let running = false;
    const launch = vi
      .spyOn(fingerprintBrowser, 'launch')
      .mockImplementation(async (profileId, fp) => {
      running = true;
      return {
        seed: 7,
        config: {
          platform: fp.platform || 'windows',
          seed: 7,
        },
        browserWSEndpoint: 'ws://managed-kernel',
      } as never;
    });
    vi.spyOn(fingerprintBrowser, 'has').mockImplementation(() => running);
    vi.spyOn(fingerprintBrowser, 'getPid').mockReturnValue(4242);
    vi.spyOn(fingerprintBrowser, 'stop').mockImplementation(async () => {
      running = false;
      return true;
    });
    const connect = vi.spyOn(puppeteer, 'connect').mockResolvedValue(browser as never);
    await expect(
      BrowserManager.getOrCreate('browser-a', {
        launchSpec: {
          ...launchSpec('browser-a', 'profile-a'),
          windowSize: { width: 1024, height: 900 },
        },
        callerWindow: { windowId: '0x123' },
      })
    ).resolves.toBe('browser-a');

    expect(launch).toHaveBeenCalledOnce();
    const [profileId, fpConfig] = launch.mock.calls[0];
    expect(profileId).toBe('profile-a');
    expect(fpConfig).toMatchObject({
      platform: 'windows',
      locale: 'zh-CN',
      timezone: 'Asia/Shanghai',
      hardwareConcurrency: 12,
      proxy: { server: 'http://127.0.0.1:8080' },
      userDataDir: path.join(getUserDataRoot(), 'profile-a', 'chrome-data'),
    });
    expect(fpConfig.extraArgs).toEqual(
      expect.arrayContaining([
        '--window-size=1024,900',
        '--window-position=0,0',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--proxy-bypass-list=localhost',
      ])
    );
    expect(fpConfig.extraArgs).not.toContain('--start-maximized');
    expect(connect).toHaveBeenCalledWith({
      browserWSEndpoint: 'ws://managed-kernel',
      defaultViewport: null,
      protocolTimeout: 0,
    });
    expect(WindowController.initialize).toHaveBeenCalledWith('browser-a', {
      startHidden: true,
      callerWindow: { windowId: '0x123' },
    });
    expect(manager.savePersisted).toHaveBeenCalledWith(
      'browser-a',
      expect.objectContaining({
      launchGeneration: 'generation-browser-a',
      })
    );

    await BrowserManager.close('browser-a');
    expect(fingerprintBrowser.stop).toHaveBeenCalledWith('profile-a');
    expect(manager.deletePersisted).toHaveBeenCalledWith('browser-a');
  });

  it('disposes a session that disconnects during post-connect initialization', async () => {
    const browser = fakeBrowser();
    let running = false;
    vi.spyOn(fingerprintBrowser, 'launch').mockImplementation(async () => {
      running = true;
      return {
        seed: 7,
        config: { platform: 'windows', seed: 7 },
        browserWSEndpoint: 'ws://managed-kernel',
      } as never;
    });
    vi.spyOn(fingerprintBrowser, 'has').mockImplementation(() => running);
    vi.spyOn(fingerprintBrowser, 'getPid').mockReturnValue(4242);
    vi.spyOn(fingerprintBrowser, 'stop').mockImplementation(async () => {
      running = false;
      return true;
    });
    vi.spyOn(puppeteer, 'connect').mockResolvedValue(browser as never);
    const automation = { dispose: vi.fn() };
    vi.mocked(BrowserAutomationSession.create).mockResolvedValue(automation as never);
    let finishWindowInitialization!: () => void;
    vi.mocked(WindowController.initialize).mockImplementationOnce(() =>
      new Promise<void>((resolve) => {
        finishWindowInitialization = resolve;
      })
    );

    const creating = BrowserManager.getOrCreate('browser-a', {
      launchSpec: launchSpec('browser-a', 'profile-a'),
    });
    await vi.waitFor(() => expect(WindowController.initialize).toHaveBeenCalledOnce());
    browser.emitDisconnected();
    expect(automation.dispose).toHaveBeenCalledOnce();
    finishWindowInitialization();

    await expect(creating).rejects.toThrow('disconnected during initialization');
    expect(manager.savePersisted).not.toHaveBeenCalled();
    expect(fingerprintBrowser.stop).toHaveBeenCalledWith('profile-a');
  });

  it('uses the explicitly bound userDataId as the stable isolated profile', async () => {
    const browser = fakeBrowser();
    const launch = vi.spyOn(fingerprintBrowser, 'launch').mockResolvedValue({
      seed: 7,
      config: { platform: 'macos' },
      browserWSEndpoint: 'ws://managed-kernel',
    } as never);
    vi.spyOn(fingerprintBrowser, 'has').mockReturnValue(false);
    vi.spyOn(fingerprintBrowser, 'getPid').mockReturnValue(4242);
    vi.spyOn(fingerprintBrowser, 'stop').mockResolvedValue(false);
    vi.spyOn(puppeteer, 'connect').mockResolvedValue(browser as never);

    await BrowserManager.getOrCreate('temporary-browser', {
      launchSpec: launchSpec('temporary-browser', 'temporary-browser'),
    });

    expect(launch).toHaveBeenCalledWith(
      'temporary-browser',
      expect.objectContaining({
        userDataDir: path.join(getUserDataRoot(), 'temporary-browser', 'chrome-data'),
      }),
      expect.any(AbortSignal),
    );
  });

  it('refuses to spawn a managed browser without a launch spec', async () => {
    vi.spyOn(fingerprintBrowser, 'launch');

    await expect(BrowserManager.getOrCreate('browser-a')).rejects.toThrow(
      'immutable BrowserLaunchSpec'
    );
    expect(fingerprintBrowser.launch).not.toHaveBeenCalled();
  });

  it('recovers an unexpected transport disconnect with the same process and persisted identity', async () => {
    const firstConnection = fakeBrowser();
    const recoveredConnection = fakeBrowser();
    vi.mocked(manager.readPersistedBrowserConfig).mockResolvedValue({
      userDataId: 'profile-a',
      userDataDir: '/profiles/profile-a',
      wsEndpoint: 'ws://managed-kernel',
      backgroundMode: true,
      pid: 4242,
      launchGeneration: 'generation-browser-a',
    });
    vi.spyOn(fingerprintBrowser, 'has').mockReturnValue(true);
    vi.spyOn(fingerprintBrowser, 'getPid').mockReturnValue(4242);
    const launch = vi.spyOn(fingerprintBrowser, 'launch');
    const connect = vi
      .spyOn(puppeteer, 'connect')
      .mockResolvedValueOnce(firstConnection as never)
      .mockResolvedValueOnce(recoveredConnection as never);

    await BrowserManager.getOrCreate('browser-a');
    firstConnection.emitDisconnected();
    expect(BrowserManager.has('browser-a')).toBe(true);

    await BrowserManager.runExclusive('browser-a', () => undefined);

    expect(connect).toHaveBeenCalledTimes(2);
    expect(launch).not.toHaveBeenCalled();
    await expect(BrowserManager.runExclusive('browser-a', ({ browser }) => browser)).resolves.toBe(
      recoveredConnection
    );
    expect(WindowController.initialize).toHaveBeenLastCalledWith('browser-a', {
      startHidden: true,
      callerWindow: undefined,
    });
    expect(manager.savePersisted).toHaveBeenLastCalledWith(
      'browser-a',
      expect.objectContaining({
      userDataId: 'profile-a',
      userDataDir: '/profiles/profile-a',
      backgroundMode: true,
      launchGeneration: 'generation-browser-a',
      })
    );
  });

  it('coalesces concurrent recovery and ignores a stale generation disconnect callback', async () => {
    const firstConnection = fakeBrowser();
    const recoveredConnection = fakeBrowser();
    vi.mocked(manager.readPersistedBrowserConfig).mockResolvedValue({
      userDataId: 'profile-a',
      wsEndpoint: 'ws://managed-kernel',
      pid: 4242,
    });
    vi.spyOn(fingerprintBrowser, 'has').mockReturnValue(true);
    vi.spyOn(fingerprintBrowser, 'getPid').mockReturnValue(4242);
    let finishRecovery!: (browser: ReturnType<typeof fakeBrowser>) => void;
    const recoveryConnection = new Promise<ReturnType<typeof fakeBrowser>>((resolve) => {
      finishRecovery = resolve;
    });
    const connect = vi
      .spyOn(puppeteer, 'connect')
      .mockResolvedValueOnce(firstConnection as never)
      .mockImplementationOnce(() => recoveryConnection as never);

    await BrowserManager.getOrCreate('browser-a');
    firstConnection.emitDisconnected();

    const first = BrowserManager.runExclusive('browser-a', () => undefined);
    const second = BrowserManager.runExclusive('browser-a', () => undefined);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    finishRecovery(recoveredConnection);
    await Promise.all([first, second]);

    firstConnection.emitDisconnected();
    expect(connect).toHaveBeenCalledTimes(2);
    await expect(BrowserManager.runExclusive('browser-a', ({ browser }) => browser)).resolves.toBe(
      recoveredConnection
    );
  });

  it('recovers before runExclusive and dispatches the operation exactly once', async () => {
    const firstConnection = fakeBrowser();
    const recoveredConnection = fakeBrowser();
    const firstContext = { generation: 'first', dispose: vi.fn() };
    const recoveredContext = { generation: 'recovered', dispose: vi.fn() };
    vi.mocked(manager.readPersistedBrowserConfig).mockResolvedValue({
      userDataId: 'profile-a',
      wsEndpoint: 'ws://managed-kernel',
      pid: 4242,
    });
    vi.spyOn(fingerprintBrowser, 'has').mockReturnValue(true);
    vi.spyOn(fingerprintBrowser, 'getPid').mockReturnValue(4242);
    vi.spyOn(puppeteer, 'connect')
      .mockResolvedValueOnce(firstConnection as never)
      .mockResolvedValueOnce(recoveredConnection as never);
    vi.mocked(BrowserAutomationSession.create)
      .mockResolvedValueOnce(firstContext as never)
      .mockResolvedValueOnce(recoveredContext as never);

    await BrowserManager.getOrCreate('browser-a');
    firstConnection.emitDisconnected();
    const operation = vi.fn(async ({ automation }: { automation: unknown }) => automation);

    await expect(BrowserManager.runExclusive('browser-a', operation)).resolves.toBe(
      recoveredContext
    );
    expect(operation).toHaveBeenCalledOnce();
  });

  it('never replays an operation that fails after dispatch', async () => {
    const browser = fakeBrowser();
    vi.mocked(manager.readPersistedBrowserConfig).mockResolvedValue({
      userDataId: 'profile-a',
      wsEndpoint: 'ws://managed-kernel',
      pid: 4242,
    });
    vi.spyOn(fingerprintBrowser, 'has').mockReturnValue(true);
    vi.spyOn(fingerprintBrowser, 'getPid').mockReturnValue(4242);
    const connect = vi.spyOn(puppeteer, 'connect').mockResolvedValue(browser as never);
    await BrowserManager.getOrCreate('browser-a');
    const operation = vi.fn(async () => {
      browser.emitDisconnected();
      throw new Error('completion is uncertain');
    });

    await expect(BrowserManager.runExclusive('browser-a', operation)).rejects.toThrow(
      'completion is uncertain'
    );

    expect(operation).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
  });

  it('disconnects an interrupted transport, releases the call, and reconnects later', async () => {
    const firstConnection = fakeBrowser();
    const recoveredConnection = fakeBrowser();
    firstConnection.disconnect.mockImplementation(async () => {
      firstConnection.emitDisconnected();
    });
    vi.mocked(manager.readPersistedBrowserConfig).mockResolvedValue({
      userDataId: 'profile-a',
      wsEndpoint: 'ws://managed-kernel',
      pid: 4242,
    });
    vi.spyOn(fingerprintBrowser, 'has').mockReturnValue(true);
    vi.spyOn(fingerprintBrowser, 'getPid').mockReturnValue(4242);
    const connect = vi
      .spyOn(puppeteer, 'connect')
      .mockResolvedValueOnce(firstConnection as never)
      .mockResolvedValueOnce(recoveredConnection as never);

    await BrowserManager.getOrCreate('browser-a');
    const controller = new AbortController();
    const reason = new Error('user interrupted');
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const running = BrowserManager.runExclusive(
      'browser-a',
      async () => {
        markStarted();
        return await new Promise<never>(() => {});
      },
      controller.signal
    );

    await started;
    controller.abort(reason);

    await expect(running).rejects.toBe(reason);
    expect(firstConnection.disconnect).toHaveBeenCalledOnce();
    await expect(BrowserManager.runExclusive('browser-a', ({ browser }) => browser)).resolves.toBe(
      recoveredConnection
    );
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('keeps a failed recovery endpoint for a later attempt and never starts a duplicate browser', async () => {
    vi.mocked(manager.readPersistedBrowserConfig).mockResolvedValue({
      userDataId: 'profile-a',
      wsEndpoint: 'ws://temporarily-unreachable',
      pid: 4242,
    });
    const launch = vi.spyOn(fingerprintBrowser, 'launch');
    vi.spyOn(puppeteer, 'connect').mockRejectedValue(new Error('connection refused'));

    await expect(BrowserManager.runExclusive('browser-a', () => undefined)).rejects.toThrow(
      'could not be recovered'
    );
    expect(launch).not.toHaveBeenCalled();
    expect(manager.savePersisted).not.toHaveBeenCalled();
  });

  it('retains disconnected ownership after a transient recovery failure and succeeds later', async () => {
    const firstConnection = fakeBrowser();
    const recoveredConnection = fakeBrowser();
    vi.mocked(manager.readPersistedBrowserConfig).mockResolvedValue({
      userDataId: 'profile-a',
      wsEndpoint: 'ws://managed-kernel',
      pid: 4242,
    });
    vi.spyOn(fingerprintBrowser, 'has').mockReturnValue(true);
    vi.spyOn(fingerprintBrowser, 'getPid').mockReturnValue(4242);
    const launch = vi.spyOn(fingerprintBrowser, 'launch');
    const connect = vi
      .spyOn(puppeteer, 'connect')
      .mockResolvedValueOnce(firstConnection as never)
      .mockRejectedValueOnce(new Error('endpoint still waking'))
      .mockResolvedValueOnce(recoveredConnection as never);

    await BrowserManager.getOrCreate('browser-a');
    firstConnection.emitDisconnected();

    await expect(BrowserManager.runExclusive('browser-a', () => undefined)).rejects.toThrow(
      'endpoint still waking'
    );
    expect(BrowserManager.has('browser-a')).toBe(true);
    await expect(
      BrowserManager.runExclusive('browser-a', () => undefined)
    ).resolves.toBeUndefined();

    expect(connect).toHaveBeenCalledTimes(3);
    expect(launch).not.toHaveBeenCalled();
    await expect(BrowserManager.runExclusive('browser-a', ({ browser }) => browser)).resolves.toBe(
      recoveredConnection
    );
  });

  it('never lets a persisted endpoint bypass a new immutable launch spec', async () => {
    const browser = fakeBrowser();
    vi.mocked(manager.readPersistedBrowserConfig).mockResolvedValue({
      userDataId: 'profile-a',
      wsEndpoint: 'ws://stale-generation',
      pid: 31337,
    });
    const launch = vi.spyOn(fingerprintBrowser, 'launch').mockResolvedValue({
      seed: 7,
      config: { platform: 'macos' },
      browserWSEndpoint: 'ws://fresh-generation',
    } as never);
    vi.spyOn(fingerprintBrowser, 'has').mockReturnValue(false);
    vi.spyOn(fingerprintBrowser, 'getPid').mockReturnValue(4242);
    vi.spyOn(fingerprintBrowser, 'stop').mockResolvedValue(false);
    const connect = vi.spyOn(puppeteer, 'connect').mockResolvedValue(browser as never);

    await BrowserManager.getOrCreate('browser-a', {
      launchSpec: launchSpec('browser-a', 'profile-a'),
    });

    expect(launch).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
      browserWSEndpoint: 'ws://fresh-generation',
      })
    );
    expect(connect).not.toHaveBeenCalledWith(
      expect.objectContaining({
      browserWSEndpoint: 'ws://stale-generation',
      })
    );
  });
});
