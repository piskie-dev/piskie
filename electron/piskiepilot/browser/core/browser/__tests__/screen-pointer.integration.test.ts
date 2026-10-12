import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserManager } from '../browser-manager.js';
import { ScreenCaster, type ScreencastFrame } from '../screen-caster.js';
import type { BrowserAutomationSession, BrowserScreenEvent } from '../../session/browser-automation-session.js';
import { ScreenStreamHub, type ViewerSink } from '../../../screen-hub.js';
import { createGeneratedBrowserSkillRuntime } from '../../../runtime/generated-skill-browser.js';
import * as builtin from '../../../skills/browser/index.js';
import { sameScreenPage, type StreamServerMessage, type StreamControlMessage } from '@shared/types/stream.js';
import { operationPointerHtml, operationPointerFrameHtml } from './operation-pointer.fixture.js';
import { screenPointerUiHtml, screenPointerUiSource } from './screen-pointer-ui.fixture.js';
import type { ScreenWorkerOutgoingMessage } from '../../../../../../src/domains/screen-feed/worker-protocol.js';
import { SCREEN_POINTER_POLICY, type PresentedScreenPointer } from '@shared/screen-pointer.js';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getAppPath: () => '/tmp' } }));
// Window placement is unrelated to observation. The connection, registry, mouse and CDP are real.
vi.mock('../window-controller.js', () => ({ WindowController: { initialize: async () => {} } }));

const BROWSER_ID = 'sample-browser';
const RECORD_EVENTS = `<script>
window.sampleEvents=[];
for(const type of ['pointermove','pointerdown','pointerup','mousemove','mousedown','mouseup','click','dblclick'])
 document.addEventListener(type,e=>sampleEvents.push({type,x:e.clientX,y:e.clientY,buttons:e.buttons,detail:e.detail,id:e.target.id}));
</script>`;
const HTML = `<!doctype html><title>Example controls</title><style>
body{margin:0;height:1900px;background:#eef5fa;font:16px sans-serif;color:#14212b}button,a{position:absolute;box-sizing:border-box;padding:0;border:0;background:#398cbb;color:white;user-select:none}
#sample-click{left:180px;top:100px;width:120px;height:60px}#sample-double{left:420px;top:180px;width:100px;height:60px}
#sample-source{left:90px;top:330px;width:120px;height:70px}#sample-target{left:440px;top:340px;width:120px;height:70px}
#sample-offscreen{left:240px;top:1500px;width:160px;height:80px}#sample-tab{left:610px;top:100px;width:140px;height:50px}
#sample-nav{left:420px;top:100px;width:140px;height:50px}
iframe{position:absolute;left:330px;top:430px;width:260px;height:130px;border:3px solid #52677a}
</style><button id="sample-click">Sample click</button><button id="sample-double">Sample double</button>
<button id="sample-source">Sample source</button><button id="sample-target">Sample target</button>
<a id="sample-nav" href="/sample-navigation">Sample navigation</a>
<button id="sample-offscreen">Sample offscreen</button><a id="sample-tab" href="/sample-next" target="_blank">Sample new tab</a>
<iframe src="/sample-frame" title="Example frame"></iframe>${RECORD_EVENTS}`;
interface ReceivedMouse { type: string; x: number; y: number; buttons: number; detail: number; id: string }
interface SamplePaintRow {
  at: number;
  raf?: number;
  frameMeta?: import('../../../../../../src/domains/screen-feed/worker-protocol.js').ScreenViewportFrame | null;
  origin?: string | null;
  actor?: string | null;
  desired?: { x: number; y: number } | null;
  gradient?: string | null;
  arrowOpacity: number;
  rippleOpacity: number;
  x: number | null;
  y: number | null;
  arrowNode: number | null;
  pointer: PresentedScreenPointer | null;
  frame: import('@shared/types/stream.js').ScreenPageIdentity | null;
}
interface SampleUiWindow extends Window {
  samplePaintRows: SamplePaintRow[];
  sampleFramePage: SamplePaintRow['frame'];
  sampleCurrentFrame: import('../../../../../../src/domains/screen-feed/worker-protocol.js').ScreenViewportFrame | null;
  samplePresentedPointer: PresentedScreenPointer | null;
  sampleEvents: ReceivedMouse[];
  sampleState: { messages: StreamServerMessage[]; errors: string[] };
  sampleUi: { fullscreen(open: boolean): void; hidden(hidden: boolean): void; interactive(enabled: boolean): void; close(): Promise<void> };
}

