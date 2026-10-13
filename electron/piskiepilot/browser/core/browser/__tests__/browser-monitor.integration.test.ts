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
    scope(value: string): void; panel(value: boolean): void; panelWidth(value: number): void; resources(count: number): void;
    gate(value: boolean): void; interactive(value: boolean): void;
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
          response.end('<!doctype html><style>body{margin:0;background:#ddeaf5;font:20px sans-serif;animation:sample-paint 1s infinite alternate}@keyframes sample-paint{to{background:#cfdeec}}button{position:absolute;left:160px;top:160px;width:160px;height:80px}</style><button id="sample-click" onclick="window.sampleClicks=(window.sampleClicks||0)+1">Sample button</button>');
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
  async function panelGeometry() {
    return display.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('[data-browser-monitor]')!;
      const bounds = panel.getBoundingClientRect();
      const box = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
      };
      return {
        panel: box(panel), scrollHeight: panel.scrollHeight, height: panel.clientHeight, scrollWidth: panel.scrollWidth, width: panel.clientWidth,
        cards: [...panel.querySelectorAll<HTMLElement>('[data-monitor-task]')].map((card) => {
          const rect = card.getBoundingClientRect();
          const screen = card.querySelector('[data-screen-state]')!;
          const canvas = card.querySelector('canvas')!;
          return { key: card.dataset.monitorTask, card: box(card), screen: box(screen), canvas: box(canvas),
            footer: box(card.lastElementChild!), ratio: canvas.getBoundingClientRect().width / canvas.getBoundingClientRect().height,
            contained: rect.left >= bounds.left && rect.right <= bounds.right + 1 && rect.top >= bounds.top && rect.bottom <= bounds.bottom + 1 };
        }),
      };
    });
  }
  it('splits two monitors into one row and adapts single, multiple and resized panels to the available space', async () => {
    await display.evaluate(() => (window as unknown as SampleWindow).sampleUi.resources(2));
    await display.waitForFunction(() => document.querySelectorAll('[data-browser-monitor] canvas[data-visible="true"]').length === 2);
    const layouts = [];
    for (const size of [{ width: 1440, height: 1000, panel: 560 }, { width: 1440, height: 650, panel: 1100 },
      { width: 960, height: 400, panel: 280 }, { width: 1440, height: 400, panel: 800 }]) {
      await display.setViewport({ width: size.width, height: size.height });
      await display.evaluate((width) => (window as unknown as SampleWindow).sampleUi.panelWidth(width), size.panel);
      await display.waitForFunction(() => document.querySelector('[data-browser-monitor]')!.getBoundingClientRect().height > 0);
      const layout = await panelGeometry();
      expect(layout.cards).toHaveLength(2);
      const [a, b] = layout.cards;
      expect(a!.card.y).toBeCloseTo(b!.card.y, 1);
      expect(a!.card.right).toBeLessThan(b!.card.x);
      expect(a!.card.width).toBeCloseTo(b!.card.width, 1);
      expect(layout.scrollHeight).toBeLessThanOrEqual(layout.height + 1);
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1);
      for (const item of layout.cards) {
        expect(item.contained).toBe(true);
        expect(item.screen.height).toBeGreaterThan(0);
        expect(item.canvas.right).toBeLessThanOrEqual(item.screen.right + 1);
        expect(item.canvas.bottom).toBeLessThanOrEqual(item.screen.bottom + 1);
        expect(item.footer.bottom).toBeLessThanOrEqual(item.card.bottom + 1);
        expect(item.ratio).toBeCloseTo(1.6, 2);
      }
      layouts.push({ size, ...layout });
      if (process.env.PISKIE_TEST_ARTIFACT_DIR && size.panel === 560) {
        await display.screenshot({ path: join(process.env.PISKIE_TEST_ARTIFACT_DIR, 'monitor-two-column.png') });
      }
    }
    evidence.panelLayouts = layouts;
    await sources[0]!.setViewport({ width: 800, height: 2000 });
    await sources[1]!.setViewport({ width: 1800, height: 600 });
    await display.waitForFunction(() => {
      const canvases = [...document.querySelectorAll<HTMLCanvasElement>('[data-browser-monitor] canvas')];
      return Math.abs(canvases[0]!.getBoundingClientRect().width / canvases[0]!.getBoundingClientRect().height - 0.4) < 0.01
        && Math.abs(canvases[1]!.getBoundingClientRect().width / canvases[1]!.getBoundingClientRect().height - 3) < 0.01;
    });
    const changedRatios = await panelGeometry();
    expect(changedRatios.cards[0]!.card.y).toBeCloseTo(changedRatios.cards[1]!.card.y, 1);
    expect(changedRatios.cards.every((item) => item.contained && item.canvas.bottom <= item.screen.bottom + 1)).toBe(true);
    expect(changedRatios.scrollHeight).toBeLessThanOrEqual(changedRatios.height + 1);
    if (process.env.PISKIE_TEST_ARTIFACT_DIR) {
      await display.screenshot({ path: join(process.env.PISKIE_TEST_ARTIFACT_DIR, 'monitor-resized-ratios.png') });
    }
    await display.evaluate(() => (window as unknown as SampleWindow).sampleUi.resources(1));
    await display.waitForFunction(() => document.querySelectorAll('[data-monitor-task]').length === 1);
    const single = await panelGeometry();
    expect(single.cards[0]!.contained).toBe(true);
    expect(single.cards[0]!.card.width).toBeGreaterThan(changedRatios.cards[0]!.card.width * 1.9);
    expect(single.cards[0]!.screen.height).toBeGreaterThan(0);
    expect(single.scrollHeight).toBeLessThanOrEqual(single.height + 1);
    await display.evaluate(() => (window as unknown as SampleWindow).sampleUi.resources(6));
    await display.waitForFunction(() => document.querySelectorAll('[data-monitor-task]').length === 6);
    const multiple = await panelGeometry();
    expect(multiple.cards[0]!.card.y).toBeCloseTo(multiple.cards[1]!.card.y, 1);
    expect(multiple.cards[2]!.card.y).toBeGreaterThan(multiple.cards[0]!.card.bottom);
    expect(multiple.scrollHeight).toBeGreaterThan(multiple.height);
    await display.$eval('[data-browser-monitor]', (panel) => { panel.scrollTop = panel.scrollHeight; });
    const scrolled = await panelGeometry();
    expect(scrolled.cards.slice(-2).every((item) => item.contained)).toBe(true);
    expect(scrolled.cards.every((item) => item.screen.height > 0 && item.footer.bottom <= item.card.bottom + 1)).toBe(true);
    evidence.panelLayouts = layouts;
    evidence.changedFrameRatios = changedRatios;
    evidence.singlePanel = single;
    evidence.multiplePanel = scrolled;
    await Promise.all(sources.map((source) => source.setViewport({ width: 1280, height: 800 })));
    await display.setViewport({ width: 1440, height: 1000 });
    await display.evaluate(() => {
      (window as unknown as SampleWindow).sampleUi.resources(3);
      (window as unknown as SampleWindow).sampleUi.panelWidth(560);
    });
    await display.$eval('[data-browser-monitor]', (panel) => { panel.scrollTop = 0; });
    await display.waitForFunction(() => [...document.querySelectorAll<HTMLCanvasElement>('[data-browser-monitor] canvas[data-visible="true"]')]
      .every((canvas) => Math.abs(canvas.getBoundingClientRect().width / canvas.getBoundingClientRect().height - 1.6) < 0.01));
  }, 30_000);
  it('shares screen feeds, contains multiple windows, restores geometry, removes released resources and forwards existing interactive input', async () => {
    await Promise.all(sources.map((source) => source.setViewport({ width: 1280, height: 800 })));
    await display.setViewport({ width: 1440, height: 1000 });
    await display.evaluate(() => {
      (window as unknown as SampleWindow).sampleUi.resources(3);
      (window as unknown as SampleWindow).sampleUi.panelWidth(560);
    });
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
    await BrowserManager.close('sample-browser-a');
    await display.evaluate(() => (window as unknown as SampleWindow).sampleUi.closeResource('sample-worker-a'));
    await display.waitForFunction(() => (window as unknown as SampleWindow).sampleUi.snapshot().feeds === 1);
    expect(await display.$(cardA)).toBeNull();
    expect(await display.$(winA)).toBeNull();
    expect(await display.$(`${cardB} canvas[data-visible="true"]`)).not.toBeNull();
    expect(await display.$(winB)).not.toBeNull();
    await display.click('[data-monitor-task="sample-worker-c|sample-browser-c"] button');
    await display.evaluate(() => (window as unknown as SampleWindow).sampleUi.closeResource('sample-worker-c'));
    await display.waitForFunction(() => !document.querySelector('[data-monitor-window="sample-worker-c|sample-browser-c"]'));
    expect(await display.$('[data-monitor-task="sample-worker-c|sample-browser-c"]')).toBeNull();
    const remainingPanel = await panelGeometry();
    expect(remainingPanel.cards).toHaveLength(1);
    expect(remainingPanel.cards[0]!.contained).toBe(true);
    if (process.env.PISKIE_TEST_ARTIFACT_DIR) await display.screenshot({ path: join(process.env.PISKIE_TEST_ARTIFACT_DIR, 'monitor-after-close.png') });
    evidence.remainingPanel = remainingPanel;
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

    await display.evaluate(() => (window as unknown as SampleWindow).sampleUi.scope('sample-other-main'));
    await display.waitForFunction(() => (window as unknown as SampleWindow).sampleUi.snapshot().feeds === 0);
    expect(await display.$('[data-monitor-parking]')).toBeNull();
    await BrowserManager.close('sample-browser-b');
    await display.evaluate(() => (window as unknown as SampleWindow).sampleUi.closeResource('sample-worker-b'));
    await display.evaluate(() => (window as unknown as SampleWindow).sampleUi.scope('sample-main'));
    await display.waitForFunction(() => {
      const state = (window as unknown as SampleWindow).sampleUi.snapshot();
      return state.tasks.length === 0 && state.windows.length === 0;
    });
    expect(await display.$('canvas[data-visible="true"]')).toBeNull();
    expect(await display.$(`${cardA}:not([hidden])`)).toBeNull();
    expect(await display.$(`${cardB}:not([hidden])`)).toBeNull();
    expect(await display.evaluate(() => (window as unknown as SampleWindow).sampleUi.snapshot().feeds)).toBe(0);
    expect(await display.$('[data-monitor-window]')).toBeNull();
    expect(await display.$('[data-monitor-parking]')).toBeNull();
    expect(await display.$('[data-monitor-task]')).toBeNull();
    expect(await display.evaluate(() => (window as unknown as SampleWindow).sampleState.errors)).toEqual([]);
    evidence.departedFramesDiscarded = true;
    evidence.resourceClosedWhileAway = true;
    evidence.closedParkedWindowRemoved = true;
    evidence.afterScopeReturn = await display.evaluate(() => (window as unknown as SampleWindow).sampleUi.snapshot());
  }, 45_000);
});
