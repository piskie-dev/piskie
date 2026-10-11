import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import puppeteer from 'puppeteer-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const electron = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  return { getPath: vi.fn(() => tmpdir()), getAppPath: vi.fn(() => tmpdir()) };
});
vi.mock('electron', () => ({ app: electron }));
// Skill discovery is outside this test. Browser startup, persistence, automation and CDP are real.
vi.mock('../../../piskiepilot/runtime/pilot-runtime.js', () => ({
  PilotRuntime: class {
    async initialize() {}
    async dispose() {}
    getExecutableSkills() { return []; }
    bindToolCatalog() {}
  },
}));

import { BrowserModule } from '../browser.module.js';
import type { AgentHost } from '../../agent-host.js';
import { occupancyRegistry } from '../../../core/occupancy/index.js';
import { browserControlPort, pilotRuntimeHost } from '../../../core/pilot/pilot-manager.js';
import { browserLaunchPlanner } from '../../../core/pilot/launch/index.js';
import { browserEnvironmentRuntime } from '../../../services/browser-environment-runtime.js';
import { BrowserManager } from '../../../piskiepilot/browser/core/browser/browser-manager.js';
import { BrowserOperations } from '../../../piskiepilot/browser/core/browser/browser-operations.js';
import { fingerprintBrowser } from '../../../piskiepilot/browser/fingerprint/runtime.js';
import { setPilotRoot } from '../../../piskiepilot/paths.js';

const BROWSER_ID = 'sample-browser';
const PROFILE_ID = 'sample-profile';
const ENVIRONMENT_ID = 'sample-environment';
const OWNER_ID = 'sample-parent';

