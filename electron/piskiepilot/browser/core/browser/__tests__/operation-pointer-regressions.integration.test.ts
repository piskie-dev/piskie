import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type Browser, type CDPSession, type ElementHandle, type Page } from 'puppeteer-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserAutomationSession } from '../../session/browser-automation-session.js';
import { readOperationTarget } from '../../session/operation-target.js';
import { ScreenCaster, type ScreencastFrame, type SuccessfulScreenInput } from '../screen-caster.js';

const controlHtml = `<!doctype html><style>body{margin:0}input{position:absolute;left:80px;top:60px;width:100px;height:40px;box-sizing:border-box}</style>
<input id="sample-control"><script>window.sampleEvents=[];for(const type of ['pointermove','pointerdown','pointerup'])document.addEventListener(type,e=>sampleEvents.push({type,x:e.clientX,y:e.clientY}),true);</script>`;
const scaledCases = [
  { name: 'plain visible', css: '', left: 120, border: 0, rect: { x: 170, y: 70, width: 60, height: 30 } },
  { name: 'scale two visible', css: 'transform:scale(2);transform-origin:0 0;', left: 120, border: 0, rect: { x: 290, y: 90, width: 120, height: 60 } },
  { name: 'scale half visible', css: 'transform:scale(.5);transform-origin:0 0;', left: 120, border: 0, rect: { x: 110, y: 60, width: 30, height: 15 } },
  { name: 'scale two fully clipped', css: 'transform:scale(2);transform-origin:0 0;', left: 210, border: 0, rect: null },
  { name: 'scale half fully clipped', css: 'transform:scale(.5);transform-origin:0 0;', left: 210, border: 0, rect: null },
  { name: 'zoom two visible', css: 'zoom:2;', left: 120, border: 0, rect: { x: 340, y: 140, width: 120, height: 60 } },
  { name: 'zoom half visible', css: 'zoom:.5;', left: 120, border: 0, rect: { x: 85, y: 35, width: 30, height: 15 } },
  { name: 'zoom two fully clipped', css: 'zoom:2;', left: 210, border: 0, rect: null },
  { name: 'zoom half fully clipped', css: 'zoom:.5;', left: 210, border: 0, rect: null },
  { name: 'scale two border partial', css: 'transform:scale(2);transform-origin:0 0;', left: 180, border: 10, rect: { x: 430, y: 110, width: 40, height: 60 } },
  { name: 'scale half border partial', css: 'transform:scale(.5);transform-origin:0 0;', left: 180, border: 10, rect: { x: 145, y: 65, width: 10, height: 15 } },
  { name: 'zoom two border partial', css: 'zoom:2;', left: 180, border: 10, rect: { x: 480, y: 160, width: 40, height: 60 } },
  { name: 'zoom half border partial', css: 'zoom:.5;', left: 180, border: 10, rect: { x: 120, y: 40, width: 10, height: 15 } },
  { name: 'scale and zoom border visible', css: 'zoom:2;transform:scale(.5);transform-origin:0 0;', left: 120, border: 10, rect: { x: 230, y: 130, width: 60, height: 30 } },
];

interface SampleWindow extends Window { sampleEvents: Array<{ type: string; x: number; y: number }> }

