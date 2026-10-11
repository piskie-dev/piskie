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
  samplePresentedPointer: PresentedScreenPointer | null;
  sampleEvents: ReceivedMouse[];
  sampleState: { messages: StreamServerMessage[]; errors: string[] };
  sampleUi: { fullscreen(open: boolean): void; hidden(hidden: boolean): void; close(): Promise<void> };
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
      const type = { move: 'pointermove', down: 'pointerdown', up: 'pointerup' }[action.action];
      expect(received.some((event) => event.type === type && Math.abs(event.x - action.x) < 1
        && Math.abs(event.y - action.y) < 1 && event.buttons === action.buttons), `${name}: ${action.action} ${action.x},${action.y}`).toBe(true);
      expect(sameScreenPage(action.page, automation.getScreenTarget().identity)).toBe(true);
    }
    expect(observed.length).toBeGreaterThan(0);
    evidence[name] = { observed, received };
    return { observed, received };
  }

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
    expect(messages.filter((message) => message.type === 'screen-state').at(-1)).toMatchObject({ page: selected, pointer: null });
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
        expect(automation.getCurrentScreenPointer()).toBe(original);
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
    expect(automation.getCurrentScreenPointer()).toBe(original);
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
