import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BrowserManager } from '@electron/piskiepilot/browser/core/browser/browser-manager.js';
import { ScreenStreamHub, type ViewerSink } from '@electron/piskiepilot/browser/screen-hub.js';
import type { StreamControlMessage } from '@shared/types/stream';
import { browserMonitorUiHtml, browserMonitorUiSource } from './browser-monitor-ui.fixture';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getAppPath: () => '/tmp' } }));
vi.mock('@electron/piskiepilot/browser/core/browser/window-controller.js', () => ({ WindowController: { initialize: async () => {} } }));
const browserIds = ['sample-browser-a', 'sample-browser-b'];
const winA = '[data-monitor-window="sample-worker-a|sample-browser-a"]';
const winB = '[data-monitor-window="sample-worker-b|sample-browser-b"]';
const cardA = '[data-monitor-task="sample-worker-a|sample-browser-a"]';
const cardB = '[data-monitor-task="sample-worker-b|sample-browser-b"]';
interface SampleWindow extends Window {
  sampleState: { ports: Record<string, number>; errors: string[]; inputs: unknown[]; manualClicked?: boolean };
  sampleUi: {
    scope(value: string): void; panel(value: boolean): void; gate(value: boolean): void; interactive(value: boolean): void;
    closeResource(id: string): void; taskState(id: string, type: string | null): void;
    snapshot(): {
      windows: Array<{ key: string; rect: { x: number; y: number; width: number; height: number }; minimized: boolean }>;
      tasks: Array<{ key: string; closed: boolean; hasFrame: boolean }>;
      feeds: number;
    };
    close(): Promise<void>;
  };
}