describe.skipIf(!process.env.FP_CHROMIUM_PATH)('real Chromium screen pointer', () => {
  let root: string;
  let browser: Browser;
  let page: Page;
  let automation: BrowserAutomationSession;
  let server: Server;
  let baseUrl: string;
  let hub: ScreenStreamHub;
  let events: BrowserScreenEvent[];
  let unsubscribe: () => void;
  const streamClients = new Map<ServerResponse, ViewerSink>();
  const evidence: Record<string, unknown> = {};

  beforeAll(async () => {
    root = await mkdtemp(join(process.env.PISKIE_TEST_ARTIFACT_DIR ?? tmpdir(), 'sample-pointer-'));
    const projectRoot = resolve(import.meta.dirname, '../../../../../..');
    await build({ stdin: { contents: screenPointerUiSource, resolveDir: projectRoot, loader: 'tsx' },
      bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', outfile: join(root, 'sample-ui.js'),
      alias: { '@': join(projectRoot, 'src'), '@shared': join(projectRoot, 'shared') }, logLevel: 'silent',
      plugins: [{ name: 'sample-vite-worker', setup(builder) {
        builder.onResolve({ filter: /\?worker$/ }, () => ({ path: 'sample-worker', namespace: 'sample-worker' }));
        builder.onLoad({ filter: /.*/, namespace: 'sample-worker' }, () => ({
          contents: "export default class extends Worker { constructor() { super('/sample-worker.js', {type:'module'}); } }", loader: 'js',
        }));
      } }] });
    await build({ entryPoints: [join(projectRoot, 'src/workers/screen-stream.worker.ts')],
      bundle: true, platform: 'browser', format: 'esm', outfile: join(root, 'sample-worker.js'),
      alias: { '@': join(projectRoot, 'src'), '@shared': join(projectRoot, 'shared') }, logLevel: 'silent' });
    server = createServer(async (request, response) => {
      if (request.url === '/sample-stream') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        response.write(': sample stream\n\n');
        const sink: ViewerSink = {
          isOpen: () => !response.destroyed,
          send: (message) => response.write(`data: ${JSON.stringify(message.type === 'frame'
            ? { ...message, data: Buffer.from(message.data).toString('base64') } : message)}\n\n`),
        };
        streamClients.set(response, sink);
        response.on('close', () => { hub.removeViewer(BROWSER_ID, sink); streamClients.delete(response); });
        await hub.addViewer(BROWSER_ID, sink, { fps: 30, maxWidth: 400, maxHeight: 300 });
      } else if (request.url === '/sample-control') {
        let body = '';
        for await (const chunk of request) body += chunk;
        const message = JSON.parse(body) as StreamControlMessage;
        const sink = [...streamClients.values()][0];
        if (sink && message.type === 'set-fps') await hub.updateViewerFps(BROWSER_ID, sink, message.fps);
        if (sink && message.type === 'set-quality') await hub.updateViewerQuality(BROWSER_ID, sink, message);
        if (message.type === 'input') await hub.dispatchInput(BROWSER_ID, message.event);
        response.end('sample');
      } else if (request.url === '/sample-ui') {
        response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(screenPointerUiHtml);
      } else if (['/sample-ui.js', '/sample-ui.css', '/sample-worker.js'].includes(request.url ?? '')) {
        response.writeHead(200, { 'Content-Type': request.url!.endsWith('.css') ? 'text/css' : 'application/javascript' });
        response.end(await readFile(join(root, request.url!.slice(1))));
      } else if (request.url === '/sample-inputs' || request.url === '/sample-input-frame') {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end(request.url === '/sample-inputs' ? operationPointerHtml : operationPointerFrameHtml);
      } else if (request.url === '/sample-frame') {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end(`<!doctype html><style>body{margin:0;background:#dde9f0}button{position:absolute;left:40px;top:30px;width:140px;height:60px;border:0}</style><button id="sample-frame-button">Sample frame button</button>${RECORD_EVENTS}`);
      } else {
        response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(HTML);
      }
    });
    await new Promise<void>((yes) => server.listen(0, '127.0.0.1', yes));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await puppeteer.launch({ executablePath: process.env.FP_CHROMIUM_PATH, headless: true,
      userDataDir: join(root, 'sample-profile'), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const manager = BrowserManager as unknown as {
      initialized: boolean; readPersistedBrowserConfig(id: string): Promise<unknown>;
      savePersisted(id: string, value: unknown): Promise<void>; deletePersisted(id: string): Promise<void>;
    };
    manager.initialized = true;
    vi.spyOn(manager, 'readPersistedBrowserConfig').mockResolvedValue({ wsEndpoint: browser.wsEndpoint() });
    vi.spyOn(manager, 'savePersisted').mockResolvedValue(undefined);
    vi.spyOn(manager, 'deletePersisted').mockResolvedValue(undefined);
    await BrowserManager.getOrCreate(BROWSER_ID);
  }, 30_000);

  beforeEach(async () => {
    automation = await BrowserManager.getScreenSession(BROWSER_ID);
    page = automation.getSelectedPage();
    await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 2 });
    await page.goto(`${baseUrl}/sample`, { waitUntil: 'networkidle0' });
    events = [];
    unsubscribe = automation.subscribeScreen((event) => events.push(event));
    hub = new ScreenStreamHub();
  });
  afterEach(async () => {
    unsubscribe?.();
    for (const response of streamClients.keys()) response.end();
    streamClients.clear();
    hub?.close();
  });
  afterAll(async () => {
    try {
      await BrowserManager.closeAll();
      await browser?.close();
      if (process.env.PISKIE_POINTER_EVIDENCE_DIR) {
        await mkdir(process.env.PISKIE_POINTER_EVIDENCE_DIR, { recursive: true });
        await writeFile(join(process.env.PISKIE_POINTER_EVIDENCE_DIR, 'live-evidence.json'), JSON.stringify(evidence, null, 2));
      }
    } finally {
      server?.closeAllConnections();
      if (server) await new Promise<void>((yes) => server.close(() => yes()));
      if (root) await rm(root, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  }, 15_000);

  function generated() {
    return createGeneratedBrowserSkillRuntime({ browserId: BROWSER_ID, signal: new AbortController().signal,
      log: () => {}, notifyPageOpen: () => {}, allowedFileRoots: [root] });
  }
  async function clickBuiltin(name: string) {
    const snapshot = await builtin.takeSnapshot({ browserId: BROWSER_ID });
    const uid = snapshot.match(new RegExp(`\\[(\\d+_\\d+)\\] (?:button|link) "${name}"`))?.[1];
    expect(uid).toBeDefined();
    await builtin.clickByUid({ browserId: BROWSER_ID, uid: uid! });
  }
  async function checkOperation(name: string, operation: () => Promise<unknown>) {
    events.length = 0;
    await page.evaluate(() => { (window as unknown as SampleUiWindow).sampleEvents = []; });
    await operation();
    const observed = events.filter((event): event is Extract<BrowserScreenEvent, { type: 'pointer' }> => event.type === 'pointer')
      .map((event) => event.pointer).sort((left, right) => left.seq - right.seq);
    const received = await page.evaluate(() => (window as unknown as SampleUiWindow).sampleEvents);
    for (const action of observed) {
      const type = action.action === 'move' ? 'pointermove' : action.action === 'down' ? 'pointerdown' : 'pointerup';
      expect(received.some((event) => event.type === type && Math.abs(event.x - action.x) < 1
        && Math.abs(event.y - action.y) < 1 && event.buttons === action.buttons), `${name}: ${action.action} ${action.x},${action.y}`).toBe(true);
      expect(sameScreenPage(action.page, automation.getScreenTarget().identity)).toBe(true);
    }
    expect(observed.length).toBeGreaterThan(0);
    evidence[name] = { observed, received };
    return { observed, received };
  }

  async function openOperationDisplay(decodeDelayMs = 0, viewport: 'inline' | 'scroll' = 'inline') {
    const display = await browser.newPage();
    display.setDefaultTimeout(7_000);
    await display.setViewport({ width: 1280, height: 820, deviceScaleFactor: 2 });
    await display.evaluateOnNewDocument(({ decodeDelay, observedViewport }) => {
      const sample = window as unknown as SampleUiWindow;
      sample.samplePaintRows = [];
      const NativeWorker = window.Worker;
      const nodes = new WeakMap<Element, number>();
      let nodeSequence = 0;
      window.Worker = class extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          const originalUrl = new URL(url, location.href).href;
          const delayedUrl = decodeDelay ? URL.createObjectURL(new Blob([
            `import ${JSON.stringify(originalUrl)};const nativeDecode=self.createImageBitmap.bind(self);let sampleDecode=0;self.createImageBitmap=async(...args)=>{if(++sampleDecode%3===0)await new Promise(resolve=>setTimeout(resolve,${decodeDelay}));return nativeDecode(...args)};`,
          ], { type: 'application/javascript' })) : null;
          super(delayedUrl ?? url, options);
          if (delayedUrl) this.addEventListener('message', () => URL.revokeObjectURL(delayedUrl), { once: true });
          this.addEventListener('message', (event: MessageEvent<ScreenWorkerOutgoingMessage>) => {
            const message = event.data;
            if ((message.type === 'viewport-frame' || message.type === 'viewport-pointer') && message.leaseId === (observedViewport === 'inline' ? 'viewport-1' : 'viewport-2')) {
              sample.samplePresentedPointer = message.pointer;
              if (message.type === 'viewport-frame') { sample.sampleFramePage = message.frame.page; sample.sampleCurrentFrame = message.frame; }
              else if (message.frame) sample.sampleCurrentFrame = message.frame;
            }
          });
        }
      };
      function samplePaint() {
        const layer = document.querySelector<HTMLElement>(`[data-example="${observedViewport}"] [data-screen-pointer-layer]`);
        const arrow = layer?.querySelector<SVGElement>('[data-screen-pointer]');
        const ring = layer?.querySelector<HTMLElement>('[data-screen-pointer-ripple]');
        const css = layer ? getComputedStyle(layer) : null;
        const width = css ? Number.parseFloat(css.width) : 0, height = css ? Number.parseFloat(css.height) : 0;
        const frame = sample.sampleCurrentFrame;
        const scale = frame ? Math.min(width / frame.width, height / frame.height) : 1;
        const mapping = frame?.mapping ?? { scale: 1, offsetX: 0, offsetY: 0 };
        if (arrow && !nodes.has(arrow)) nodes.set(arrow, ++nodeSequence);
        // Diagnostic only: record the actual motion destination alongside the visible DOM point.
        type Fiber = { memoizedState?: { memoizedState?: unknown; next?: Fiber['memoizedState'] }; return?: Fiber };
        const fiberKey = arrow && Object.keys(arrow).find((key) => key.startsWith('__reactFiber$'));
        let desired: { x: number; y: number } | null = null;
        for (let fiber = fiberKey ? (arrow as unknown as Record<string, Fiber>)[fiberKey] : undefined; fiber; fiber = fiber.return) {
          for (let hook = fiber.memoizedState; hook; hook = hook.next) {
            const state = hook.memoizedState as { moveTo?: unknown; target?: { x: number; y: number } } | null;
            if (state && typeof state.moveTo === 'function') desired = state.target ?? null;
          }
          if (desired) break;
        }
        sample.samplePaintRows.push({ at: Date.now(), raf: performance.now(), frame: sample.sampleFramePage,
          frameMeta: frame, pointer: sample.samplePresentedPointer, desired,
          origin: arrow?.getAttribute('data-origin'), actor: arrow?.getAttribute('data-actor'),
          gradient: arrow?.querySelector('linearGradient')?.id,
          x: arrow && layer && frame ? ((Number.parseFloat(arrow.style.left) - (width - frame.width * scale) / 2) / scale - mapping.offsetX) / mapping.scale : null,
          y: arrow && layer && frame ? ((Number.parseFloat(arrow.style.top) - (height - frame.height * scale) / 2) / scale - mapping.offsetY) / mapping.scale : null,
          arrowNode: arrow ? nodes.get(arrow)! : null, arrowOpacity: arrow ? Number(getComputedStyle(arrow).opacity) : 0,
          rippleOpacity: ring ? Number(getComputedStyle(ring).opacity) : 0 });
        requestAnimationFrame(samplePaint);
      }
      requestAnimationFrame(samplePaint);
    }, { decodeDelay: decodeDelayMs, observedViewport: viewport });
    await display.goto(`${baseUrl}/sample-ui`);
    await display.waitForFunction(() => document.querySelectorAll('[data-example] canvas[data-visible="true"]').length === 3);
    return display;
  }
  async function awaitOperationPoint(display: Page, expected: { x: number; y: number }) {
    try {
      await display.waitForFunction((point) => {
        const row = (window as unknown as SampleUiWindow).samplePaintRows.at(-1);
        return !!row && row.x !== null && row.y !== null && row.arrowOpacity > 0.9
          && Math.abs(row!.x! - point.x) < 0.05 && Math.abs(row!.y! - point.y) < 0.05;
      }, { polling: 'raf' }, expected);
    } catch (error) {
      const diagnostic = await display.evaluate(() => ({ rows: (window as unknown as SampleUiWindow).samplePaintRows.slice(-12), errors: (window as unknown as SampleUiWindow).sampleState.errors,
        layer: [...document.querySelectorAll<HTMLElement>('[data-example="inline"] [data-screen-pointer-layer]')].map((element) => ({ width: getComputedStyle(element).width, height: getComputedStyle(element).height,
          arrow: element.querySelector<SVGElement>('[data-screen-pointer]')?.outerHTML })) }));
      evidence['operation-point-failure'] = { expected, diagnostic };
      if (process.env.PISKIE_POINTER_EVIDENCE_DIR) await display.screenshot({ path: join(process.env.PISKIE_POINTER_EVIDENCE_DIR, 'operation-point-failure.png') });
      throw error;
    }
  }
  async function operationUid(name: string) {
    const snapshot = await automation.takeSnapshot();
    const node = [...snapshot.idToNode.values()].find((entry) => entry.name === name);
    expect(node).toBeDefined();
    return node!.id;
  }
  async function domPoint(selector: string) {
    return page.$eval(selector, (element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
  }

  it('shows initialization on the first real frame, initializes new Pages and recovery, and restores a known Page without injecting input', async () => {
    const initial = automation.getCurrentScreenPointer()!;
    expect(initial).toMatchObject({ origin: 'initial', action: 'initialize', seq: 0, x: 24, y: 24 });
    const display = await openOperationDisplay();
    try {
      await awaitOperationPoint(display, initial);
      const rows = await display.evaluate(() => (window as unknown as SampleUiWindow).samplePaintRows);
      const firstPaint = rows.find((row) => row.frame && row.arrowOpacity > 0.9)!;
      expect(firstPaint.arrowOpacity).toBeGreaterThan(0.9);
      expect(Math.abs(firstPaint.x! - 24)).toBeLessThan(1);
      expect(Math.abs(firstPaint.y! - 24)).toBeLessThan(1);
      expect(firstPaint.rippleOpacity).toBe(0);
      if (process.env.PISKIE_POINTER_EVIDENCE_DIR) await display.screenshot({ path: join(process.env.PISKIE_POINTER_EVIDENCE_DIR, 'initial-operation-pointer.png') });
      await page.mouse.move(80, 120);
      const known = automation.getCurrentScreenPointer()!;
      const firstIndex = automation.getSelectedPageIndex();
      events.length = 0;
      const next = await automation.newPage(`${baseUrl}/sample-inputs`);
      const nextIdentity = automation.getScreenTarget().identity;
      evidence['new-page-owner-diagnostic'] = { nextIdentity, pointer: automation.getCurrentScreenPointer(),
        nextUrl: next.url(), selectedUrl: automation.getSelectedPage().url(), events: events.map((event) => event.type === 'target' ? { type: 'target', identity: event.target?.identity } : event) };
      expect(automation.getCurrentScreenPointer()).toMatchObject({ origin: 'initial', x: 24, y: 24 });
      await awaitOperationPoint(display, { x: 24, y: 24 });
      await automation.selectPageByIndex(firstIndex);
      expect(automation.getCurrentScreenPointer()).toMatchObject({ page: known.page, seq: known.seq, timestamp: known.timestamp, x: 80, y: 120 });
      await awaitOperationPoint(display, known);
      await next.close();
      expect(events.filter((event) => event.type === 'pointer')).toEqual([]);
      await automation.browser.disconnect();
      const recovered = await BrowserManager.getScreenSession(BROWSER_ID);
      const recoveredPointer = recovered.getCurrentScreenPointer()!;
      expect(recoveredPointer).toMatchObject({ origin: 'initial', action: 'initialize', seq: 0 });
      await display.waitForFunction((connectionId) => (window as unknown as SampleUiWindow).sampleFramePage?.connectionId === connectionId,
        { polling: 'raf' }, recovered.generation);
      await awaitOperationPoint(display, recoveredPointer);
      evidence['operation-initialization'] = { initial, firstPaint, nextIdentity, known, recoveredPointer, rows };
    } finally { await display.close(); }
  }, 20_000);

  it('covers builtin/SDK short and long text, form, select/native option, visible/hidden upload and checkbox change/noop with honest sources', async () => {
    await page.goto(`${baseUrl}/sample-inputs`);
    const display = await openOperationDisplay();
    const runtime = generated();
    const checks: unknown[] = [];
    const recording = process.env.PISKIE_POINTER_VIDEO && process.env.PISKIE_POINTER_EVIDENCE_DIR
      ? await display.screencast({ path: `${process.env.PISKIE_POINTER_EVIDENCE_DIR}/operation-targets.webm`, fps: 30, ffmpegPath: '/usr/bin/ffmpeg' }) : null;
    async function nonMouse(name: string, selector: string, action: () => Promise<unknown>, value?: string) {
      const before = automation.getCurrentScreenPointer()!;
      events.length = 0;
      await page.evaluate(() => { (window as unknown as SampleUiWindow).sampleEvents = []; });
      await display.evaluate(() => { (window as unknown as SampleUiWindow).samplePaintRows = []; });
      await action();
      const point = await domPoint(selector);
      await vi.waitFor(() => {
        expect(automation.getCurrentScreenPointer()?.target).toMatchObject(point);
        expect(automation.getCurrentScreenPointer()!.target!.seq).toBeGreaterThan(before.target?.seq ?? before.positionTarget?.seq ?? 0);
      });
      await awaitOperationPoint(display, point);
      await display.waitForFunction((seq) => document.querySelector('[data-example="inline"] [data-screen-pointer-target]')?.getAttribute('data-target-seq') === String(seq),
        { polling: 'raf' }, automation.getCurrentScreenPointer()!.target!.seq);
      if (value !== undefined) expect(await page.$eval(selector, (element) => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.value : element.textContent)).toBe(value);
      const native = events.filter((event) => event.type === 'pointer');
      const dom = await page.evaluate(() => (window as unknown as SampleUiWindow).sampleEvents);
      expect(native).toEqual([]);
      expect(dom.filter((event) => event.type.startsWith('pointer'))).toEqual([]);
      expect(await display.$$('[data-example="inline"] [data-screen-pointer-target]')).toHaveLength(1);
      const current = automation.getCurrentScreenPointer()!;
      expect(current).toMatchObject({ page: before.page, seq: before.seq, timestamp: before.timestamp, x: before.x, y: before.y });
      const rows = await display.evaluate(() => (window as unknown as SampleUiWindow).samplePaintRows);
      expect(rows.every((row) => row.rippleOpacity === 0)).toBe(true);
      checks.push({ name, point, before, current, nativeCount: native.length, domPointerCount: 0, rows });
    }
    try {
      for (const [selector, name] of [['#sample-input', 'Example input'], ['#sample-area', 'Example textarea'], ['#sample-editable', 'Example editable']]) {
        for (const long of [false, true]) {
          const value = long ? 'Sample text '.repeat(18) : 'Sample text';
          await nonMouse(`SDK ${name} ${long ? 'long' : 'short'}`, selector, () => runtime.page.fill({ css: selector }, value), value);
          const uid = await operationUid(name);
          const replacement = long ? 'Example complete value '.repeat(12) : 'Example complete value';
          await nonMouse(`builtin ${name} ${long ? 'long' : 'short'}`, selector,
            () => builtin.fillByUid({ browserId: BROWSER_ID, uid, value: replacement }), replacement);
        }
      }
      const snapshot = await automation.takeSnapshot();
      const form = ['Example input', 'Example textarea'].map((name) => ({ uid: [...snapshot.idToNode.values()].find((node) => node.name === name)!.id, value: 'Sample form' }));
      await nonMouse('builtin form', '#sample-area', () => builtin.fillFormByUids({ browserId: BROWSER_ID, elements: form }), 'Sample form');
      await nonMouse('SDK select', '#sample-select', () => runtime.page.select({ css: '#sample-select' }, 'two'));
      expect(await page.$eval('#sample-select', (element) => (element as HTMLSelectElement).value)).toBe('two');
      const selectUid = await operationUid('Example select');
      await nonMouse('builtin select display text', '#sample-select', () => builtin.fillByUid({ browserId: BROWSER_ID, uid: selectUid, value: 'Example one' }));
      const optionUid = await operationUid('Example two');
      await nonMouse('builtin native option', '#sample-select', () => builtin.clickByUid({ browserId: BROWSER_ID, uid: optionUid }));
      const file = join(root, 'sample-upload.txt');
      await writeFile(file, 'Sample upload');
      await nonMouse('visible file upload', '#sample-file', () => runtime.page.uploadFile({ css: '#sample-file' }, file));
      const previousPosition = automation.getCurrentScreenPointer()!.target!;
      events.length = 0;
      await runtime.page.uploadFile({ css: '#sample-hidden-file' }, file);
      await vi.waitFor(() => expect(automation.getCurrentScreenPointer()?.target).toBeUndefined());
      await awaitOperationPoint(display, previousPosition);
      expect(automation.getCurrentScreenPointer()).toMatchObject({ activity: { kind: 'upload' }, positionTarget: {
        page: previousPosition.page, seq: previousPosition.seq, timestamp: previousPosition.timestamp,
        x: previousPosition.x, y: previousPosition.y, rect: previousPosition.rect,
        scrollX: previousPosition.scrollX, scrollY: previousPosition.scrollY, kind: previousPosition.kind, actor: previousPosition.actor,
      } });
      expect(events.filter((event) => event.type === 'pointer')).toEqual([]);
      expect(await page.$eval('#sample-hidden-file', (element) => (element as HTMLInputElement).files?.[0]?.name)).toBe('sample-upload.txt');
      checks.push({ name: 'hidden upload', pointer: automation.getCurrentScreenPointer(), nativeCount: 0 });
      events.length = 0;
      await runtime.page.fill({ css: '#sample-toggle' }, 'false').then(() => { throw new Error('Toggle fill must reject'); }, (error: Error) => expect(error.message).toContain('toggles are not supported'));
      expect(await page.$eval('#sample-toggle', (element) => (element as HTMLInputElement).checked)).toBe(false);
      expect(events.filter((event) => event.type === 'pointer')).toEqual([]);
      for (const value of ['true', 'true', 'false']) {
        const uid = await operationUid('Example toggle');
        events.length = 0;
        const wasChecked = await page.$eval('#sample-toggle', (element) => (element as HTMLInputElement).checked);
        await builtin.fillByUid({ browserId: BROWSER_ID, uid, value });
        const native = events.filter((event) => event.type === 'pointer');
        expect(native.length).toBe(wasChecked === (value === 'true') ? 0 : 3);
        expect(await page.$eval('#sample-toggle', (element) => (element as HTMLInputElement).checked)).toBe(value === 'true');
        checks.push({ name: `builtin toggle ${value}`, nativeCount: native.length, pointer: automation.getCurrentScreenPointer() });
      }
      await page.evaluate(() => document.querySelector('#sample-input')!.setAttribute('role', 'checkbox'));
      await runtime.page.fill({ css: '#sample-input' }, 'Sample valid text');
      expect(await page.$eval('#sample-input', (element) => (element as HTMLInputElement).value)).toBe('Sample valid text');
      if (process.env.PISKIE_POINTER_EVIDENCE_DIR) {
        await display.screenshot({ path: join(process.env.PISKIE_POINTER_EVIDENCE_DIR, 'input-operation-pointer.png') });
        await page.screenshot({ path: join(process.env.PISKIE_POINTER_EVIDENCE_DIR, 'input-source-page.png') });
      }
      evidence['operation-inputs'] = checks;
    } finally { await recording?.stop(); await display.close(); }
  }, 30_000);

  it('keeps stationary input and select positions stable on every RAF after arrival without new operations', async () => {
    await page.goto(`${baseUrl}/sample-inputs`);
    // Exercise a real image decode completing after the asynchronous target geometry read.
    const display = await openOperationDisplay(60);
    const checks: Array<{ name: string; expected: { x: number; y: number }; rows: SamplePaintRow[]; source: unknown; dom: unknown }> = [];
    try {
      const runtime = generated();
      for (const scenario of [
        { name: 'input after an edge click', selector: '#sample-input', action: async () => {
          await page.mouse.click(82, 80);
          await runtime.page.fill({ css: '#sample-input' }, 'Sample stable input');
        } },
        { name: 'select after a remote mouse point', selector: '#sample-select', action: async () => {
          await page.mouse.move(650, 300);
          await runtime.page.select({ css: '#sample-select' }, 'two');
        } },
        { name: 'Tab focus', selector: '#sample-area', action: async () => {
          await runtime.page.fill({ css: '#sample-input' }, 'Example next input');
          await runtime.page.press('Tab');
        } },
      ]) {
        await scenario.action();
        const expected = await domPoint(scenario.selector);
        await awaitOperationPoint(display, expected);
        await display.evaluate(() => { (window as unknown as SampleUiWindow).samplePaintRows = []; });
        // A small page decoration changes pixels without changing any control or focus geometry.
        const decoration = await page.addStyleTag({ content: 'body::after{content:"";position:absolute;left:700px;top:20px;width:30px;height:30px;background:#398cbb;animation:sample-paint .2s linear infinite alternate}@keyframes sample-paint{to{background:#d4e7f0}}' });
        await display.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 2500)));
        await decoration.evaluate((element) => element.remove());
        await decoration.dispose();
        checks.push({ name: scenario.name, expected,
          rows: await display.evaluate(() => (window as unknown as SampleUiWindow).samplePaintRows),
          source: structuredClone(automation.getCurrentScreenPointer()),
          dom: await page.evaluate(() => (window as unknown as SampleUiWindow).sampleEvents) });
      }
      for (const check of checks) {
        expect(check.rows.length, check.name).toBeGreaterThan(30);
        expect(check.rows.every((row) => row.x !== null && row.y !== null && row.arrowOpacity > .9
          && Math.abs(row.x - check.expected.x) < .05 && Math.abs(row.y - check.expected.y) < .05), check.name).toBe(true);
        expect(new Set(check.rows.map((row) => row.arrowNode)).size, check.name).toBe(1);
      }
    } finally {
      evidence['stationary-arrival'] = checks;
      if (process.env.PISKIE_POINTER_EVIDENCE_DIR) await display.screenshot({ path: join(process.env.PISKIE_POINTER_EVIDENCE_DIR, 'stationary-arrival.png') });
      await display.close();
    }
  }, 30_000);

  it.each([0, 60])('keeps a partially visible input stationary across real frame refreshes with %dms decode latency', async (decodeDelay) => {
    await page.goto(`${baseUrl}/sample-inputs`);
    await page.$eval('#sample-input', (element) => { Object.assign((element as HTMLElement).style, { left: '280px', top: '240px' }); });
    const display = await openOperationDisplay(decodeDelay, 'scroll');
    let rows: SamplePaintRow[] = [];
    let snapshots: ReturnType<typeof setInterval> | undefined;
    const recording = process.env.PISKIE_POINTER_VIDEO && process.env.PISKIE_POINTER_EVIDENCE_DIR
      ? await display.screencast({ path: `${process.env.PISKIE_POINTER_EVIDENCE_DIR}/clipped-stationary-${decodeDelay}.webm`, fps: 30, ffmpegPath: '/usr/bin/ffmpeg' }) : null;
    try {
      await page.mouse.click(282, 260);
      await generated().page.fill({ css: '#sample-input' }, 'Sample clipped input');
      const expected = await display.evaluate(() => {
        const layer = document.querySelector<HTMLElement>('[data-example="scroll"] [data-screen-pointer-layer]')!;
        const viewport = layer.parentElement!.parentElement!.getBoundingClientRect();
        const box = layer.getBoundingClientRect();
        const right = (viewport.right - box.left) / (box.width / 800);
        return { x: (280 + Math.min(520, right)) / 2, y: 260 };
      });
      await awaitOperationPoint(display, expected);
      await display.evaluate(() => { (window as unknown as SampleUiWindow).samplePaintRows = []; });
      const decoration = await page.addStyleTag({ content: 'body::after{content:"";position:absolute;left:700px;top:20px;width:30px;height:30px;background:#398cbb;animation:sample-paint .2s linear infinite alternate}@keyframes sample-paint{to{background:#d4e7f0}}' });
      // Alternate full native screenshots with sampled screencast images; all metadata is real.
      const capture = [...(hub as unknown as { casters: Map<string, { caster: ScreenCaster }> }).casters.values()][0]!.caster;
      snapshots = setInterval(() => { void capture.refreshFrame(); }, 120);
      await display.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 2500)));
      clearInterval(snapshots);
      snapshots = undefined;
      rows = await display.evaluate(() => (window as unknown as SampleUiWindow).samplePaintRows);
      await decoration.evaluate((element) => element.remove());
      await decoration.dispose();
      evidence[`clipped-stationary-${decodeDelay}`] = { expected, rows, source: automation.getCurrentScreenPointer(),
        events: events.map((event) => event.type === 'target' ? { type: 'target', identity: event.target?.identity } : event) };
      expect(rows.length).toBeGreaterThan(30);
      expect(rows.every((row) => row.x !== null && row.y !== null && row.arrowOpacity > .9
        && Math.abs(row.x - expected.x) < .05 && Math.abs(row.y - expected.y) < .05)).toBe(true);
    } finally {
      clearInterval(snapshots);
      await recording?.stop();
      if (!rows.length) evidence[`clipped-stationary-failure-${decodeDelay}`] = await display.evaluate(() => (window as unknown as SampleUiWindow).samplePaintRows);
      if (process.env.PISKIE_POINTER_EVIDENCE_DIR) await display.screenshot({ path: join(process.env.PISKIE_POINTER_EVIDENCE_DIR, `clipped-stationary-${decodeDelay}.png`) });
      await display.close();
    }
  }, 15_000);

  it('follows real cropped target movement, viewport scroll and resize, DPR changes, fullscreen and manual-to-AI ownership', async () => {
    await page.goto(`${baseUrl}/sample-inputs`);
    await page.$eval('#sample-input', (element) => { Object.assign((element as HTMLElement).style, { left: '280px', top: '240px' }); });
    await page.addStyleTag({ content: '#sample-input:focus{border-width:6px;outline:2px solid #71d6ff}' });
    const display = await openOperationDisplay(60, 'scroll');
    const checks: unknown[] = [];
    let snapshots: ReturnType<typeof setInterval> | undefined;
    async function stable(name: string, rect: { x: number; y: number; width: number; height: number }) {
      const expected = await display.evaluate((control) => {
        const layer = document.querySelector<HTMLElement>('[data-example="scroll"] [data-screen-pointer-layer]')!;
        const viewport = layer.parentElement!.parentElement!.getBoundingClientRect();
        const box = layer.getBoundingClientRect();
        const scale = box.width / 800;
        const left = (Math.max(0, viewport.left) - box.left) / scale;
        const right = (Math.min(innerWidth, viewport.right) - box.left) / scale;
        const center = control.x + control.width / 2;
        return { x: center >= left && center <= right ? center : (Math.max(left, control.x) + Math.min(right, control.x + control.width)) / 2,
          y: control.y + control.height / 2 };
      }, rect);
      await awaitOperationPoint(display, expected);
      await display.evaluate(() => { (window as unknown as SampleUiWindow).samplePaintRows = []; });
      await display.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 400)));
      const rows = await display.evaluate(() => (window as unknown as SampleUiWindow).samplePaintRows);
      checks.push({ name, rect, expected, rows, pointer: structuredClone(automation.getCurrentScreenPointer()) });
      expect(rows.length, name).toBeGreaterThan(10);
      expect(rows.every((row) => row.x !== null && row.y !== null && row.arrowOpacity > .9
        && Math.abs(row.x - expected.x) < .05 && Math.abs(row.y - expected.y) < .05), name).toBe(true);
      return expected;
    }
    try {
      await hub.dispatchInput(BROWSER_ID, { kind: 'mouse', type: 'mouseMoved', x: 282, y: 260, buttons: 0 });
      await awaitOperationPoint(display, { x: 282, y: 260 });
      const native = structuredClone(automation.getCurrentScreenPointer()!);
      expect(native.actor).toBe('manual');
      await generated().page.fill({ css: '#sample-input' }, 'Sample focus input');
      await vi.waitFor(() => expect(automation.getCurrentScreenPointer()?.target).toMatchObject({ x: 400, y: 260, actor: 'ai' }));
      const capture = [...(hub as unknown as { casters: Map<string, { caster: ScreenCaster }> }).casters.values()][0]!.caster;
      snapshots = setInterval(() => { void capture.refreshFrame(); }, 120);
      await stable('focused partial control', { x: 280, y: 240, width: 240, height: 40 });
      await page.$eval('#sample-input', (element) => { (element as HTMLElement).style.left = '300px'; });
      await vi.waitFor(() => expect(automation.getCurrentScreenPointer()?.target?.x).toBe(420));
      await stable('page-driven target movement', { x: 300, y: 240, width: 240, height: 40 });
      await display.evaluate(() => {
        const layer = document.querySelector<HTMLElement>('[data-example="scroll"] [data-screen-pointer-layer]')!;
        layer.parentElement!.parentElement!.scrollLeft = 80;
      });
      await stable('local horizontal scroll', { x: 300, y: 240, width: 240, height: 40 });
      await display.$eval('[data-example="scroll"]', (element) => { (element as HTMLElement).style.width = '180px'; });
      await stable('narrow resize', { x: 300, y: 240, width: 240, height: 40 });
      await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 1 });
      await display.setViewport({ width: 1280, height: 820, deviceScaleFactor: 1 });
      expect(await page.evaluate(() => devicePixelRatio)).toBe(1);
      await stable('DPR one capture and display', { x: 300, y: 240, width: 240, height: 40 });
      await display.evaluate(() => (window as unknown as SampleUiWindow).sampleUi.fullscreen(true));
      await display.waitForFunction(() => {
        const layer = document.querySelector<HTMLElement>('dialog[open] [data-screen-pointer-layer]');
        const arrow = layer?.querySelector<SVGElement>('[data-screen-pointer]');
        if (!layer || !arrow) return false;
        const box = layer.getBoundingClientRect();
        const point = arrow.getBoundingClientRect();
        return Math.abs((point.x - box.left) / (box.width / 800) - 420) < .05
          && Math.abs((point.y - box.top) / (box.height / 600) - 260) < .05;
      }, { polling: 'raf' });
      expect(await display.$$('dialog[open] [data-screen-pointer]')).toHaveLength(1);
      checks.push({ name: 'fullscreen', pointer: automation.getCurrentScreenPointer(), arrows: await display.$$eval('dialog[open] [data-screen-pointer]', (arrows) => arrows.map((arrow) => ({ actor: arrow.getAttribute('data-actor'), opacity: getComputedStyle(arrow).opacity }))) });
      await page.$eval('#sample-input', (element) => element.remove());
      await vi.waitFor(() => expect(automation.getCurrentScreenPointer()?.target).toBeUndefined());
      await stable('removed target retained position', { x: 300, y: 240, width: 240, height: 40 });
      expect(automation.getCurrentScreenPointer()).toMatchObject({ x: native.x, y: native.y, seq: native.seq, timestamp: native.timestamp,
        sourceOrder: native.sourceOrder, actor: 'manual', positionTarget: { actor: 'ai', x: 420 } });
      expect(await display.$$('[data-screen-pointer-target]')).toHaveLength(0);
    } finally {
      clearInterval(snapshots);
      evidence['crop-movement-boundaries'] = checks;
      if (process.env.PISKIE_POINTER_EVIDENCE_DIR) await display.screenshot({ path: join(process.env.PISKIE_POINTER_EVIDENCE_DIR, 'crop-movement-boundaries.png') });
      await display.close();
    }
  }, 20_000);

  it('updates dynamic target boxes in three real viewports within the display window and releases them after page-driven removal', async () => {
    await page.setContent(`<!doctype html><style>body{margin:0;background:#eef5fa}#sample-scroll{position:absolute;left:50px;top:40px;width:600px;height:200px;overflow:auto}#sample-content{position:relative;width:900px;height:400px}input{position:absolute;left:30px;top:20px;width:100px;height:40px;box-sizing:border-box}</style><div id="sample-scroll"><div id="sample-content"><input id="sample-control"></div></div>${RECORD_EVENTS}`);
    const display = await openOperationDisplay();
    const runtime = generated();
    const checks: unknown[] = [];
    async function boxes(expected: { x: number; y: number; width: number; height: number }) {
      await display.waitForFunction((rect) => {
        const sample = window as unknown as SampleUiWindow;
        const frame = sample.sampleCurrentFrame;
        if (!frame) return false;
        const layers = [...document.querySelectorAll<HTMLElement>('[data-example] [data-screen-pointer-layer]')];
        return layers.length === 3 && layers.every((layer) => {
          const box = layer.querySelector<HTMLElement>('[data-screen-pointer-target]');
          if (!box) return false;
          const css = getComputedStyle(layer), width = parseFloat(css.width), height = parseFloat(css.height);
          const scale = Math.min(width / frame.width, height / frame.height), mapping = frame.mapping ?? { scale: 1, offsetX: 0, offsetY: 0 };
          const x = ((parseFloat(box.style.left) - (width - frame.width * scale) / 2) / scale - mapping.offsetX) / mapping.scale;
          const y = ((parseFloat(box.style.top) - (height - frame.height * scale) / 2) / scale - mapping.offsetY) / mapping.scale;
          return Math.abs(x - rect.x) < .05 && Math.abs(y - rect.y) < .05
            && Math.abs(parseFloat(box.style.width) / scale / mapping.scale - rect.width) < .05
            && Math.abs(parseFloat(box.style.height) / scale / mapping.scale - rect.height) < .05;
        });
      }, { polling: 'raf' }, expected);
      return display.evaluate(() => ({ frame: (window as unknown as SampleUiWindow).sampleCurrentFrame,
        pointer: (window as unknown as SampleUiWindow).samplePresentedPointer,
        boxes: [...document.querySelectorAll<HTMLElement>('[data-example] [data-screen-pointer-target]')].map((box) => ({ left: box.style.left, top: box.style.top, width: box.style.width, height: box.style.height })) }));
    }
    try {
      await page.mouse.move(650, 300);
      const native = structuredClone(automation.getCurrentScreenPointer()!);
      events.length = 0;
      await page.evaluate(() => { (window as unknown as SampleUiWindow).sampleEvents = []; });
      await runtime.page.fill({ css: '#sample-control' }, 'Sample dynamic value');
      await vi.waitFor(() => expect(automation.getCurrentScreenPointer()?.target).toBeDefined());
      const original = structuredClone(automation.getCurrentScreenPointer()!.target!);
      checks.push({ stage: 'initial', ...(await boxes({ x: 80, y: 60, width: 100, height: 40 })) });
      // A new image with identical control geometry preserves the target's original clock.
      await page.evaluate(() => { document.body.style.background = '#dde9f0'; });
      await display.waitForFunction((at) => ((window as unknown as SampleUiWindow).sampleCurrentFrame?.timestamp ?? 0) > at,
        { polling: 'raf' }, original.frameBefore ?? 0);
      expect(automation.getCurrentScreenPointer()!.target!.timestamp).toBe(original.timestamp);
      await runtime.page.fill({ css: '#sample-control' }, 'Sample moving value');
      await vi.waitFor(() => expect(automation.getCurrentScreenPointer()!.target!.seq).toBeGreaterThan(original.seq));
      const moveTarget = structuredClone(automation.getCurrentScreenPointer()!.target!);
      await page.$eval('#sample-control', (element) => { (element as HTMLElement).style.left = '230px'; });
      await vi.waitFor(() => expect(automation.getCurrentScreenPointer()?.target?.rect.x).toBe(280));
      checks.push({ stage: 'moved', ...(await boxes({ x: 280, y: 60, width: 100, height: 40 })), elapsedMs: Date.now() - moveTarget.timestamp });
      expect(Date.now() - moveTarget.timestamp).toBeLessThan(SCREEN_POINTER_POLICY.targetVisibleMs);
      if (process.env.PISKIE_POINTER_EVIDENCE_DIR) await display.screenshot({ path: join(process.env.PISKIE_POINTER_EVIDENCE_DIR, 'p2-dynamic-target-moved.png') });
      await runtime.page.fill({ css: '#sample-control' }, 'Sample internal scroll value');
      await vi.waitFor(() => expect(automation.getCurrentScreenPointer()!.target!.seq).toBeGreaterThan(moveTarget.seq));
      const scrollTarget = structuredClone(automation.getCurrentScreenPointer()!.target!);
      await page.$eval('#sample-scroll', (element) => { element.scrollTop = 10; });
      await vi.waitFor(() => expect(automation.getCurrentScreenPointer()?.target?.rect.y).toBe(50));
      checks.push({ stage: 'internal-scroll', ...(await boxes({ x: 280, y: 50, width: 100, height: 40 })), elapsedMs: Date.now() - scrollTarget.timestamp });
      expect(Date.now() - scrollTarget.timestamp).toBeLessThan(SCREEN_POINTER_POLICY.targetVisibleMs);
      await page.$eval('#sample-control', (element) => element.remove());
      await vi.waitFor(() => expect(automation.getCurrentScreenPointer()?.target).toBeUndefined());
      expect(Date.now() - scrollTarget.timestamp).toBeLessThan(SCREEN_POINTER_POLICY.targetVisibleMs);
      await display.waitForFunction(() => document.querySelectorAll('[data-screen-pointer-target]').length === 0, { polling: 'raf' });
      await awaitOperationPoint(display, { x: 330, y: 70 });
      expect(automation.getCurrentScreenPointer()).toMatchObject({ page: native.page, seq: native.seq, timestamp: native.timestamp,
        origin: 'mouse', x: 650, y: 300, positionTarget: { x: 330, y: 70 } });
      expect(events.filter((event) => event.type === 'pointer')).toEqual([]);
      expect(await page.evaluate(() => (window as unknown as SampleUiWindow).sampleEvents)).toEqual([]);
      expect(await display.$$('[data-screen-pointer]')).toHaveLength(3);
      expect(await display.$$('[data-screen-pointer-ripple]')).toHaveLength(0);
      if (process.env.PISKIE_POINTER_EVIDENCE_DIR) await display.screenshot({ path: join(process.env.PISKIE_POINTER_EVIDENCE_DIR, 'p2-dynamic-target-removed.png') });
      evidence['p2-dynamic-viewports'] = { original, native, checks, final: automation.getCurrentScreenPointer(), rows: await display.evaluate(() => (window as unknown as SampleUiWindow).samplePaintRows) };
    } catch (error) {
      evidence['p2-dynamic-viewports-failure'] = { error: String(error), checks, pointer: automation.getCurrentScreenPointer(),
        target: automation.getScreenTarget().identity, controlExists: await page.$eval('body', (element) => !!element.querySelector('#sample-control')),
        display: await display.evaluate(() => ({ frame: (window as unknown as SampleUiWindow).sampleCurrentFrame,
          pointer: (window as unknown as SampleUiWindow).samplePresentedPointer, messages: (window as unknown as SampleUiWindow).sampleState.messages.slice(-20) })) };
      throw error;
    } finally { await display.close(); }
  }, 15_000);

  it('follows actual selection, Tab, iframe/open-shadow focus, auto/local/key scroll and reliable script effects without extra clicks', async () => {
    await page.goto(`${baseUrl}/sample-inputs`);
    const display = await openOperationDisplay();
    const runtime = generated();
    const checks: unknown[] = [];
    async function focusOperation(name: string, action: () => Promise<unknown>, expected: () => Promise<{ x: number; y: number }>) {
      events.length = 0;
      await action();
      const point = await expected();
      await vi.waitFor(() => expect(automation.getCurrentScreenPointer()?.target).toMatchObject(point));
      await awaitOperationPoint(display, point);
      expect(events.filter((event) => event.type === 'pointer')).toEqual([]);
      checks.push({ name, point, pointer: automation.getCurrentScreenPointer() });
    }
    try {
      await page.$eval('#sample-input', (element) => { const input = element as HTMLInputElement; input.value = 'Example text'; input.focus(); input.setSelectionRange(0, 7); });
      await focusOperation('selection replacement', () => runtime.page.typeText('Sample'), () => domPoint('#sample-input'));
      expect(await page.$eval('#sample-input', (element) => (element as HTMLInputElement).value)).toBe('Sample text');
      await focusOperation('Tab changes focus', () => runtime.page.press('Tab'), () => domPoint('#sample-area'));
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('sample-area');
      const frame = page.frames().find((entry) => entry.url().endsWith('/sample-input-frame'))!;
      await frame.focus('#sample-frame-input');
      await focusOperation('iframe focus', () => builtin.typeText({ browserId: BROWSER_ID, text: 'Sample frame' }), async () => {
        const parent = await page.$eval('iframe', (element) => { const rect = element.getBoundingClientRect(); return { x: rect.x + element.clientLeft, y: rect.y + element.clientTop }; });
        const child = await frame.$eval('input', (element) => { const rect = element.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; });
        return { x: parent.x + child.x, y: parent.y + child.y };
      });
      expect(await frame.$eval('input', (element) => (element as HTMLInputElement).value)).toBe('Sample frame');
      await page.evaluate(() => (document.querySelector('#sample-shadow')!.shadowRoot!.querySelector('input') as HTMLInputElement).focus());
      await focusOperation('open shadow focus', () => runtime.page.typeText('Sample shadow'), () => page.evaluate(() => {
        const rect = document.querySelector('#sample-shadow')!.shadowRoot!.querySelector('input')!.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }));
      await focusOperation('nested and automatic scroll', () => runtime.page.fill({ css: '#sample-nested' }, 'Sample nested'), () => domPoint('#sample-nested'));
      expect(await page.$eval('#sample-scrollport', (element) => element.scrollTop)).toBeGreaterThan(0);
      await page.evaluate(() => { scrollTo(0, 0); (document.activeElement as HTMLElement)?.blur(); });
      events.length = 0;
      await runtime.page.press('PageDown');
      await vi.waitFor(async () => expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0));
      await vi.waitFor(() => expect(automation.getCurrentScreenPointer()?.activity?.kind).toBe('scroll'));
      expect(events.filter((event) => event.type === 'pointer')).toEqual([]);
      checks.push({ name: 'PageDown', pointer: automation.getCurrentScreenPointer(), scrollY: await page.evaluate(() => scrollY) });
      await page.evaluate(() => scrollTo(0, 0));
      await focusOperation('script focus outcome', () => builtin.evaluateScript({ browserId: BROWSER_ID, function: "() => { document.querySelector('#sample-area').focus(); return 'Sample focus'; }" }), () => domPoint('#sample-area'));
      await focusOperation('Tab scrolls to far focus', async () => { await page.focus('#sample-chooser'); await runtime.page.press('Tab'); }, () => domPoint('#sample-far'));
      expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
      await focusOperation('script scroll result', () => builtin.evaluateScript({ browserId: BROWSER_ID, function: "() => { window.scrollBy(0, -100); return 'Sample scroll'; }" }), () => domPoint('#sample-far'));
      events.length = 0;
      const source = automation.getCurrentScreenPointer()!;
      await builtin.evaluateScript({ browserId: BROWSER_ID, function: "() => document.querySelector('#sample-toggle').click()" });
      expect(events.filter((event) => event.type === 'pointer')).toEqual([]);
      expect(automation.getCurrentScreenPointer()).toMatchObject({ seq: source.seq, timestamp: source.timestamp, page: source.page });
      checks.push({ name: 'script DOM click has no inferred mouse source', pointer: automation.getCurrentScreenPointer() });
      if (process.env.PISKIE_POINTER_EVIDENCE_DIR) await display.screenshot({ path: join(process.env.PISKIE_POINTER_EVIDENCE_DIR, 'focus-scroll-operation-pointer.png') });
      evidence['operation-focus-scroll'] = checks;
    } finally { await display.close(); }
  }, 30_000);

  it('observes successful manual CDP input, uses one cursor through the interactive gate, and completes driver promises before UI motion', async () => {
    await page.goto(`${baseUrl}/sample-inputs`);
    const display = await openOperationDisplay();
    const checks: unknown[] = [];
    try {
      await display.evaluate(() => (window as unknown as SampleUiWindow).sampleUi.interactive(true));
      await display.waitForSelector('[data-example="inline"] [role="application"][data-active="true"]');
      const host = await display.$('[data-example="inline"] [role="application"]');
      const box = (await host!.boundingBox())!;
      events.length = 0;
      await page.evaluate(() => { (window as unknown as SampleUiWindow).sampleEvents = []; });
      const point = await domPoint('#sample-input');
      await display.mouse.click(box.x + point.x * box.width / 800, box.y + point.y * box.height / 600);
      await vi.waitFor(() => {
        expect(automation.getCurrentScreenPointer()).toMatchObject({ actor: 'manual', origin: 'mouse', action: 'up' });
        expect(automation.getCurrentScreenPointer()!.x).toBeCloseTo(point.x, 3);
        expect(automation.getCurrentScreenPointer()!.y).toBeCloseTo(point.y, 3);
      });
      await awaitOperationPoint(display, point);
      const manual = events.filter((event) => event.type === 'pointer');
      expect(manual.length).toBe(3);
      expect(manual.every((event) => event.type === 'pointer' && event.pointer.actor === 'manual')).toBe(true);
      expect(await display.$$('[data-example="inline"] [data-screen-pointer]')).toHaveLength(1);
      expect(await display.$eval('[data-example="inline"] [role="application"]', (element) => getComputedStyle(element).cursor)).toBe('none');
      checks.push({ name: 'manual UI move/down/up', manual, pointer: automation.getCurrentScreenPointer() });
      events.length = 0;
      await hub.dispatchInput(BROWSER_ID, { kind: 'mouse', type: 'mouseWheel', x: 200, y: 200, deltaY: 220 });
      await vi.waitFor(async () => expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0));
      expect(automation.getCurrentScreenPointer()).toMatchObject({ actor: 'manual', action: 'wheel', activity: { kind: 'scroll', actor: 'manual' } });
      checks.push({ name: 'manual wheel', pointer: automation.getCurrentScreenPointer(), scrollY: await page.evaluate(() => scrollY) });
      await page.evaluate(() => scrollTo(0, 0));
      await generated().page.fill({ css: '#sample-area' }, 'Sample AI input');
      await awaitOperationPoint(display, await domPoint('#sample-area'));
      await display.waitForFunction(() => document.querySelector('[data-example="inline"] [data-screen-pointer]')?.getAttribute('data-actor') === 'ai');
      await page.focus('#sample-input');
      const handle = await page.$('#sample-input');
      const start = Date.now();
      await automation.input.fill(handle!, 'Sample direct input', 5000, 'reject');
      const elapsed = Date.now() - start;
      await handle!.dispose();
      expect(elapsed).toBeLessThan(SCREEN_POINTER_POLICY.motionMs);
      await awaitOperationPoint(display, await domPoint('#sample-input'));
      checks.push({ name: 'driver promise', elapsedMs: elapsed, motionMs: SCREEN_POINTER_POLICY.motionMs, pointer: automation.getCurrentScreenPointer() });
      evidence['operation-manual-and-promise'] = checks;
    } finally { await display.close(); }
  }, 20_000);

  it('projects an input target in every viewport, invalidates removed/iframe targets, and keeps no-location operations at the known position', async () => {
    await page.goto(`${baseUrl}/sample-inputs`);
    const display = await openOperationDisplay();
    const runtime = generated();
    const checks: unknown[] = [];
    try {
      await runtime.page.fill({ css: '#sample-area' }, 'Sample viewport input');
      const point = await domPoint('#sample-area');
      await awaitOperationPoint(display, point);
      const positions = await display.evaluate((expected) => [...document.querySelectorAll<HTMLElement>('[data-example]')].map((example) => {
        const layer = example.querySelector<HTMLElement>('[data-screen-pointer-layer]')!;
        const arrow = layer.querySelector<SVGElement>('[data-screen-pointer]')!;
        const box = layer.getBoundingClientRect(), tip = arrow.getBoundingClientRect();
        const scale = Math.min(box.width / 800, box.height / 600);
        return { example: example.dataset.example, actor: arrow.dataset.actor,
          x: tip.x, y: tip.y, expectedX: box.x + (box.width - 800 * scale) / 2 + expected.x * scale,
          expectedY: box.y + (box.height - 600 * scale) / 2 + expected.y * scale };
      }), point);
      for (const position of positions) { expect(position.x).toBeCloseTo(position.expectedX, 1); expect(position.y).toBeCloseTo(position.expectedY, 1); }
      checks.push({ name: 'input in three viewports with ancestor scale', positions });
      const frame = page.frames().find((entry) => entry.url().endsWith('/sample-input-frame'))!;
      await frame.focus('input');
      await runtime.page.typeText('Sample iframe');
      await vi.waitFor(() => expect(automation.getCurrentScreenPointer()?.target).toMatchObject({ x: 194, y: 454 }));
      await frame.goto(`${baseUrl}/sample-input-frame`);
      await vi.waitFor(() => expect(automation.getCurrentScreenPointer()?.target).toBeUndefined());
      checks.push({ name: 'iframe navigation removes its old target', pointer: automation.getCurrentScreenPointer() });
      await runtime.page.fill({ css: '#sample-area' }, 'Example removable input');
      const retained = automation.getCurrentScreenPointer()!.target!;
      await builtin.evaluateScript({ browserId: BROWSER_ID, function: "() => document.querySelector('#sample-area').remove()" });
      await vi.waitFor(() => expect(automation.getCurrentScreenPointer()?.target).toBeUndefined());
      await awaitOperationPoint(display, retained);
      checks.push({ name: 'removed control keeps only position', pointer: automation.getCurrentScreenPointer() });
      events.length = 0;
      const classes: Array<[string, () => Promise<unknown>]> = [
        ['snapshot', () => builtin.takeSnapshot({ browserId: BROWSER_ID })],
        ['currentPage', () => runtime.page.currentPage()],
        ['wait', () => runtime.page.waitFor({ text: 'Example chooser' })],
        ['extractText', () => runtime.page.extractText({ locator: { css: '#sample-chooser' } })],
        ['extractList', () => runtime.page.extractList({ items: { css: 'button' }, fields: { label: { text: 'self' } } })],
        ['console', () => builtin.listConsoleMessages({ browserId: BROWSER_ID })],
        ['network', () => builtin.listNetworkRequests({ browserId: BROWSER_ID })],
        ['cookie read', () => builtin.getAllCookies({ browserId: BROWSER_ID })],
        ['cookie write', () => builtin.setCookies({ browserId: BROWSER_ID, cookies: [{ name: 'sample_cookie', value: 'sample-value', url: baseUrl }] })],
        ['cookie delete', () => builtin.deleteCookies({ browserId: BROWSER_ID, cookies: [{ name: 'sample_cookie', url: baseUrl }] })],
        ['cookie clear', () => builtin.clearCookies({ browserId: BROWSER_ID })],
        ['window read', () => builtin.getWindowBounds({ browserId: BROWSER_ID })],
        ['window write', () => builtin.setWindowBounds({ browserId: BROWSER_ID, bounds: { width: 900, height: 700 } })],
        ['script read', () => builtin.evaluateScript({ browserId: BROWSER_ID, function: "() => 'Sample read result'" })],
      ];
      for (const [name, action] of classes) {
        const source = automation.getCurrentScreenPointer()!;
        await action();
        expect(automation.getCurrentScreenPointer()).toMatchObject({ page: source.page, seq: source.seq, timestamp: source.timestamp, x: source.x, y: source.y });
        expect(events.filter((event) => event.type === 'pointer')).toEqual([]);
        checks.push({ name, pointer: automation.getCurrentScreenPointer(), nativeCount: 0 });
      }
      await page.evaluate(() => { setTimeout(() => alert('Sample dialog'), 0); });
      await vi.waitFor(() => expect(() => automation.throwIfDialogOpen()).toThrow());
      await builtin.handleDialog({ browserId: BROWSER_ID, action: 'accept' });
      expect(() => automation.throwIfDialogOpen()).not.toThrow();
      expect(events.filter((event) => event.type === 'pointer')).toEqual([]);
      checks.push({ name: 'native dialog has state only', pointer: automation.getCurrentScreenPointer() });
      evidence['operation-viewports-and-states'] = checks;
    } finally { await display.close(); }
  }, 25_000);

  it('compares builtin UID and generated click/hover/double-click with real pointer and mouse events', async () => {
    const runtime = generated();
    const builtinClick = await checkOperation('builtin-click', () => clickBuiltin('Sample click'));
    expect(builtinClick.observed.find((item) => item.action === 'down')).toMatchObject({ x: 240, y: 130 });
    await checkOperation('generated-click', () => runtime.page.click({ css: '#sample-click' }));
    await checkOperation('generated-hover', () => runtime.page.hover({ css: '#sample-double' }));
    const double = await checkOperation('generated-double-click', () => runtime.page.doubleClick({ css: '#sample-double' }));
    expect(double.observed.filter((item) => item.action === 'down').map((item) => item.clickCount)).toEqual([1, 2]);
    expect(double.received.some((item) => item.type === 'dblclick' && item.detail === 2)).toBe(true);
    events.length = 0;
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('#sample-click')!.click());
    await page.keyboard.press('Tab');
    expect(events.filter((event) => event.type === 'pointer')).toEqual([]);
  }, 20_000);

  it('observes ordinary UID drag, offscreen auto-scroll and main-frame coordinates for an iframe UID click', async () => {
    const snapshot = await automation.takeSnapshot();
    const source = [...snapshot.idToNode.values()].find((node) => node.name === 'Sample source')!;
    const target = [...snapshot.idToNode.values()].find((node) => node.name === 'Sample target')!;
    const drag = await checkOperation('ordinary-drag', () => builtin.drag({ browserId: BROWSER_ID, fromUid: source.id, toUid: target.id }));
    expect(drag.observed.some((item) => item.action === 'move' && item.buttons === 1)).toBe(true);
    expect(drag.observed.at(-1)).toMatchObject({ action: 'up', x: 500, y: 375, buttons: 0 });
    await checkOperation('builtin-offscreen-click', () => clickBuiltin('Sample offscreen'));
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
    await page.evaluate(() => scrollTo(0, 0));
    events.length = 0;
    const frame = page.frames().find((entry) => entry !== page.mainFrame())!;
    await frame.evaluate(() => { (window as unknown as SampleUiWindow).sampleEvents = []; });
    await clickBuiltin('Sample frame button');
    const iframeEvents = await frame.evaluate(() => (window as unknown as SampleUiWindow).sampleEvents);
    const down = events.find((event) => event.type === 'pointer' && event.pointer.action === 'down') as Extract<BrowserScreenEvent, { type: 'pointer' }>;
    const rect = await page.$eval('iframe', (element) => ({ x: element.getBoundingClientRect().x + element.clientLeft, y: element.getBoundingClientRect().y + element.clientTop }));
    const received = iframeEvents.find((event) => event.type === 'pointerdown')!;
    expect(down.pointer.x).toBeCloseTo(rect.x + received.x);
    expect(down.pointer.y).toBeCloseTo(rect.y + received.y);
    evidence['iframe-click'] = { observed: down.pointer, received, iframeOffset: rect };
  }, 20_000);

  it('measures a real scaled capture and bitmap independently at DPR 2 and page scale 1.25', async () => {
    const caster = new ScreenCaster(page, { maxWidth: 400, maxHeight: 300 }, automation.getScreenTarget().identity);
    const frames: ScreencastFrame[] = [];
    caster.on('frame', (frame) => frames.push(frame));
    await caster.start();
    try {
      await page.mouse.move(240, 130);
      await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
      const session = await page.createCDPSession();
      await session.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.25 });
      await vi.waitFor(() => expect(frames.some((frame) => frame.mapping?.scale === 1.25)).toBe(true));
      const frame = frames.find((entry) => entry.mapping?.scale === 1.25)!;
      const bitmap = await page.evaluate(async (data) => {
        const bytes = Uint8Array.from(atob(data), (letter) => letter.charCodeAt(0));
        const image = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
        const result = { width: image.width, height: image.height }; image.close(); return result;
      }, frame.data);
      expect(frame.deviceWidth).toBe(800);
      expect(frame.deviceHeight).toBe(600);
      expect(bitmap).toEqual({ width: 400, height: 300 });
      await checkOperation('scaled-generated-click', () => generated().page.click({ css: '#sample-click' }));
      evidence['scaled-capture'] = { metadata: { ...frame, data: undefined }, bitmap, dpr: await page.evaluate(() => devicePixelRatio) };
      await session.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
      await session.detach();
    } finally { await caster.stop(); }
  }, 10_000);

  it('resets the stream on new-tab selection, navigation and real transport recovery', async () => {
    const messages: StreamServerMessage[] = [];
    const sink: ViewerSink = { isOpen: () => true, send: (message) => messages.push(message) };
    await hub.addViewer(BROWSER_ID, sink);
    const first = automation.getScreenTarget().identity;
    await clickBuiltin('Sample new tab');
    const pages = await generated().listPages();
    const nextIndex = pages.find((entry) => !entry.selected && entry.url.endsWith('/sample-next'))!.pageIdx;
    await generated().selectPage(nextIndex);
    const selected = automation.getScreenTarget().identity;
    expect(selected.pageId).not.toBe(first.pageId);
    expect(messages.filter((message) => message.type === 'screen-state').at(-1)).toMatchObject({ page: selected, pointer: { origin: 'initial', action: 'initialize', x: 24, y: 24 } });
    // The lock preserves call order; capture stop/start can still be awaiting CDP between selections.
    const frameCountBeforeSwitch = messages.filter((message) => message.type === 'frame').length;
    const firstIndex = pages.find((entry) => entry.url.endsWith('/sample'))!.pageIdx;
    await Promise.all([generated().selectPage(firstIndex), generated().selectPage(nextIndex), generated().selectPage(firstIndex)]);
    const returned = automation.getScreenTarget().identity;
    expect(returned.pageId).toBe(first.pageId);
    await vi.waitFor(() => {
      const frames = messages.filter((message) => message.type === 'frame');
      expect(frames.length).toBeGreaterThan(frameCountBeforeSwitch);
      expect(frames.at(-1)).toMatchObject({ meta: { page: returned } });
    }, { timeout: 5_000 });
    await generated().page.navigate(`${baseUrl}/sample-navigation`);
    const navigated = automation.getScreenTarget().identity;
    expect(navigated.navigationSequence).toBeGreaterThan(selected.navigationSequence);
    await automation.browser.disconnect();
    expect(messages.filter((message) => message.type === 'screen-state').at(-1)).toMatchObject({ page: null, pointer: null });
    const recovered = await BrowserManager.getScreenSession(BROWSER_ID);
    expect(recovered.generation).not.toBe(automation.generation);
    // This is deliberately before the hub's periodic follow tick.
    await recovered.getSelectedPage().mouse.move(70, 90);
    await vi.waitFor(() => expect(messages.filter((message) => message.type === 'screen-state').at(-1))
      .toMatchObject({ page: { connectionId: recovered.generation }, pointer: { x: 70, y: 90 } }), { timeout: 5_000 });
    expect(messages.filter((message) => message.type === 'screen-state').at(-1))
      .toMatchObject({ page: recovered.getScreenTarget().identity, pointer: { x: 70, y: 90 } });
    let current: import('@shared/types/stream.js').ScreenPageIdentity | null = null;
    for (const message of messages) {
      if (message.type === 'screen-state') current = message.page;
      if (message.type === 'frame') expect(sameScreenPage(message.meta.page, current)).toBe(true);
    }
    evidence['page-lifecycle'] = { first, selected, returned, navigated, recovered: recovered.getScreenTarget().identity };
  }, 20_000);

  it('paints six moving clicks on the old frame and retains a static real pointer on every new same-Page frame', async () => {
    const display = await browser.newPage();
    display.setDefaultTimeout(7_000);
    await display.setViewport({ width: 1280, height: 820, deviceScaleFactor: 1 });
    await display.evaluateOnNewDocument(() => {
      const sample = window as unknown as SampleUiWindow;
      sample.samplePaintRows = [];
      sample.sampleFramePage = null;
      sample.samplePresentedPointer = null;
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          this.addEventListener('message', (event: MessageEvent<ScreenWorkerOutgoingMessage>) => {
            if ((event.data.type === 'viewport-frame' || event.data.type === 'viewport-pointer') && event.data.leaseId === 'viewport-1') {
              if (event.data.type === 'viewport-frame') {
                sample.sampleFramePage = event.data.frame.page;
                sample.samplePresentedPointer = event.data.pointer;
              } else if (event.data.type === 'viewport-pointer') sample.samplePresentedPointer = event.data.pointer;
            }
          });
        }
      };
      const nodes = new WeakMap<Element, number>();
      let nextNode = 1;
      function observe() {
        const layer = document.querySelector('[data-example="inline"] [data-screen-pointer-layer]');
        const arrow = layer?.querySelector('[data-screen-pointer]');
        const ripple = layer?.querySelector('[data-screen-pointer-ripple]');
        if (arrow && !nodes.has(arrow)) nodes.set(arrow, nextNode++);
        const box = layer?.getBoundingClientRect();
        const scale = box ? Math.min(box.width / 800, box.height / 600) : 1;
        sample.samplePaintRows.push({ at: Date.now(), frame: sample.sampleFramePage, pointer: sample.samplePresentedPointer,
          x: arrow && box ? (Number.parseFloat((arrow as SVGElement).style.left) - (box.width - 800 * scale) / 2) / scale : null,
          y: arrow && box ? (Number.parseFloat((arrow as SVGElement).style.top) - (box.height - 600 * scale) / 2) / scale : null,
          arrowNode: arrow ? nodes.get(arrow)! : null,
          arrowOpacity: arrow ? Number(getComputedStyle(arrow).opacity) : 0,
          rippleOpacity: ripple ? Number(getComputedStyle(ripple).opacity) : 0 });
        requestAnimationFrame(observe);
      }
      requestAnimationFrame(observe);
    });
    try {
      await display.goto(`${baseUrl}/sample-ui`);
      const rounds = [];
      for (let round = 0; round < 6; round += 1) {
        if (round > 0) await page.goto(`${baseUrl}/sample`);
        const oldPage = automation.getScreenTarget().identity;
        await display.waitForFunction((expected) => {
          const current = (window as unknown as SampleUiWindow).sampleFramePage;
          return current?.connectionId === expected.connectionId && current.pageId === expected.pageId
            && current.navigationSequence === expected.navigationSequence;
        }, { polling: 'raf' }, oldPage);
        await page.mouse.move(120, 280);
        await display.waitForFunction(() => {
          const row = (window as unknown as SampleUiWindow).samplePaintRows.at(-1);
          return row?.x !== null && Math.abs(row!.x! - 120) < 0.01;
        }, { polling: 'raf' });
        await display.evaluate(() => { (window as unknown as SampleUiWindow).samplePaintRows = []; });
        events.length = 0;
        await Promise.all([page.waitForNavigation(), page.locator('#sample-nav').click()]);
        const nextPage = automation.getScreenTarget().identity;
        await display.waitForFunction((expected) => {
          const current = (window as unknown as SampleUiWindow).sampleFramePage;
          return current?.navigationSequence === expected.navigationSequence
            && (window as unknown as SampleUiWindow).samplePaintRows.some((row) => row.frame?.navigationSequence === expected.navigationSequence);
        }, { polling: 'raf' }, nextPage);
        await new Promise((yes) => setTimeout(yes, 150));
        const rows = await display.evaluate(() => (window as unknown as SampleUiWindow).samplePaintRows);
        const visible = rows.filter((row) => row.arrowOpacity > 0.05);
        const rings = rows.filter((row) => row.rippleOpacity > 0.05);
        expect(visible.length).toBeGreaterThanOrEqual(8);
        expect(rings.length).toBeGreaterThanOrEqual(8);
        expect(visible.filter((row) => row.x! > 120.01 && row.x! < 489.99).length).toBeGreaterThanOrEqual(3);
        expect(new Set(visible.map((row) => row.arrowNode)).size).toBe(1);
        expect(rings.every((row) => Math.abs(row.x! - 490) < 0.01 && Math.abs(row.y! - 125) < 0.01)).toBe(true);
        expect(visible.at(-1)!.at - visible[0]!.at).toBeGreaterThanOrEqual(120);
        expect(rings.every((row) => sameScreenPage(row.frame, oldPage))).toBe(true);
        const newRows = rows.filter((row) => sameScreenPage(row.frame, nextPage));
        const observed = events.filter((event): event is Extract<BrowserScreenEvent, { type: 'pointer' }> => event.type === 'pointer');
        expect(observed).toHaveLength(3);
        const original = observed.at(-1)!.pointer;
        expect(newRows.length).toBeGreaterThanOrEqual(5);
        for (const row of newRows) {
          expect(row.arrowOpacity).toBeGreaterThan(0.9);
          expect(row.rippleOpacity).toBe(0);
          expect(row.x).toBeCloseTo(original.x, 2);
          expect(row.y).toBeCloseTo(original.y, 2);
          expect(row.pointer).toMatchObject({ page: original.page, framePage: nextPage,
            seq: original.seq, timestamp: original.timestamp, x: original.x, y: original.y });
          expect(row.pointer!.press).toBeUndefined();
        }
        expect(automation.getCurrentScreenPointer()).toMatchObject({ page: original.page, seq: original.seq, timestamp: original.timestamp, x: original.x, y: original.y });
        const targetAt = rows.find((row) => sameScreenPage(row.frame, nextPage))?.at;
        expect(targetAt).toBeDefined();
        expect(targetAt! - visible[0]!.at).toBeLessThan(SCREEN_POINTER_POLICY.navigationMaxDelayMs + 100);
        rounds.push({ oldPage, nextPage, original, rows });
      }
      evidence['short-click-navigation-visibility'] = rounds;
    } finally { await display.close(); }
  }, 20_000);

  it('keeps the same Mouse object and verifies its retained position with a real press after navigation, without another move', async () => {
    const mouse = page.mouse;
    await mouse.move(340, 280);
    const original = automation.getCurrentScreenPointer()!;
    const sourceAt = original.timestamp;
    events.length = 0;
    await page.goto(`${baseUrl}/sample-navigation`);
    expect(page.mouse).toBe(mouse);
    expect(automation.getCurrentScreenPointer()).toMatchObject({ page: original.page, seq: original.seq, timestamp: original.timestamp, x: original.x, y: original.y });
    expect(original.page.navigationSequence).toBeLessThan(automation.getScreenTarget().identity.navigationSequence);
    expect(events.filter((event) => event.type === 'pointer')).toHaveLength(0);
    await page.evaluate(() => { (window as unknown as SampleUiWindow).sampleEvents = []; });
    await mouse.down();
    await mouse.up();
    const received = await page.evaluate(() => (window as unknown as SampleUiWindow).sampleEvents);
    const down = received.find((event) => event.type === 'pointerdown')!;
    expect(down).toMatchObject({ x: 340, y: 280, buttons: 1 });
    const observed = events.filter((event): event is Extract<BrowserScreenEvent, { type: 'pointer' }> => event.type === 'pointer');
    expect(observed).toHaveLength(2);
    expect(observed[0]!.pointer.press!.page).toEqual(automation.getScreenTarget().identity);
    expect(original.timestamp).toBe(sourceAt);
    evidence['same-Page-Mouse-position'] = { original, current: automation.getCurrentScreenPointer(), received };
  });

  it('keeps an idle current position for late fullscreen and hidden restoration without replaying expired rings', async () => {
    const display = await browser.newPage();
    display.setDefaultTimeout(7_000);
    await display.setViewport({ width: 1280, height: 820, deviceScaleFactor: 2 });
    try {
      await display.goto(`${baseUrl}/sample-ui`);
      await display.waitForFunction(() => document.querySelectorAll('[data-example] canvas[data-visible="true"]').length === 3);
      await page.locator('#sample-click').click();
      await display.waitForFunction(() => document.querySelectorAll('[data-example] [data-screen-pointer]').length === 3);
      await new Promise((yes) => setTimeout(yes, 5100));
      expect(await display.$$eval('[data-example] [data-screen-pointer]', (arrows) => arrows.map((arrow) => Number(getComputedStyle(arrow).opacity)))).toEqual([0.95, 0.95, 0.95]);
      expect(await display.$$('[data-screen-pointer-ripple]')).toHaveLength(0);
      await display.evaluate(() => (window as unknown as SampleUiWindow).sampleUi.fullscreen(true));
      await display.waitForFunction(() => !!document.querySelector('dialog[open] [data-screen-pointer]'));
      expect(await display.$$('dialog[open] [data-screen-pointer-ripple]')).toHaveLength(0);
      await display.evaluate(() => {
        (window as unknown as SampleUiWindow).sampleUi.fullscreen(false);
        (window as unknown as SampleUiWindow).sampleUi.hidden(true);
      });
      await display.waitForFunction(() => !document.querySelector('[data-example="scaled"] [data-screen-pointer]'));
      await page.mouse.click(500, 280);
      await display.waitForFunction(() => {
        const layer = document.querySelector<HTMLElement>('[data-example="inline"] [data-screen-pointer-layer]')!;
        const arrow = layer.querySelector<SVGElement>('[data-screen-pointer]');
        const scale = Math.min(layer.clientWidth / 800, layer.clientHeight / 600);
        return arrow && Math.abs(Number.parseFloat(arrow.style.left) - (layer.clientWidth - 800 * scale) / 2 - 500 * scale) < 0.01;
      });
      await display.evaluate(() => (window as unknown as SampleUiWindow).sampleUi.hidden(false));
      await display.waitForFunction(() => {
        const layer = document.querySelector<HTMLElement>('[data-example="scaled"] [data-screen-pointer-layer]')!;
        const arrow = layer.querySelector<SVGElement>('[data-screen-pointer]');
        const scale = Math.min(layer.clientWidth / 800, layer.clientHeight / 600);
        return arrow && Math.abs(Number.parseFloat(arrow.style.left) - (layer.clientWidth - 800 * scale) / 2 - 500 * scale) < 0.01;
      });
      expect(await display.$$('[data-example="scaled"] [data-screen-pointer-ripple]')).toHaveLength(0);
      expect(await display.evaluate(() => (window as unknown as SampleUiWindow).sampleState.errors)).toEqual([]);
      evidence['idle-late-hidden'] = { position: automation.getCurrentScreenPointer(), idleMs: 5100, oldRingReplayed: false };
    } finally { await display.close(); }
  }, 20_000);

  it('renders production viewports/Worker at DPR 2 with exact tip positions, scrolling, ancestor scale and fullscreen', async () => {
    const display = await browser.newPage();
    display.setDefaultTimeout(7_000);
    await display.setViewport({ width: 1280, height: 820, deviceScaleFactor: 1 });
    await display.goto(`${baseUrl}/sample-ui`);
    await display.waitForFunction(() => document.querySelectorAll('[data-example] canvas[data-visible="true"]').length === 3);
    const retained = automation.getCurrentScreenPointer();
    expect(await display.$$('[data-screen-pointer]')).toHaveLength(retained ? 3 : 0);
    expect(await display.$$('[data-screen-pointer-ripple]')).toHaveLength(0);
    const runtime = generated();
    await runtime.page.click({ css: '#sample-click' });
    await display.waitForFunction(() => document.querySelectorAll('[data-example] [data-screen-pointer]').length === 3);
    const sourcePoint = events.filter((event): event is Extract<BrowserScreenEvent, { type: 'pointer' }> => event.type === 'pointer').at(-1)!.pointer;
    await display.waitForFunction((point) => [...document.querySelectorAll<HTMLElement>('[data-example]')].every((example) => {
      const layer = example.querySelector<HTMLElement>('[data-screen-pointer-layer]')!;
      const arrow = layer.querySelector<SVGElement>('[data-screen-pointer]');
      if (!arrow) return false;
      const rect = layer.getBoundingClientRect();
      const scale = Math.min(rect.width / 800, rect.height / 600);
      const tip = arrow.getBoundingClientRect();
      return Math.abs(tip.x - rect.left - (rect.width - 800 * scale) / 2 - point.x * scale) < 0.1
        && Math.abs(tip.y - rect.top - (rect.height - 600 * scale) / 2 - point.y * scale) < 0.1;
    }), { polling: 'raf' }, sourcePoint);
    async function assertPositions() {
      const result = await display.evaluate((point) => [...document.querySelectorAll<HTMLElement>('[data-example]')].map((example) => {
        const layer = example.querySelector<HTMLElement>('[data-screen-pointer-layer]')!;
        const arrow = example.querySelector<SVGElement>('[data-screen-pointer]')!;
        const canvas = example.querySelector('canvas')!;
        const rect = layer.getBoundingClientRect();
        const scale = Math.min(rect.width / 800, rect.height / 600);
        const tip = arrow.getBoundingClientRect();
        const hit = document.elementFromPoint(tip.x, tip.y);
        return { intercepts: !!hit && layer.contains(hit), example: example.dataset.example, x: arrow.getBoundingClientRect().x, y: arrow.getBoundingClientRect().y,
          expectedX: rect.left + (rect.width - 800 * scale) / 2 + point.x * scale,
          expectedY: rect.top + (rect.height - 600 * scale) / 2 + point.y * scale,
          pointerEvents: getComputedStyle(layer).pointerEvents, bitmap: { width: canvas.width, height: canvas.height } };
      }), sourcePoint);
      for (const item of result) {
        expect(item.x).toBeCloseTo(item.expectedX, 1);
        expect(item.y).toBeCloseTo(item.expectedY, 1);
        expect(item.pointerEvents).toBe('none');
        expect(item.intercepts).toBe(false);
      }
      return result;
    }
    const positions = await assertPositions();
    expect(await page.evaluate(() => devicePixelRatio)).toBe(2);
    expect(positions.every((item) => item.bitmap.width > 0 && item.bitmap.height > 0)).toBe(true);
    await display.evaluate(() => {
      const panel = document.querySelector('[data-example="scroll"]')!;
      const layer = panel.querySelector('[data-screen-pointer-layer]')!;
      (layer.parentElement!.parentElement as HTMLElement).scrollLeft = 90;
      (document.querySelector('[data-example="inline"]') as HTMLElement).style.width = '420px';
    });
    await vi.waitFor(async () => { await assertPositions(); });
    if (process.env.PISKIE_POINTER_EVIDENCE_DIR) await display.screenshot({ path: join(process.env.PISKIE_POINTER_EVIDENCE_DIR, 'viewports.png') });
    // Keep the press held so a real dragging pointer remains visible in the fullscreen screenshot.
    await page.mouse.move(240, 130);
    await page.mouse.down();
    await display.evaluate(() => (window as unknown as SampleUiWindow).sampleUi.fullscreen(true));
    // A static screencast has no new frame for a just-attached lease. Trigger a real repaint.
    await page.evaluate(() => { document.body.style.backgroundColor = '#edf4f9'; });
    await display.waitForFunction(() => !!document.querySelector('dialog[open] [data-screen-pointer]'));
    const fullscreen = await display.evaluate(() => {
      const layer = document.querySelector<HTMLElement>('dialog[open] [data-screen-pointer-layer]')!;
      const arrow = layer.querySelector('svg')!;
      const rect = layer.getBoundingClientRect();
      const scale = Math.min(rect.width / 800, rect.height / 600);
      return { x: arrow.getBoundingClientRect().x, y: arrow.getBoundingClientRect().y,
        expectedX: rect.left + (rect.width - 800 * scale) / 2 + 240 * scale,
        expectedY: rect.top + (rect.height - 600 * scale) / 2 + 130 * scale };
    });
    expect(fullscreen.x).toBeCloseTo(fullscreen.expectedX, 1);
    expect(fullscreen.y).toBeCloseTo(fullscreen.expectedY, 1);
    await display.waitForFunction(() => {
      const dialog = document.querySelector('dialog[open]')!;
      return getComputedStyle(dialog).opacity === '1' && getComputedStyle(dialog.querySelector('canvas')!).opacity === '1';
    });
    if (process.env.PISKIE_POINTER_EVIDENCE_DIR) await display.screenshot({ path: join(process.env.PISKIE_POINTER_EVIDENCE_DIR, 'fullscreen.png') });
    await page.mouse.up();
    await display.waitForFunction(() => [...document.querySelectorAll<SVGElement>('dialog[open] [data-screen-pointer]')]
      .every((arrow) => arrow.getAttribute('data-pressed') === 'false' && Number(getComputedStyle(arrow).opacity) > 0.9));
    await new Promise((yes) => setTimeout(yes, 1300));
    expect(await display.$$eval('dialog[open] [data-screen-pointer]', (arrows) => arrows.map((arrow) => Number(getComputedStyle(arrow).opacity)))).toEqual([0.95]);
    expect(await display.evaluate(() => (window as unknown as SampleUiWindow).sampleState.errors)).toEqual([]);
    evidence['production-ui'] = { positions, fullscreen, dpr: await page.evaluate(() => devicePixelRatio),
      boundary: 'Real manager/session/mouse/CDP/caster/hub and browser DOM/Worker/OffscreenCanvas/components; desktop handshake bridged with local SSE/MessageChannel.' };
    await display.close();
  }, 30_000);
});