describe.skipIf(!process.env.FP_CHROMIUM_PATH)('real Chromium operation pointer boundary regressions', () => {
  let browser: Browser;
  let root: string;
  let page: Page;
  let session: BrowserAutomationSession | undefined;
  let caster: ScreenCaster | undefined;
  const evidence: Record<string, unknown> = {};
  beforeAll(async () => {
    root = await mkdtemp(join(process.env.PISKIE_TEST_ARTIFACT_DIR ?? tmpdir(), 'sample-pointer-boundaries-'));
    browser = await puppeteer.launch({ executablePath: process.env.FP_CHROMIUM_PATH, headless: true,
      userDataDir: join(root, 'sample-profile'), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  }, 20_000);
  beforeEach(async () => { page = await browser.newPage(); await page.setViewport({ width: 800, height: 600 }); });
  afterEach(async () => { await caster?.stop(); caster = undefined; session?.dispose(); session = undefined; await page.close(); vi.restoreAllMocks(); });
  afterAll(async () => {
    await browser?.close();
    if (root) await rm(root, { recursive: true, force: true });
    if (process.env.PISKIE_POINTER_EVIDENCE_DIR) {
      await mkdir(process.env.PISKIE_POINTER_EVIDENCE_DIR, { recursive: true });
      await writeFile(join(process.env.PISKIE_POINTER_EVIDENCE_DIR, 'p2-live-evidence.json'), JSON.stringify(evidence, null, 2));
    }
  });

  it.each(scaledCases)('clips webpage geometry in visual CSS pixels: $name', async (scenario) => {
    await page.setContent(`<!doctype html><style>body{margin:0}#sample-clip{position:absolute;left:50px;top:50px;width:200px;height:100px;border:${scenario.border}px solid;overflow:hidden;${scenario.css}}
    #sample-control{position:absolute;left:${scenario.left}px;top:20px;width:60px;height:30px;box-sizing:border-box}</style><div id="sample-clip"><input id="sample-control"></div>`);
    const handle = (await page.$('#sample-control'))!;
    try {
      const feedback = await readOperationTarget(handle);
      const dom = await handle.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { rect: rect.toJSON(), centerHit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === element };
      });
      evidence[scenario.name] = { feedback, dom, expected: scenario.rect };
      if (!scenario.rect) { expect(feedback).toBeNull(); expect(dom.centerHit).toBe(false); return; }
      expect(feedback?.rect).toEqual(scenario.rect);
      expect(await handle.evaluate((element, point) => document.elementFromPoint(point.x, point.y) === element, feedback!)).toBe(true);
    } finally { await handle.dispose(); }
  });

  it('preserves fractional layout sizes while clipping a webpage scale', async () => {
    await page.setContent('<!doctype html><style>body{margin:0}#sample-clip{position:absolute;left:50px;top:50px;width:200.5px;height:100.25px;overflow:hidden;transform:scale(2);transform-origin:0 0}input{position:absolute;left:180.25px;top:20.125px;width:60.5px;height:30.25px;box-sizing:border-box}</style><div id="sample-clip"><input></div>');
    const handle = (await page.$('input'))!;
    try {
      const feedback = await readOperationTarget(handle);
      expect(feedback?.rect).toEqual({ x: 410.5, y: 90.25, width: 40.5, height: 60.5 });
      expect(await handle.evaluate((element, point) => document.elementFromPoint(point.x, point.y) === element, feedback!)).toBe(true);
      evidence.fractional = feedback;
    } finally { await handle.dispose(); }
  });

  it.each(['transform:scale(2);transform-origin:0 0;', 'zoom:2;', 'transform:scale(.5);transform-origin:0 0;', 'zoom:.5;'])
    ('maps scaled iframe content, padding and borders to the main frame: %s', async (css) => {
      await page.setContent(`<!doctype html><style>body{margin:0}iframe{position:absolute;left:50px;top:50px;width:200px;height:100px;border:10px solid;padding:4px;${css}}</style><iframe></iframe>`);
      const frame = page.frames().find((entry) => entry.parentFrame())!;
      await frame.setContent('<!doctype html><style>body{margin:0}input{position:absolute;left:180px;top:20px;width:60px;height:30px;box-sizing:border-box}</style><input id="sample-control">');
      const handle = (await frame.$('input'))!;
      try {
        const feedback = await readOperationTarget(handle);
        const scale = css.includes('2') ? 2 : .5;
        const origin = css.startsWith('zoom') ? 50 * scale : 50;
        const expected = { x: origin + 194 * scale, y: origin + 34 * scale, width: 20 * scale, height: 30 * scale };
        evidence['iframe ' + css] = { feedback, expected };
        expect(feedback?.rect).toEqual(expected);
        expect(await page.evaluate((point) => document.elementFromPoint(point.x, point.y)?.tagName, feedback!)).toBe('IFRAME');
        expect(await handle.evaluate((element) => document.elementFromPoint(190, 35) === element)).toBe(true);
      } finally { await handle.dispose(); }
    });

  it('clips iframe content through a scaled overflow owner and returns no target when that iframe is fully clipped', async () => {
    await page.setContent('<!doctype html><style>body{margin:0}#sample-clip{position:absolute;left:50px;top:50px;width:200px;height:150px;border:10px solid;overflow:hidden;transform:scale(2);transform-origin:0 0}iframe{position:absolute;left:120px;top:20px;width:100px;height:100px;border:4px solid}</style><div id="sample-clip"><iframe></iframe></div>');
    const frame = page.frames().find((entry) => entry.parentFrame())!;
    await frame.setContent('<!doctype html><style>body{margin:0}input{position:absolute;left:60px;top:20px;width:60px;height:30px;box-sizing:border-box}</style><input>');
    const handle = (await frame.$('input'))!;
    try {
      const visible = await readOperationTarget(handle);
      expect(visible?.rect).toEqual({ x: 438, y: 158, width: 32, height: 60 });
      expect(await page.evaluate((point) => document.elementFromPoint(point.x, point.y)?.tagName, visible!)).toBe('IFRAME');
      await page.$eval('iframe', (element) => { (element as HTMLElement).style.left = '210px'; });
      expect(await readOperationTarget(handle)).toBeNull();
      evidence.iframeAncestorClip = { visible, fullyClipped: null };
    } finally { await handle.dispose(); }
  });

  async function connectFrames(transport?: CDPSession) {
    // Select the controlled Page explicitly; the browser's initial Page remains a separate owner.
    session = await BrowserAutomationSession.create(browser);
    const pages = await session.listPages();
    await session.selectPageByIndex(pages.findIndex((entry) => entry.page === page));
    const frames: ScreencastFrame[] = [];
    if (transport) vi.spyOn(page, 'createCDPSession').mockResolvedValueOnce(transport);
    caster = new ScreenCaster(page, { everyNthFrame: 1 }, session.getScreenTarget()!.identity, () => session!.reserveInputOrder());
    caster.on('error', () => {});
    caster.on('frame', (frame) => {
      frames.push(frame);
      session!.refreshTargetForFrame(frame.page!, { width: frame.deviceWidth, height: frame.deviceHeight,
        scrollX: frame.scrollOffsetX, scrollY: frame.scrollOffsetY, timestamp: frame.timestamp, seq: frames.length });
    });
    caster.on('input', (input) => session!.observeManualInput(input));
    await caster.start();
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
    return frames;
  }
  async function fill() {
    const handle = (await page.$('#sample-control'))!;
    const releases: Array<{ readonly mock: { readonly calls: unknown[][] } }> = [];
    const original = handle.evaluateHandle.bind(handle);
    vi.spyOn(handle, 'evaluateHandle').mockImplementation(async (...args) => {
      const remote = await original(...args);
      const element = remote.asElement();
      if (element) releases.push(vi.spyOn(element as ElementHandle<Element>, 'dispose'));
      return remote;
    });
    try { await session!.input.fill(handle, 'Sample value', 1000, 'reject'); } finally { await handle.dispose(); }
    await vi.waitFor(() => expect(session!.getCurrentScreenPointer()?.target).toBeDefined());
    return releases;
  }

  it('refreshes a moved input on real new pixels even when top-level size and scroll are unchanged', async () => {
    await page.setContent(controlHtml);
    const frames = await connectFrames();
    await page.mouse.move(650, 300);
    const native = structuredClone(session!.getCurrentScreenPointer()!);
    await fill();
    const before = structuredClone(session!.getCurrentScreenPointer()!);
    const count = frames.length;
    await page.$eval('#sample-control', (element) => { (element as HTMLElement).style.left = '280px'; });
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(count));
    await vi.waitFor(() => expect(session!.getCurrentScreenPointer()?.target?.rect.x).toBe(280));
    const after = session!.getCurrentScreenPointer()!;
    expect(after.target).toMatchObject({ x: 330, y: 80, timestamp: before.target!.timestamp, seq: before.target!.seq });
    expect(after).toMatchObject({ page: native.page, seq: native.seq, timestamp: native.timestamp, x: 650, y: 300, origin: 'mouse' });
    expect(Date.now() - before.target!.timestamp).toBeLessThan(700);
    expect(await page.evaluate(() => (window as unknown as SampleWindow).sampleEvents)).toEqual([{ type: 'pointermove', x: 650, y: 300 }]);
    evidence.move = { before, after, frames: frames.slice(count).map(({ data: _data, ...meta }) => meta) };
  });

  it('releases a deleted target on a real frame and retains only the last known position', async () => {
    await page.setContent(controlHtml);
    const frames = await connectFrames();
    const retained = await fill();
    const before = structuredClone(session!.getCurrentScreenPointer()!);
    const count = frames.length;
    await page.$eval('#sample-control', (element) => element.remove());
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(count));
    await vi.waitFor(() => expect(session!.getCurrentScreenPointer()?.target).toBeUndefined());
    expect(session!.getCurrentScreenPointer()?.positionTarget).toMatchObject({ x: 130, y: 80, seq: before.target!.seq });
    expect(retained.length).toBeGreaterThan(0);
    expect(retained.every((release) => release.mock.calls.length === 1)).toBe(true);
    expect(Date.now() - before.target!.timestamp).toBeLessThan(700);
    evidence.remove = { before, after: session!.getCurrentScreenPointer(), retainedReleased: true };
  });

  it('refreshes internal scroll without requiring a main-frame scroll change', async () => {
    await page.setContent(`<!doctype html><style>body{margin:0}#sample-scroll{position:absolute;left:50px;top:50px;width:200px;height:160px;overflow:auto}#sample-content{position:relative;height:400px}input{position:absolute;left:30px;top:60px;width:100px;height:40px;box-sizing:border-box}</style><div id="sample-scroll"><div id="sample-content"><input id="sample-control"></div></div>`);
    const frames = await connectFrames();
    await fill();
    const before = structuredClone(session!.getCurrentScreenPointer()!);
    const count = frames.length;
    await page.$eval('#sample-scroll', (element) => { element.scrollTop = 40; });
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(count));
    await vi.waitFor(() => expect(session!.getCurrentScreenPointer()?.target?.rect.y).toBe(70));
    expect(session!.getCurrentScreenPointer()?.target).toMatchObject({ x: 130, y: 90, scrollY: 0 });
    expect(await page.evaluate(() => scrollY)).toBe(0);
    expect(Date.now() - before.target!.timestamp).toBeLessThan(700);
    evidence.internalScroll = { before, after: session!.getCurrentScreenPointer() };
  });

  it('keeps a newer element position after tab return while accepting an older successful native manual ACK', async () => {
    await page.setContent(controlHtml);
    const transport = await page.createCDPSession();
    await connectFrames(transport);
    const original = transport.send.bind(transport);
    let release!: () => void;
    let arrived!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ack = new Promise<void>((resolve) => { arrived = resolve; });
    const inputs: SuccessfulScreenInput[] = [];
    caster!.on('input', (input) => inputs.push(input));
    let held = true;
    transport.send = async (method, ...args) => {
      const result = await original(method, ...args);
      if (method === 'Input.dispatchMouseEvent' && held) { held = false; arrived(); await gate; }
      return result;
    };
    const manual = caster!.dispatchInput({ kind: 'mouse', type: 'mouseMoved', x: 650, y: 300, buttons: 0 });
    try {
      await ack;
      await fill();
      const ownIndex = session!.getSelectedPageIndex();
      const target = structuredClone(session!.getCurrentScreenPointer()!.target!);
      await session!.selectPageByIndex(0);
      await session!.selectPageByIndex(ownIndex);
      const before = structuredClone(session!.getCurrentScreenPointer()!);
      release();
      await manual;
      const after = session!.getCurrentScreenPointer()!;
      expect(after.positionTarget).toEqual(before.positionTarget);
      expect(after.positionTarget).toMatchObject({ x: target.x, y: target.y, seq: target.seq, timestamp: target.timestamp });
      expect(after.target).toBeUndefined();
      expect(after.activity).toBeUndefined();
      expect(inputs).toHaveLength(1);
      expect(after).toMatchObject({ page: inputs[0]!.identity, seq: inputs[0]!.seq, timestamp: inputs[0]!.timestamp,
        sourceOrder: inputs[0]!.sourceOrder, x: 650, y: 300, actor: 'manual', origin: 'mouse', action: 'move' });
      expect(await page.evaluate(() => (window as unknown as SampleWindow).sampleEvents)).toEqual([{ type: 'pointermove', x: 650, y: 300 }]);
      // A subsequently sent native move legitimately becomes the current display position.
      await caster!.dispatchInput({ kind: 'mouse', type: 'mouseMoved', x: 500, y: 240, buttons: 0 });
      expect(session!.getCurrentScreenPointer()).toMatchObject({ x: 500, y: 240, positionTarget: undefined });
      evidence.lateAck = { target, before, after, subsequent: session!.getCurrentScreenPointer(),
        inputs: inputs.map(({ page: _page, ...input }) => input) };
    } finally { release(); await manual; transport.send = original; }
  });
});
