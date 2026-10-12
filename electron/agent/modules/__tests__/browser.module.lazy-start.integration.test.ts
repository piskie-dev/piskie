import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
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
import { ScreenStreamHub, type ViewerSink } from '../../../piskiepilot/browser/screen-hub.js';
import { screenPointerUiSource, screenPointerUiHtml } from '../../../piskiepilot/browser/core/browser/__tests__/screen-pointer-ui.fixture.js';
import type { StreamControlMessage } from '@shared/types/stream.js';

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
  const readinessClients = new Set<ServerResponse>();
  const streamClients = new Map<ServerResponse, ViewerSink>();
  let readyHub: ScreenStreamHub | undefined;
  let readyPortRequests = 0;

  beforeAll(async () => {
    suiteRoot = await mkdtemp(join(tmpdir(), 'sample-browser-lazy-'));
    electron.getPath.mockReturnValue(suiteRoot);
    electron.getAppPath.mockReturnValue(suiteRoot);
    await pilotRuntimeHost.initialize();
    pilotRuntimeHost.setBrowserLaunchWindowSizeResolver(() => ({ width: 800, height: 600 }));
    browserEnvironmentRuntime.initialize();
    const projectRoot = resolve(import.meta.dirname, '../../../..');
    const source = screenPointerUiSource
      .replace("import React, {useState}", "import React, {useState,useEffect}")
      .replace('function App(){', `function App(){
       const [ready,setReady]=useState(false);
       useEffect(()=>{const source=new EventSource('/sample-readiness');source.onmessage=e=>setReady(JSON.parse(e.data).ready);return()=>source.close()},[]);`)
      .replaceAll('browserReady={true}', 'browserReady={ready}')
      .replace('<main>', '<main>{ready && <>').replace('</main>', '</>}</main>');
    await build({ stdin: { contents: source, resolveDir: projectRoot, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic',
      outfile: join(suiteRoot, 'sample-ui.js'), alias: { '@': join(projectRoot, 'src'), '@shared': join(projectRoot, 'shared') }, logLevel: 'silent',
      plugins: [{ name: 'sample-worker-url', setup(builder) {
        builder.onResolve({ filter: /\\?worker$/ }, () => ({ path: 'sample-worker', namespace: 'sample-worker' }));
        builder.onLoad({ filter: /.*/, namespace: 'sample-worker' }, () => ({ contents: "export default class extends Worker { constructor(){super('/sample-worker.js',{type:'module'})} }", loader: 'js' }));
      } }] });
    await build({ entryPoints: [join(projectRoot, 'src/workers/screen-stream.worker.ts')], bundle: true, platform: 'browser', format: 'esm',
      outfile: join(suiteRoot, 'sample-worker.js'), alias: { '@': join(projectRoot, 'src'), '@shared': join(projectRoot, 'shared') }, logLevel: 'silent' });
    server = createServer(async (request, response) => {
      if (request.url === '/sample-readiness') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        readinessClients.add(response);
        response.write(`data: ${JSON.stringify({ ready: module?.getBrowserReady() ?? false })}\n\n`);
        response.on('close', () => readinessClients.delete(response));
      } else if (request.url === '/sample-stream') {
        readyPortRequests++;
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const sink: ViewerSink = { isOpen: () => !response.destroyed, send: (message) => response.write(`data: ${JSON.stringify(message.type === 'frame'
          ? { ...message, data: Buffer.from(message.data).toString('base64') } : message)}\n\n`) };
        streamClients.set(response, sink);
        response.on('close', () => { readyHub?.removeViewer(BROWSER_ID, sink); streamClients.delete(response); });
        await readyHub?.addViewer(BROWSER_ID, sink);
      } else if (request.url === '/sample-control') {
        let body = ''; for await (const chunk of request) body += chunk;
        const message = JSON.parse(body) as StreamControlMessage;
        const sink = [...streamClients.values()][0];
        if (sink && message.type === 'set-fps') await readyHub?.updateViewerFps(BROWSER_ID, sink, message.fps);
        if (sink && message.type === 'set-quality') await readyHub?.updateViewerQuality(BROWSER_ID, sink, message);
        response.end('Sample control');
      } else if (request.url === '/sample-ui') {
        response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(screenPointerUiHtml);
      } else if (['/sample-ui.js', '/sample-ui.css', '/sample-worker.js'].includes(request.url ?? '')) {
        response.writeHead(200, { 'Content-Type': request.url!.endsWith('.css') ? 'text/css' : 'application/javascript' });
        response.end(await readFile(join(suiteRoot, request.url!.slice(1))));
      } else {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end('<!doctype html><title>Sample local page</title><main>Sample browser content</main><input id="sample-input" aria-label="Sample input"><select id="sample-select" aria-label="Sample select"><option value="one">Sample one</option><option value="two">Sample two</option></select>');
      }
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
      for (const response of [...readinessClients, ...streamClients.keys()]) response.end();
      readinessClients.clear(); streamClients.clear(); readyHub?.close(); readyHub = undefined;
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
    const emitStateChange = vi.fn(() => {
      for (const response of readinessClients) response.write(`data: ${JSON.stringify({ ready: module?.getBrowserReady() ?? false })}\n\n`);
    });
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
      expect(browserModule.getBrowserReady()).toBe(true);
      expect(emitStateChange).toHaveBeenCalledOnce();
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

  it.each(['snapshot', 'currentPage', 'fill', 'select'] as const)(
    'opens the real UI only after first borrowed-page %s use, without a navigation or mouse seed', async (firstUse) => {
      await browserControlPort.launch(await browserLaunchPlanner.planTask({ browserId: BROWSER_ID, userDataId: PROFILE_ID,
        identity: { language: 'en-US' }, fingerprint: {}, backgroundMode: true }));
      const session = await BrowserManager.getScreenSession(BROWSER_ID);
      const page = session.getSelectedPage();
      await page.goto(sampleUrl);
      const pid = fingerprintBrowser.getPid(PROFILE_ID)!;
      const sourceEvents: import('../../../piskiepilot/browser/core/session/browser-automation-session.js').BrowserScreenEvent[] = [];
      const unsubscribe = session.subscribeScreen((event) => sourceEvents.push(event));
      launch.mockClear(); connect.mockClear();
      const { browserModule, runtime, emitStateChange } = await startModule();
      readyHub = new ScreenStreamHub(); readyPortRequests = 0;
      const viewer = await puppeteer.launch({ executablePath: process.env.FP_CHROMIUM_PATH, headless: true,
        userDataDir: join(stateRoot, 'sample-viewer-profile'), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
      const viewerPid = viewer.process()!.pid!;
      try {
        const display = (await viewer.pages())[0]!;
        await display.setViewport({ width: 1280, height: 820 });
        await display.goto(new URL('/sample-ui', sampleUrl).href);
        await delay(100);
        expect(browserModule.getBrowserReady()).toBe(false);
        expect(readyPortRequests).toBe(0);
        expect(await display.$$('canvas')).toHaveLength(0);
        expect(launch).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
        if (firstUse === 'snapshot') await browserModule.core.takeSnapshot({ browserId: BROWSER_ID });
        else if (firstUse === 'currentPage') await runtime.page.currentPage();
        else if (firstUse === 'fill') await runtime.page.fill({ css: '#sample-input' }, 'Sample borrowed input');
        else await runtime.page.select({ css: '#sample-select' }, 'two');
        expect(browserModule.getBrowserReady()).toBe(true);
        expect(emitStateChange).toHaveBeenCalledOnce();
        await display.waitForFunction(() => document.querySelectorAll('canvas[data-visible="true"]').length === 3
          && document.querySelectorAll('[data-screen-pointer]').length === 3);
        expect(readyPortRequests).toBe(1);
        expect(sourceEvents.filter((event) => event.type === 'pointer')).toEqual([]);
        expect(await page.url()).toBe(sampleUrl);
        expect(fingerprintBrowser.getPid(PROFILE_ID)).toBe(pid);
        expect(launch).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
        const frame = await display.evaluate(() => (window as unknown as { sampleState: { messages: unknown[] } }).sampleState.messages);
        if (firstUse === 'fill' || firstUse === 'select') await display.waitForSelector('[data-screen-pointer-target]');
        const targetBoxes = await display.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-screen-pointer-target]')].map((element) => ({
          style: element.getAttribute('style'), rect: element.getBoundingClientRect().toJSON(),
          layer: element.parentElement!.getBoundingClientRect().toJSON(),
          layerCss: { width: getComputedStyle(element.parentElement!).width, height: getComputedStyle(element.parentElement!).height },
        })));
        if (firstUse === 'fill' || firstUse === 'select') expect(targetBoxes.length).toBe(3);
        if (process.env.PISKIE_POINTER_EVIDENCE_DIR) {
          await display.screenshot({ path: join(process.env.PISKIE_POINTER_EVIDENCE_DIR, `borrowed-${firstUse}-ready.png`) });
          await writeFile(join(process.env.PISKIE_POINTER_EVIDENCE_DIR, `borrowed-${firstUse}-ready.json`), JSON.stringify({ firstUse,
            readyBefore: false, portsBefore: 0, readyAfter: browserModule.getBrowserReady(), readyPortRequests,
            stateNotifications: emitStateChange.mock.calls.length, source: session.getCurrentScreenPointer(), frame, targetBoxes,
            sourceMouseCount: 0, pageNavigatedForFirstUse: false,
            boundary: 'Real BrowserModule, browser control port, BrowserManager, managed kernel, SDK, Session, Hub, Caster, feed, Worker and overlay; AgentHost state and desktop MessagePort are bridged over local SSE.' }, null, 2));
        }
      } finally {
        unsubscribe(); await viewer.close();
        expect(() => process.kill(viewerPid, 0)).toThrow();
      }
    }, 30_000,
  );

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