// This is Chromium/OffscreenCanvas/CDP coverage, with only desktop IPC and VM activity delivery substituted.
describe.skipIf(!process.env.FP_CHROMIUM_PATH)('real Chromium browser monitors', () => {
  let root: string;
  let server: Server;
  let baseUrl: string;
  let hub: ScreenStreamHub;
  let displayBrowser: Browser;
  let display: Page;
  const sourceBrowsers: Browser[] = [];
  const sources: Page[] = [];
  const clients = new Map<ServerResponse, { id: string; sink: ViewerSink }>();
  const evidence: Record<string, unknown> = {};
  beforeAll(async () => {
    root = await mkdtemp(join(process.env.PISKIE_TEST_ARTIFACT_DIR ?? tmpdir(), 'sample-monitor-'));
    const projectRoot = resolve(import.meta.dirname, '../../../../../..');
    const alias = { '@': join(projectRoot, 'src'), '@shared': join(projectRoot, 'shared') };
    await build({ stdin: { contents: browserMonitorUiSource, resolveDir: projectRoot, loader: 'tsx' },
      bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', outfile: join(root, 'sample-ui.js'), alias, logLevel: 'silent',
      plugins: [{ name: 'sample-desktop-boundary', setup(builder) {
        builder.onResolve({ filter: /useWorkerActivity$/ }, () => ({ path: 'sample-activity', namespace: 'sample' }));
        builder.onResolve({ filter: /\?worker$/ }, () => ({ path: 'sample-worker', namespace: 'sample' }));
        builder.onLoad({ filter: /.*/, namespace: 'sample' }, (args) => ({ loader: 'js', contents: args.path === 'sample-activity'
          ? 'export function useWorkerActivity(main,id){return window.sampleActivities[id]||{text:"Executing",unfinished:true}}'
          : 'export default class extends Worker {constructor(){super("/sample-worker.js",{type:"module"})}}' }));
      } }] });
    await build({ entryPoints: [join(projectRoot, 'src/workers/screen-stream.worker.ts')], bundle: true,
      platform: 'browser', format: 'esm', outfile: join(root, 'sample-worker.js'), alias, logLevel: 'silent' });
    hub = new ScreenStreamHub();
    server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url!, 'http://example.test');
        const id = url.searchParams.get('id') ?? '';
        if (url.pathname === '/sample-stream') {
          response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          response.write(': sample stream\n\n');
          const sink: ViewerSink = { isOpen: () => !response.destroyed, send: (message) => response.write(`data: ${JSON.stringify(message.type === 'frame'
            ? { ...message, data: Buffer.from(message.data).toString('base64') } : message)}\n\n`) };
          clients.set(response, { id, sink });
          response.on('close', () => { hub.removeViewer(id, sink); clients.delete(response); });
          await hub.addViewer(id, sink, { fps: 4, maxWidth: 640, maxHeight: 400 });
        } else if (url.pathname === '/sample-control') {
          let body = '';
          for await (const chunk of request) body += chunk;
          const message = JSON.parse(body) as StreamControlMessage;
          const sink = [...clients.values()].find((item) => item.id === id)?.sink;
          if (sink && message.type === 'set-fps') await hub.updateViewerFps(id, sink, message.fps);
          if (sink && message.type === 'set-quality') await hub.updateViewerQuality(id, sink, message);
          if (message.type === 'input') await hub.dispatchInput(id, message.event);
          response.end('sample');
        } else if (['/sample-ui.js', '/sample-ui.css', '/sample-worker.js'].includes(url.pathname)) {
          response.writeHead(200, { 'Content-Type': url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript' });
          response.end(await readFile(join(root, url.pathname.slice(1))));
        } else if (url.pathname === '/sample-ui') {
          response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(browserMonitorUiHtml);
        } else {
          response.writeHead(200, { 'Content-Type': 'text/html' });
          response.end('<!doctype html><style>body{margin:0;background:#ddeaf5;font:20px sans-serif}button{position:absolute;left:160px;top:160px;width:160px;height:80px}</style><button id="sample-click" onclick="window.sampleClicks=(window.sampleClicks||0)+1">Sample button</button>');
        }
      } catch (error) { response.destroy(error as Error); }
    });
    await new Promise<void>((yes) => server.listen(0, '127.0.0.1', yes));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    for (const id of browserIds) sourceBrowsers.push(await puppeteer.launch({ executablePath: process.env.FP_CHROMIUM_PATH,
      headless: true, userDataDir: join(root, id), defaultViewport: { width: 1280, height: 800 }, args: ['--no-sandbox', '--disable-dev-shm-usage'] }));
    const manager = BrowserManager as unknown as { initialized: boolean; readPersistedBrowserConfig(id: string): Promise<unknown>; savePersisted(): Promise<void>; deletePersisted(): Promise<void> };
    manager.initialized = true;
    vi.spyOn(manager, 'readPersistedBrowserConfig').mockImplementation(async (id) => ({ wsEndpoint: sourceBrowsers[browserIds.indexOf(id)]!.wsEndpoint() }));
    vi.spyOn(manager, 'savePersisted').mockResolvedValue(undefined);
    vi.spyOn(manager, 'deletePersisted').mockResolvedValue(undefined);
    for (const id of browserIds) {
      await BrowserManager.getOrCreate(id);
      const source = (await BrowserManager.getScreenSession(id)).getSelectedPage();
      await source.setViewport({ width: 1280, height: 800 });
      await source.goto(`${baseUrl}/sample-source`);
      sources.push(source);
    }
    displayBrowser = await puppeteer.launch({ executablePath: process.env.FP_CHROMIUM_PATH, headless: true,
      userDataDir: join(root, 'sample-display'), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    display = await displayBrowser.newPage();
    display.setDefaultTimeout(8_000);
    await display.setViewport({ width: 1440, height: 1000 });
    await display.goto(`${baseUrl}/sample-ui`);
  }, 30_000);
  afterAll(async () => {
    try {
      if (display && !display.isClosed()) {
        evidence.finalRenderer = await display.evaluate(() => ({
          state: (window as unknown as SampleWindow).sampleState,
          monitor: (window as unknown as SampleWindow).sampleUi?.snapshot(),
          canvases: [...document.querySelectorAll('canvas')].map((canvas) => ({ visible: canvas.dataset.visible, width: canvas.width, height: canvas.height })),
          messages: document.body.textContent,
        }));
      }
      for (const response of clients.keys()) response.end();
      clients.clear();
      hub?.close();
      await BrowserManager.closeAll();
      await Promise.all([...sourceBrowsers, displayBrowser].filter(Boolean).map((browser) => browser.close()));
      if (process.env.PISKIE_TEST_ARTIFACT_DIR) await writeFile(join(process.env.PISKIE_TEST_ARTIFACT_DIR, 'monitor-evidence.json'), JSON.stringify(evidence, null, 2));
    } finally {
      server?.closeAllConnections();
      if (server) await new Promise<void>((yes) => server.close(() => yes()));
      if (root) await rm(root, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  }, 15_000);

  async function geometry() {
    return display.evaluate(() => {
      const reading = document.querySelector('[data-reading]')!.getBoundingClientRect();
      const input = document.querySelector('[data-input]')!.getBoundingClientRect();
      return [...document.querySelectorAll<HTMLElement>('[data-monitor-window]:not([hidden])')].map((element) => {
        const rect = element.getBoundingClientRect();
        const canvas = element.querySelector('canvas')!.getBoundingClientRect();
        return { key: element.dataset.monitorWindow, x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          contained: rect.x >= reading.x - 1 && rect.y >= reading.y - 1 && rect.right <= reading.right + 1 && rect.bottom <= reading.bottom + 1 && rect.bottom <= input.top,
          ratio: canvas.width / canvas.height };
      });
    });
  }
  async function drag(selector: string, dx: number, dy: number) {
    const box = (await display.$(selector)) && await (await display.$(selector))!.boundingBox();
    expect(box).not.toBeNull();
    const x = box!.x + Math.min(20, box!.width / 2);
    const y = box!.y + Math.min(12, box!.height / 2);
    await display.mouse.move(x, y);
    await display.mouse.down();
    await display.mouse.move(x + dx, y + dy, { steps: 8 });
    await display.mouse.up();
  }
  it('shares screen feeds, contains multiple windows, restores geometry, freezes released resources and forwards existing interactive input', async () => {
    await display.waitForFunction(() => document.querySelectorAll('[data-browser-monitor] canvas[data-visible="true"]').length === 2);
    expect(await display.$eval('[data-monitor-task="sample-worker-c|sample-browser-c"]', (element) => element.textContent)).toContain('Waiting for the browser');
    const line = await display.$eval('[data-worker-line]', (element) => {
      const row = element.querySelector('button')!;
      const action = element.querySelector<HTMLElement>('[class*="workerCreationAction"]')!;
      const title = element.querySelector<HTMLElement>('[class*="workerCreationTaskTitle"]')!;
      return { height: row.getBoundingClientRect().height, actionWidth: action.clientWidth, text: action.textContent,
        titleElided: title.scrollWidth > title.clientWidth, whitespace: getComputedStyle(action).whiteSpace };
    });
    expect(line).toMatchObject({ height: 24, titleElided: true, whitespace: 'nowrap' });
    expect(line.actionWidth).toBeGreaterThan(80);
    expect(line.text).toContain('Executing');
    evidence.workerLine = line;
    await display.click(`${cardA} button`);
    await display.click(`${cardB} button`);
    await display.waitForFunction(() => document.querySelectorAll('[data-monitor-window] canvas[data-visible="true"]').length === 2);
    expect(await display.evaluate(() => (window as unknown as SampleWindow).sampleState.ports)).toEqual({ 'sample-browser-a': 1, 'sample-browser-b': 1 });
    await display.click(`${cardA} button`);
    await drag(`${winA} [aria-label="Resize preview"]`, -200, 120);
    const defaultScroll = await display.$eval(`${winA} [data-fit="fill"]`, (element) => {
      const viewport = element as HTMLElement;
      const canvas = viewport.querySelector('canvas')!.getBoundingClientRect();
      viewport.scrollLeft = 120;
      return { scrollWidth: viewport.scrollWidth, visibleWidth: viewport.clientWidth, scrollLeft: viewport.scrollLeft,
        overflow: getComputedStyle(viewport).overflow, ratio: canvas.width / canvas.height };
    });
    expect(defaultScroll.scrollWidth).toBeGreaterThan(defaultScroll.visibleWidth);
    expect(defaultScroll.scrollLeft).toBeGreaterThan(0);
    expect(defaultScroll.overflow).toBe('auto');
    expect(defaultScroll.ratio).toBeCloseTo(1.6, 2);
    expect(await sources[0]!.evaluate(() => [innerWidth, innerHeight])).toEqual([1280, 800]);
    evidence.defaultScrolling = defaultScroll;
    await display.click(`${winA} [aria-label="Full view"]`);
    await display.click(`${cardB} button`);
    await display.click(`${winB} [aria-label="Full view"]`);
    expect((await geometry()).every((item) => item.contained && Math.abs(item.ratio - 1.6) < 0.01)).toBe(true);
    await drag(`${winA} header`, -2000, 2000);
    await drag(`${winA} [aria-label="Resize preview"]`, 2000, 2000);
    await display.evaluate(() => (window as unknown as SampleWindow).sampleUi.gate(true));
    await display.waitForFunction(() => document.querySelector('[data-input]')!.getBoundingClientRect().height === 220);
    expect((await geometry()).every((item) => item.contained)).toBe(true);
    await display.click(`${cardB} button`);
    await drag(`${winB} [aria-label="Resize preview"]`, -200, 120);
    await display.click(`${winB} [aria-label="Detail view"]`);
    const scrollingWidth = await display.$eval(`${winB} [data-fit="fill"]`, (element) => ({ total: element.scrollWidth, visible: element.clientWidth }));
    expect(scrollingWidth.total).toBeGreaterThan(scrollingWidth.visible);
    await display.$eval(`${winB} [data-fit="fill"]`, (element) => { element.scrollLeft = 200; });
    expect(await display.$eval(`${winB} [data-fit="fill"]`, (element) => element.scrollLeft)).toBeGreaterThan(0);
    await display.click(`${winB} [aria-label="Full view"]`);
    const saved = (await geometry()).find((item) => item.key?.includes('worker-b'))!;
    await display.click(`${winB} [aria-label="Minimize"]`);
    await display.waitForSelector('[data-monitor-parking]');
    expect(await display.$eval('[data-monitor-parking]', (element) => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(await display.$eval('[data-input]', (element) => element.getBoundingClientRect().top));
    await display.click('[aria-label="Restore Sample task B"]');
    expect((await geometry()).find((item) => item.key?.includes('worker-b'))).toMatchObject(saved);
    await display.evaluate(() => (window as unknown as SampleWindow).sampleUi.panel(false));
    await display.waitForSelector('aside[data-collapsed="true"]');
    await display.click(`${winB} [aria-label="Return to monitor"]`);
    await display.waitForFunction(() => !document.querySelector('aside[data-collapsed="true"]'));
    expect(await display.$(winB)).toBeNull();
    expect(await display.$(`${cardB} canvas[data-visible="true"]`)).not.toBeNull();
    await display.click(`${cardB} button`);
    await display.click('[data-manual]');
    expect(await display.evaluate(() => (window as unknown as SampleWindow).sampleState.manualClicked)).toBe(true);
    await display.evaluate(() => (window as unknown as SampleWindow).sampleUi.scope('sample-other-main'));
    await display.waitForFunction(() => !document.querySelector('[data-monitor-window]'));
    await display.evaluate(() => (window as unknown as SampleWindow).sampleUi.scope('sample-main'));
    await display.waitForFunction(() => document.querySelectorAll('[data-monitor-window] canvas[data-visible="true"]').length === 2);
    await display.evaluate(() => (window as unknown as SampleWindow).sampleUi.scope('sample-other-main'));
    await display.waitForFunction(() => (window as unknown as SampleWindow).sampleUi.snapshot().feeds === 0);
    await display.evaluate(() => (window as unknown as SampleWindow).sampleUi.scope('sample-main'));
    await display.waitForFunction(() => document.querySelectorAll('[data-monitor-window] canvas[data-visible="true"]').length === 2);
    await display.click(`${winB} [aria-label="View Full Screen"]`);
    await display.waitForSelector('dialog[open] canvas[data-visible="true"]');
    expect(await display.$eval('dialog', (dialog) => document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest('dialog') === dialog)).toBe(true);
    await display.keyboard.press('Escape');
    await display.waitForFunction(() => !document.querySelector('dialog[open]'));
    await display.evaluate(() => (window as unknown as SampleWindow).sampleUi.interactive(true));
    await display.waitForSelector('[data-interactive-test] canvas[data-visible="true"]');
    const inputBox = await (await display.$('[data-interactive-test] [role="application"]'))!.boundingBox();
    await display.mouse.click(inputBox!.x + inputBox!.width * 240 / 1280, inputBox!.y + inputBox!.height * 200 / 800);
    await sources[0]!.waitForFunction(() => (window as Window & { sampleClicks?: number }).sampleClicks === 1);
    expect(await display.evaluate(() => (window as unknown as SampleWindow).sampleState.inputs.length)).toBeGreaterThan(1);
    await display.evaluate(() => (window as unknown as SampleWindow).sampleUi.interactive(false));
    expect(await sources[0]!.evaluate(() => [innerWidth, innerHeight])).toEqual([1280, 800]);
    expect(await sources[1]!.evaluate(() => [innerWidth, innerHeight])).toEqual([1280, 800]);
    await display.evaluate(() => (window as unknown as SampleWindow).sampleUi.taskState('sample-worker-a', 'completed'));
    expect(await display.$eval(cardA, (element) => element.textContent)).toContain('Completed');
    await display.evaluate(() => (window as unknown as SampleWindow).sampleUi.taskState('sample-worker-a', null));
    expect(await display.$eval(cardA, (element) => element.textContent)).toContain('Executing');
    evidence.geometry = await geometry();
    if (process.env.PISKIE_TEST_ARTIFACT_DIR) await display.screenshot({ path: join(process.env.PISKIE_TEST_ARTIFACT_DIR, 'monitor-windows.png') });
    const picture = await (await display.$(`${cardA} canvas`))!.boundingBox();
    const pixelClip = { x: picture!.x + 10, y: picture!.y + 10, width: 8, height: 8 };
    const beforeClosure = await display.screenshot({ clip: pixelClip });
    await BrowserManager.close('sample-browser-a');
    await display.evaluate(() => (window as unknown as SampleWindow).sampleUi.closeResource('sample-worker-a'));
    await display.waitForFunction(() => (window as unknown as SampleWindow).sampleUi.snapshot().feeds === 1);
    expect(await display.$eval(`${cardA} canvas`, (canvas) => canvas.getAttribute('data-visible'))).toBe('true');
    expect(await display.$eval(winA, (element) => element.textContent)).toContain('Frozen last frame');
    expect(Buffer.from(await display.screenshot({ clip: pixelClip }))).toEqual(Buffer.from(beforeClosure));
    await display.click('[data-monitor-task="sample-worker-c|sample-browser-c"] button');
    await display.evaluate(() => (window as unknown as SampleWindow).sampleUi.closeResource('sample-worker-c'));
    await display.waitForFunction(() => document.querySelector('[data-monitor-window="sample-worker-c|sample-browser-c"]')?.textContent?.includes('No captured frame'));
    expect(await display.evaluate(() => (window as unknown as SampleWindow).sampleState.errors)).toEqual([]);
    evidence.ports = await display.evaluate(() => (window as unknown as SampleWindow).sampleState.ports);
    evidence.sourceViewport = [1280, 800];
    evidence.closedFeedReleased = true;
    evidence.remoteInputReachedSource = true;
    await display.click(`${cardB} button`);
    await display.waitForFunction(() => {
      const preview = document.querySelector('[data-monitor-window="sample-worker-b|sample-browser-b"]');
      return preview && Number(getComputedStyle(preview).zIndex) === document.querySelectorAll('[data-monitor-window]').length;
    });
    await display.click(`${winB} [aria-label="Minimize"]`);
    await display.waitForFunction(() => (window as unknown as SampleWindow).sampleUi.snapshot().windows.find((item) => item.key === 'sample-worker-b|sample-browser-b')?.minimized === true);
    await display.waitForSelector('[aria-label="Restore Sample task B"]');
    const savedWindow = await display.evaluate(() => (window as unknown as SampleWindow).sampleUi.snapshot().windows.find((item) => item.key === 'sample-worker-b|sample-browser-b'));
    await display.evaluate(() => (window as unknown as SampleWindow).sampleUi.scope('sample-other-main'));
    await display.waitForFunction(() => (window as unknown as SampleWindow).sampleUi.snapshot().feeds === 0);
    expect(await display.$('[data-monitor-parking]')).toBeNull();
    await BrowserManager.close('sample-browser-b');
    await display.evaluate(() => (window as unknown as SampleWindow).sampleUi.closeResource('sample-worker-b'));
    await display.evaluate(() => (window as unknown as SampleWindow).sampleUi.scope('sample-main'));
    await display.waitForFunction(() => {
      const state = (window as unknown as SampleWindow).sampleUi.snapshot();
      return state.tasks.length === 3 && state.tasks.every((task) => task.closed && !task.hasFrame);
    });
    expect(await display.$('canvas[data-visible="true"]')).toBeNull();
    expect(await display.$(`${cardA}:not([hidden])`)).toBeNull();
    expect(await display.$(`${cardB}:not([hidden])`)).toBeNull();
    expect(await display.evaluate(() => (window as unknown as SampleWindow).sampleUi.snapshot().feeds)).toBe(0);
    expect(await display.evaluate(() => (window as unknown as SampleWindow).sampleUi.snapshot().windows.find((item) => item.key === 'sample-worker-b|sample-browser-b'))).toEqual(savedWindow);
    expect(await display.evaluate(() => (window as unknown as SampleWindow).sampleState.errors)).toEqual([]);
    evidence.departedFramesDiscarded = true;
    evidence.resourceClosedWhileAway = true;
    evidence.parkedGeometryPreservedAcrossScope = true;
    evidence.savedParkedWindow = savedWindow;
    evidence.afterScopeReturn = await display.evaluate(() => (window as unknown as SampleWindow).sampleUi.snapshot());
  }, 45_000);
});