// Opt in with an installed kernel, as in browser-stop.integration.test.ts.
// BrowserManager launches a headed process, so Linux also needs a working DISPLAY.
describe.skipIf(!process.env.FP_CHROMIUM_PATH)('BrowserModule lazy startup with a real managed process', () => {
  let suiteRoot: string;
  let stateRoot: string;
  let server: Server;
  let sampleUrl: string;
  let module: BrowserModule | undefined;
  let launch: MockInstance<typeof fingerprintBrowser.launch>;
  let connect: MockInstance<typeof puppeteer.connect>;
  let planEnvironment: MockInstance<typeof browserLaunchPlanner.planEnvironment>;
  let planTask: MockInstance<typeof browserLaunchPlanner.planTask>;
  let recordStarted: MockInstance<typeof browserEnvironmentRuntime.recordAgentBrowserStarted>;
  const pids = new Set<number>();

  beforeAll(async () => {
    suiteRoot = await mkdtemp(join(tmpdir(), 'sample-browser-lazy-'));
    electron.getPath.mockReturnValue(suiteRoot);
    electron.getAppPath.mockReturnValue(suiteRoot);
    await pilotRuntimeHost.initialize();
    pilotRuntimeHost.setBrowserLaunchWindowSizeResolver(() => ({ width: 800, height: 600 }));
    browserEnvironmentRuntime.initialize();
    server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><title>Sample local page</title><main>Sample browser content</main>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    sampleUrl = `http://127.0.0.1:${address.port}/sample`;
  });

  beforeEach(async () => {
    stateRoot = await mkdtemp(join(suiteRoot, 'sample-state-'));
    setPilotRoot(stateRoot);
    await mkdir(join(stateRoot, 'browsers'), { recursive: true });
    browserEnvironmentRuntime.publishConfigSnapshot({ environments: [], groups: [] });
    browserEnvironmentRuntime.publishConfigSnapshot({
      environments: [{
        id: ENVIRONMENT_ID, name: 'Sample environment', status: 'idle', createdAt: 1,
        identityPolicy: {
          timezone: { mode: 'real' }, geolocation: { mode: 'off' },
          language: { mode: 'custom', value: 'en-US' },
        },
      }],
      groups: [],
    });
    // These spies observe calls while executing the original process/CDP implementations.
    launch = vi.spyOn(fingerprintBrowser, 'launch');
    connect = vi.spyOn(puppeteer, 'connect');
    planEnvironment = vi.spyOn(browserLaunchPlanner, 'planEnvironment');
    planTask = vi.spyOn(browserLaunchPlanner, 'planTask');
    recordStarted = vi.spyOn(browserEnvironmentRuntime, 'recordAgentBrowserStarted');
  });

  afterEach(async () => {
    try {
      const pid = fingerprintBrowser.getPid(PROFILE_ID);
      if (pid !== undefined) pids.add(pid);
      await module?.onDestroyBegin();
      await module?.onDestroy();
      await BrowserManager.closeAll();
    } finally {
      await fingerprintBrowser.stop(PROFILE_ID);
      module = undefined;
      occupancyRegistry.releaseAllOwnedBy(OWNER_ID);
      vi.restoreAllMocks();
    }
    expect(BrowserManager.ownedIds()).toEqual([]);
    expect(fingerprintBrowser.has(PROFILE_ID)).toBe(false);
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  }, 15_000);

  afterAll(async () => {
    await pilotRuntimeHost.stop();
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (suiteRoot) await rm(suiteRoot, { recursive: true, force: true });
  });

  async function startModule(boundEnvironment = true) {
    const emitStateChange = vi.fn();
    module = new BrowserModule();
    module.init({
      id: 'sample-worker', mainAgentId: OWNER_ID, spec: { name: 'browser-worker' },
      getBrowserControl: () => browserControlPort,
      getSkillCatalog: () => ({ loadSkillDocs: async () => '# Sample browser guide' }),
      getSkillDocs: () => '', setSkillDocs: vi.fn(), emitStateChange,
    } as unknown as AgentHost, {
      mainAgentId: OWNER_ID,
      binding: { browserId: BROWSER_ID, userDataId: PROFILE_ID },
      ...(boundEnvironment ? { browserEnvironmentId: ENVIRONMENT_ID } : {}),
      advancedSettings: { language: 'en-US', backgroundMode: true },
    });
    await module.onStart();
    const runtime = module.createGeneratedRuntime({
      browserId: BROWSER_ID, signal: new AbortController().signal, log: vi.fn(),
      notifyPageOpen: () => module!.notifyPageOpen(), allowedFileRoots: [stateRoot],
    });
    return { browserModule: module, runtime, emitStateChange };
  }

  function expectNotStarted() {
    expect(launch).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(planEnvironment).not.toHaveBeenCalled();
    expect(planTask).not.toHaveBeenCalled();
    expect(recordStarted).not.toHaveBeenCalled();
    expect(BrowserManager.ownedIds()).toEqual([]);
    expect(fingerprintBrowser.getPid(PROFILE_ID)).toBeUndefined();
    expect(browserControlPort.hasBrowser(BROWSER_ID)).toBe(false);
    expect(existsSync(join(stateRoot, 'user-data', PROFILE_ID, 'chrome-data'))).toBe(false);
    expect(browserEnvironmentRuntime.getEnvironment(ENVIRONMENT_ID)?.status).toBe('idle');
    console.info('Sample real browser checkpoint', { phase: 'unused', launches: 0, connections: 0 });
  }

  async function observeStarted() {
    const pid = fingerprintBrowser.getPid(PROFILE_ID)!;
    expect(pid).toBeGreaterThan(0);
    process.kill(pid, 0);
    pids.add(pid);
    expect(launch).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
    const handle = await launch.mock.results[0].value;
    expect(handle.config.headless).toBe(false);
    expect(handle.config.userDataDir).toBe(join(stateRoot, 'user-data', PROFILE_ID, 'chrome-data'));
    const window = await BrowserOperations.getWindowBounds(BROWSER_ID);
    expect(window.width).toBeGreaterThan(0);
    expect(window.height).toBeGreaterThan(0);
    const version = await BrowserManager.runExclusive(BROWSER_ID, ({ browser }) => browser.version());
    console.info('Sample real browser checkpoint', {
      phase: 'accessed', pid, version, headless: handle.config.headless,
      launches: launch.mock.calls.length, connections: connect.mock.calls.length, window,
    });
    return { pid, endpoint: handle.browserWSEndpoint };
  }

  async function destroyAndCheck(pid: number, endpoint: string) {
    await module!.onDestroyBegin();
    await module!.onDestroy();
    expect(BrowserManager.ownedIds()).toEqual([]);
    expect(fingerprintBrowser.has(PROFILE_ID)).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(existsSync(join(stateRoot, 'browsers', `${BROWSER_ID}.json`))).toBe(false);
    expect(browserEnvironmentRuntime.getEnvironment(ENVIRONMENT_ID)?.status).toBe('idle');
    const versionUrl = new URL('/json/version', endpoint.replace('ws:', 'http:')).href;
    await expect(fetch(versionUrl, { signal: AbortSignal.timeout(2_000) })).rejects.toThrow();
    console.info('Sample real browser checkpoint', { phase: 'destroyed', pid, processExited: true, cdpClosed: true });
  }

  it('creates SDK context and destroys an unused worker without starting or connecting', async () => {
    const { browserModule, runtime } = await startModule();
    expect(Object.keys(runtime)).toEqual(['page', 'listPages', 'selectPage']);
    await delay(150);
    expect(browserModule.getBrowserReady()).toBe(false);
    expectNotStarted();
    await browserModule.onDestroyBegin();
    await browserModule.onDestroy();
    expectNotStarted();
  });

  it.each(['builtin listPages', 'SDK currentPage'] as const)(
    'starts on the first %s read, reuses the process, and cleans it on destroy',
    async (firstRead) => {
      const { browserModule, runtime, emitStateChange } = await startModule();
      expectNotStarted();
      if (firstRead === 'builtin listPages') {
        expect(await browserModule.core.listPages({ browserId: BROWSER_ID })).toContain('## Pages');
      } else {
        expect(await runtime.page.currentPage()).toEqual({ url: expect.any(String), title: expect.any(String) });
      }
      const { pid, endpoint } = await observeStarted();
      expect(planEnvironment).toHaveBeenCalledOnce();
      expect(recordStarted).toHaveBeenCalledOnce();
      expect(browserEnvironmentRuntime.getEnvironment(ENVIRONMENT_ID)).toMatchObject({
        status: 'running', currentBrowserId: BROWSER_ID, userDataId: PROFILE_ID,
      });
      expect(browserModule.getBrowserReady()).toBe(false);
      expect(emitStateChange).not.toHaveBeenCalled();
      expect(await runtime.page.navigate(sampleUrl)).toEqual({ url: sampleUrl, title: 'Sample local page' });
      expect(await runtime.page.currentPage()).toEqual({ url: sampleUrl, title: 'Sample local page' });
      expect(await runtime.listPages()).toContainEqual({ pageIdx: 0, selected: true, url: sampleUrl, title: 'Sample local page' });
      expect(fingerprintBrowser.getPid(PROFILE_ID)).toBe(pid);
      expect(launch).toHaveBeenCalledOnce();
      expect(connect).toHaveBeenCalledOnce();
      expect(recordStarted).toHaveBeenCalledOnce();
      expect(browserModule.getBrowserReady()).toBe(true);
      expect(emitStateChange).toHaveBeenCalledOnce();
      await destroyAndCheck(pid, endpoint);
    }, 30_000,
  );

  it('plans an unbound task only when its first real SDK read executes', async () => {
    const { runtime } = await startModule(false);
    expectNotStarted();
    await runtime.page.currentPage();
    const { pid, endpoint } = await observeStarted();
    expect(planTask).toHaveBeenCalledOnce();
    expect(planEnvironment).not.toHaveBeenCalled();
    expect(recordStarted).not.toHaveBeenCalled();
    await destroyAndCheck(pid, endpoint);
  }, 30_000);

  it('shares one actual process and CDP connection across concurrent first reads', async () => {
    const { browserModule, runtime } = await startModule();
    expectNotStarted();
    const [builtinPages, currentPage, sdkPages] = await Promise.all([
      browserModule.core.listPages({ browserId: BROWSER_ID }),
      runtime.page.currentPage(), runtime.listPages(),
    ]);
    expect(builtinPages).toContain(currentPage.url);
    expect(sdkPages).toContainEqual(expect.objectContaining(currentPage));
    const { pid, endpoint } = await observeStarted();
    expect(planEnvironment).toHaveBeenCalledOnce();
    expect(recordStarted).toHaveBeenCalledOnce();
    await destroyAndCheck(pid, endpoint);
  }, 30_000);

  it('reuses an already managed real browser and preserves the worker close responsibility', async () => {
    await browserControlPort.launch(await browserLaunchPlanner.planTask({
      browserId: BROWSER_ID, userDataId: PROFILE_ID,
      identity: { language: 'en-US' }, fingerprint: {}, backgroundMode: true,
    }));
    const { pid, endpoint } = await observeStarted();
    launch.mockClear();
    connect.mockClear();
    planTask.mockClear();
    const { runtime } = await startModule();
    expect(launch).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(recordStarted).not.toHaveBeenCalled();
    await runtime.page.currentPage();
    await runtime.listPages();
    expect(fingerprintBrowser.getPid(PROFILE_ID)).toBe(pid);
    expect(launch).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(planEnvironment).not.toHaveBeenCalled();
    expect(planTask).not.toHaveBeenCalled();
    expect(recordStarted).toHaveBeenCalledOnce();
    await destroyAndCheck(pid, endpoint);
  }, 30_000);
});
