import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCREEN_POINTER_POLICY, type PresentedScreenPointer } from '@shared/screen-pointer';
import type { ScreenViewportFrame } from '@/domains/screen-feed/worker-protocol';
import { ScreenPointerOverlay } from '../ScreenPointerOverlay';

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
let resized: ResizeObserverCallback;
let reduced = false;
const mediaChanged = new Set<() => void>();
const disconnected = vi.fn();
const observed = new Set<Element>();
const page = { connectionId: 'sample-connection', pageId: 1, navigationSequence: 0 };
const frame = { page, width: 800, height: 600 };
function pointer(seq = 1, x = 200): PresentedScreenPointer {
  return { page, framePage: page, seq, action: 'move', x, y: 120, buttons: 0, clickCount: 0, timestamp: Date.now(), visibleAt: null, pressVisibleAt: null };
}
function click(seq = 3, x = 600): PresentedScreenPointer {
  return { ...pointer(seq, x), action: 'up', clickCount: 1,
    press: { page, seq: seq - 1, x, y: 120, timestamp: Date.now(), clickCount: 1 } };
}
beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resized = callback; }
    observe(element: Element) { observed.add(element); }
    disconnect() { disconnected(); }
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  window.matchMedia = vi.fn(() => ({
    get matches() { return reduced; },
    addEventListener: (_type: string, callback: () => void) => mediaChanged.add(callback),
    removeEventListener: (_type: string, callback: () => void) => mediaChanged.delete(callback),
  }) as unknown as MediaQueryList);
});
beforeEach(() => {
  vi.useFakeTimers();
  reduced = false;
  disconnected.mockClear();
  observed.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
afterAll(() => { dom.window.close(); vi.unstubAllGlobals(); });
async function render(value: PresentedScreenPointer | null, onPresented?: (pointer: PresentedScreenPointer, at: number) => void, painted: ScreenViewportFrame = frame) {
  await act(async () => root.render(createElement(ScreenPointerOverlay, { pointer: value, frame: painted, onPresented })));
}
async function resize(width: number, height: number) {
  await act(async () => resized([{ target: container.querySelector('[data-screen-pointer-layer]')!, contentRect: { width, height } } as ResizeObserverEntry], {} as ResizeObserver));
}
async function advance(ms: number) { await act(async () => { vi.advanceTimersByTime(ms); }); }
function arrow() { return container.querySelector<SVGElement>('[data-screen-pointer]'); }
function ring() { return container.querySelector<HTMLElement>('[data-screen-pointer-ripple]'); }
function x() { return Number.parseFloat(arrow()!.style.left); }

describe('ScreenPointerOverlay', () => {
  it('starts at the first real position, then keeps one arrow through multiple visible motion samples and exact arrival', async () => {
    await render(null);
    await resize(400, 400);
    expect(arrow()).toBeNull();
    await render(pointer());
    const initialArrow = arrow();
    expect(x()).toBe(100);
    expect(arrow()!.style.top).toBe('110px');
    await render(pointer(2, 600));
    expect(arrow()).toBe(initialArrow);
    expect(x()).toBe(100);
    const intermediate = [];
    for (let index = 0; index < 4; index++) { await advance(16); intermediate.push(x()); }
    expect(new Set(intermediate).size).toBe(4);
    expect(intermediate.every((value) => value > 100 && value < 300)).toBe(true);
    await advance(SCREEN_POINTER_POLICY.motionMs);
    expect(x()).toBe(300);
    expect(arrow()).toBe(initialArrow);
    expect(container.querySelector('[data-screen-pointer-layer]')?.getAttribute('aria-hidden')).toBe('true');
    await resize(400.5, 300.375);
    expect(x()).toBe(300.375);
    expect(Number.parseFloat(arrow()!.style.top)).toBeCloseTo(60.075);
    expect(arrow()).toBe(initialArrow);
  });

  it('retargets an in-flight move from its current visible position without visiting the old endpoint', async () => {
    await render(pointer());
    await resize(400, 300);
    await render(pointer(2, 600));
    await advance(32);
    const current = x();
    await render(pointer(3, 80));
    expect(x()).toBe(current);
    await advance(16);
    expect(x()).toBeLessThan(current);
    expect(x()).toBeGreaterThan(40);
    await advance(SCREEN_POINTER_POLICY.motionMs);
    expect(x()).toBe(40);
  });

  it('keeps the cursor after a short click/up and idle beyond both old deadlines, while only the ring expires', async () => {
    await render(click(3, 200));
    await resize(400, 300);
    const initialArrow = arrow();
    expect(ring()).not.toBeNull();
    await advance(6000);
    expect(ring()).toBeNull();
    expect(arrow()).toBe(initialArrow);
    expect(x()).toBe(100);
    expect(arrow()!.getAttribute('data-pressed')).toBe('false');
    await render(null);
    expect(arrow()).toBeNull();
  });

  it('defers the click ring and pressed visual until arrival, including an up before motion completes', async () => {
    await render(pointer());
    await resize(400, 300);
    const down = { ...click(2), action: 'down' as const, buttons: 1, press: { ...click(2).press!, seq: 2 } };
    await render(down);
    await advance(32);
    expect(x()).toBeGreaterThan(100);
    expect(x()).toBeLessThan(300);
    expect(ring()).toBeNull();
    expect(arrow()!.getAttribute('data-pressed')).toBe('false');
    await render({ ...down, seq: 3, action: 'up', buttons: 0 });
    await advance(100);
    expect(x()).toBe(300);
    expect(ring()!.style.left).toBe('300px');
    expect(arrow()!.getAttribute('data-pressed')).toBe('false');
    await advance(SCREEN_POINTER_POLICY.rippleMs);
    expect(ring()).toBeNull();
  });

  it('follows a held drag without dropping its pressed visual and does not replay the original ring', async () => {
    const down = { ...click(2, 200), action: 'down' as const, buttons: 1 };
    await render(down);
    await resize(400, 300);
    await advance(6000);
    await render({ ...down, seq: 3, action: 'move', x: 600, timestamp: Date.now() });
    await advance(32);
    expect(x()).toBeGreaterThan(100);
    expect(x()).toBeLessThan(300);
    expect(arrow()!.getAttribute('data-pressed')).toBe('true');
    expect(ring()).toBeNull();
    await advance(SCREEN_POINTER_POLICY.motionMs);
    expect(x()).toBe(300);
    await render({ ...pointer(4, 600), action: 'up' });
    expect(arrow()!.getAttribute('data-pressed')).toBe('false');
  });

  it('drops a click superseded before arrival instead of queuing feedback at a historical endpoint', async () => {
    await render(pointer());
    await resize(400, 300);
    const pressed = click();
    await render(pressed);
    await advance(16);
    await render({ ...pressed, seq: 4, action: 'move', x: 80 });
    await advance(150);
    expect(x()).toBe(40);
    expect(ring()).toBeNull();
    await render({ ...pressed, seq: 5, action: 'move' });
    await advance(150);
    expect(x()).toBe(300);
    expect(ring()).toBeNull();
  });

  it('maps ongoing motion through new contain geometry without animating a local pixel resize offset', async () => {
    await render(pointer());
    await resize(400, 400);
    await render(pointer(2, 600));
    await advance(32);
    const pageX = x() * 2;
    await resize(800, 300);
    expect(x()).toBeCloseTo(200 + pageX * 0.5);
    expect(arrow()!.style.top).toBe('60px');
    await advance(SCREEN_POINTER_POLICY.motionMs);
    expect(x()).toBe(500);
  });

  it('jumps directly to the target for reduced motion and cancels a running animation when preference changes', async () => {
    reduced = true;
    await render(pointer());
    await resize(400, 300);
    await render(pointer(2, 600));
    expect(x()).toBe(300);
    await act(async () => { reduced = false; mediaChanged.forEach((callback) => callback()); });
    await render(pointer(3, 80));
    await advance(16);
    expect(x()).toBeGreaterThan(40);
    await act(async () => { reduced = true; mediaChanged.forEach((callback) => callback()); });
    expect(x()).toBe(40);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts recent feedback with actual geometry after waiting and preserves its deadline through resize hiding', async () => {
    const onPresented = vi.fn();
    const source = click(3, 200);
    await render(source, onPresented);
    expect(onPresented).not.toHaveBeenCalled();
    await advance(1500);
    await resize(400, 300);
    expect(onPresented.mock.calls.some(([value]) => value.press?.seq === source.press!.seq)).toBe(true);
    expect(ring()).not.toBeNull();
    await advance(100);
    await resize(0, 0);
    await advance(400);
    await resize(400, 300);
    expect(arrow()).not.toBeNull();
    expect(ring()).toBeNull();
  });

  it('shows an old valid position without an expired ring and rejects different page, navigation or connection identities', async () => {
    const old = click(3, 200);
    await render({ ...old, timestamp: Date.now() - 6000, press: { ...old.press!, timestamp: Date.now() - 6000 } });
    await resize(400, 300);
    expect(x()).toBe(100);
    expect(ring()).toBeNull();
    for (const next of [{ ...page, pageId: 2 }, { ...page, navigationSequence: 1 }, { ...page, connectionId: 'sample-recovered' }]) {
      await render({ ...old, page: next, framePage: next });
      expect(arrow()).toBeNull();
      expect(ring()).toBeNull();
    }
  });

  it('keeps the same arrow for a new frame of the same Page, preserves source identity and renders no old-frame ring', async () => {
    const source = click(3, 200);
    await render(source);
    await resize(400, 300);
    const original = arrow();
    expect(ring()).not.toBeNull();
    const next = { ...page, navigationSequence: 1 };
    const presentation = { ...source, framePage: next, press: undefined, pressVisibleAt: null };
    await render(presentation, undefined, { ...frame, page: next });
    expect(arrow()).toBe(original);
    expect(x()).toBe(100);
    expect(ring()).toBeNull();
    expect(presentation.page).toBe(source.page);
    expect(presentation.timestamp).toBe(source.timestamp);
    await render({ ...source, framePage: next }, undefined, { ...frame, page: next });
    expect(arrow()).toBe(original);
    expect(ring()).toBeNull();
  });

  it('shows the display-only initialization on its first painted frame', async () => {
    const initial = { ...pointer(0, 24), y: 24, action: 'initialize' as const, origin: 'initial' as const };
    await render(initial, undefined, { ...frame, page: null });
    await resize(400, 300);
    expect(arrow()).toBeNull();
    await render(initial);
    expect(x()).toBe(12);
    expect(arrow()!.getAttribute('data-origin')).toBe('initial');
    expect(ring()).toBeNull();
  });

  it('moves to a real input target and highlights after arrival without changing the mouse origin or creating a ring', async () => {
    const source = pointer(4, 80);
    await render(source);
    await resize(400, 300);
    const target = { page, seq: 8, timestamp: Date.now(), kind: 'input' as const, actor: 'ai' as const,
      x: 600, y: 200, rect: { x: 500, y: 180, width: 200, height: 40 }, scrollX: 0, scrollY: 0 };
    await render({ ...source, target, revision: 10 });
    await advance(32);
    expect(x()).toBeGreaterThan(40);
    expect(x()).toBeLessThan(300);
    expect(container.querySelector('[data-screen-pointer-target]')).toBeNull();
    expect(ring()).toBeNull();
    await advance(120);
    expect(x()).toBe(300);
    await advance(16);
    expect(container.querySelector('[data-screen-pointer-target="input"]')).not.toBeNull();
    expect(arrow()!.getAttribute('data-pressed')).toBe('false');
    expect(source.seq).toBe(4);
    expect(source.x).toBe(80);
    await advance(SCREEN_POINTER_POLICY.targetVisibleMs);
    expect(container.querySelector('[data-screen-pointer-target]')).toBeNull();
    expect(x()).toBe(300);
  });

  it('keeps exactly one current target when target and activity share an operation sequence', async () => {
    await render(pointer()); await resize(400, 300);
    for (const seq of [10, 11, 12]) {
      const timestamp = Date.now();
      await render({ ...pointer(), revision: seq,
        target: { page, seq, timestamp, kind: 'input', actor: 'ai', x: seq * 30, y: 120,
          rect: { x: seq * 30 - 20, y: 100, width: 40, height: 40 }, scrollX: 0, scrollY: 0 },
        activity: { page, seq, timestamp, kind: 'input', actor: 'ai', pending: false } });
      await advance(150); await advance(16);
      expect(container.querySelectorAll('[data-screen-pointer-target]')).toHaveLength(1);
      expect(container.querySelectorAll('[data-screen-pointer-activity]')).toHaveLength(1);
    }
    await advance(SCREEN_POINTER_POLICY.activityVisibleMs);
    expect(container.querySelectorAll('[data-screen-pointer-target]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-screen-pointer-activity]')).toHaveLength(0);
  });

  it('uses immediate manual positions and returns display ownership to the next AI target', async () => {
    await render(pointer());
    await resize(400, 300);
    const manual = { ...pointer(2, 600), actor: 'manual' as const, origin: 'mouse' as const };
    await render(manual);
    expect(x()).toBe(300);
    expect(container.querySelectorAll('[data-screen-pointer]')).toHaveLength(1);
    expect(arrow()!.getAttribute('data-actor')).toBe('manual');
    await render({ ...manual, target: { page, seq: 8, timestamp: Date.now(), kind: 'input', actor: 'ai',
      x: 80, y: 120, rect: { x: 60, y: 100, width: 40, height: 40 }, scrollX: 0, scrollY: 0 } });
    await advance(32);
    expect(x()).toBeLessThan(300);
    expect(arrow()!.getAttribute('data-actor')).toBe('ai');
    await advance(120);
    expect(x()).toBe(40);
  });

  it('keeps unknown/off-image positions distinct from the visible display fallback and never puts a ring there', async () => {
    const outside = click(4, 950);
    await render(outside);
    await resize(400, 300);
    expect(x()).toBe(12);
    expect(arrow()!.getAttribute('data-origin')).toBe('display-fallback');
    expect(outside.x).toBe(950);
    expect(ring()).toBeNull();
  });

  it('waits for matching scroll pixels before highlighting a target and keeps state actions at the existing position', async () => {
    const source = pointer();
    const target = { page, seq: 8, timestamp: Date.now(), kind: 'key' as const, actor: 'ai' as const,
      x: 600, y: 120, rect: { x: 500, y: 100, width: 200, height: 40 }, scrollX: 0, scrollY: 400, frameAfter: 200 };
    await render({ ...source, target }, undefined, { ...frame, timestamp: 100, scrollY: 0 });
    await resize(400, 300);
    expect(x()).toBe(100);
    expect(container.querySelector('[data-screen-pointer-target]')).toBeNull();
    await render({ ...source, target }, undefined, { ...frame, timestamp: 210, scrollY: 400 });
    await advance(150);
    expect(x()).toBe(300);
    await advance(16);
    expect(container.querySelector('[data-screen-pointer-target="key"]')).not.toBeNull();
    await render({ ...source, activity: { page, seq: 9, timestamp: Date.now(), actor: 'ai', kind: 'operation', pending: false } });
    await advance(150);
    expect(x()).toBe(100);
    expect(container.querySelector('[data-screen-pointer-activity="operation"]')).not.toBeNull();
    expect(ring()).toBeNull();
  });

  it('withholds an old layout box on newer painted pixels, then shows the refreshed target without rewriting Mouse coordinates', async () => {
    const source = pointer(3, 650);
    const target = { page, seq: 8, timestamp: Date.now(), kind: 'input' as const, actor: 'ai' as const,
      x: 130, y: 80, rect: { x: 80, y: 60, width: 100, height: 40 }, scrollX: 0, scrollY: 0, frameAfter: 100, frameBefore: 100 };
    const shownAt = Date.now();
    await render({ ...source, target, targetVisibleAt: shownAt }, undefined, { ...frame, timestamp: 100 });
    await resize(400, 300);
    expect(container.querySelector('[data-screen-pointer-target]')).not.toBeNull();
    expect(x()).toBe(65);
    await render({ ...source, target, targetVisibleAt: shownAt }, undefined, { ...frame, timestamp: 200 });
    expect(container.querySelector('[data-screen-pointer-target]')).toBeNull();
    expect(x()).toBe(65);
    const current = { ...target, x: 330, rect: { ...target.rect, x: 280 }, frameAfter: 200, frameBefore: 200 };
    await render({ ...source, target: current, targetVisibleAt: shownAt }, undefined, { ...frame, timestamp: 200 });
    await advance(150);
    const box = container.querySelector<HTMLElement>('[data-screen-pointer-target]')!;
    expect(box.style.left).toBe('140px');
    expect(x()).toBe(165);
    expect(source).toMatchObject({ x: 650, seq: 3, timestamp: source.timestamp });
    expect(ring()).toBeNull();
    await advance(SCREEN_POINTER_POLICY.targetVisibleMs - 150);
    expect(container.querySelector('[data-screen-pointer-target]')).toBeNull();
  });

  it('does not paint old target geometry on a different image sharing the same millisecond', async () => {
    const source = pointer(3, 650);
    const target = { page, seq: 8, timestamp: Date.now(), kind: 'input' as const, actor: 'ai' as const,
      x: 130, y: 80, rect: { x: 80, y: 60, width: 100, height: 40 }, scrollX: 0, scrollY: 0, frameBefore: 100, frameSeq: 1 };
    await render({ ...source, target, targetVisibleAt: Date.now() }, undefined, { ...frame, timestamp: 100, seq: 1 });
    await resize(400, 300);
    expect(container.querySelector('[data-screen-pointer-target]')).not.toBeNull();
    await render({ ...source, target, targetVisibleAt: Date.now() }, undefined, { ...frame, timestamp: 100, seq: 2 });
    expect(container.querySelector('[data-screen-pointer-target]')).toBeNull();
    expect(x()).toBe(65);
    await render({ ...source, target: { ...target, frameSeq: 2, x: 330, rect: { ...target.rect, x: 280 } }, targetVisibleAt: Date.now() },
      undefined, { ...frame, timestamp: 100, seq: 2 });
    await advance(150);
    expect(container.querySelector<HTMLElement>('[data-screen-pointer-target]')!.style.left).toBe('140px');
    expect(source.x).toBe(650);
  });

  it('keeps a partially visible element at its visible point on every RAF while frame and geometry refresh independently', async () => {
    const source = pointer(3, 650);
    const target = { page, seq: 8, timestamp: Date.now(), kind: 'input' as const, actor: 'ai' as const,
      x: 350, y: 120, rect: { x: 280, y: 100, width: 140, height: 40 }, scrollX: 0, scrollY: 0,
      frameAfter: 100, frameBefore: 100, frameSeq: 1 };
    const shownAt = Date.now();
    await render({ ...source, target, targetVisibleAt: shownAt }, undefined, { ...frame, timestamp: 100, seq: 1 });
    const layer = container.querySelector<HTMLElement>('[data-screen-pointer-layer]')!;
    container.style.overflowX = 'hidden';
    container.style.overflowY = 'hidden';
    vi.spyOn(layer, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, toJSON: () => ({}) });
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 150, bottom: 300, width: 150, height: 300, toJSON: () => ({}) });
    await resize(400, 300);
    await advance(150);
    const original = arrow();
    expect(x()).toBe(145);
    const samples = [];
    for (let seq = 2; seq <= 5; seq++) {
      // New pixels arrive before their geometry read; an old box must stay hidden.
      const painted = { ...frame, timestamp: seq * 100, seq };
      await render({ ...source, target, targetVisibleAt: shownAt }, undefined, painted);
      expect(container.querySelector('[data-screen-pointer-target]')).toBeNull();
      for (let raf = 0; raf < 3; raf++) { await advance(16); samples.push(x()); }
      await render({ ...source, target: { ...target, frameAfter: painted.timestamp, frameBefore: painted.timestamp, frameSeq: seq }, targetVisibleAt: shownAt }, undefined, painted);
      for (let raf = 0; raf < 3; raf++) { await advance(16); samples.push(x()); }
      expect(arrow()).toBe(original);
    }
    expect(samples.every((value) => value === 145)).toBe(true);
    // Geometry can also arrive ahead of the pixels without selecting a different visible point.
    const fresh = { ...target, frameAfter: 600, frameBefore: 600, frameSeq: 6 };
    await render({ ...source, target: fresh }, undefined, { ...frame, timestamp: 500, seq: 5 });
    for (let raf = 0; raf < 3; raf++) { await advance(16); expect(x()).toBe(145); }
    // A real geometry change still retargets smoothly through the visible portion of the control.
    const moved = { ...fresh, x: 310, rect: { ...fresh.rect, x: 240 } };
    await render({ ...source, target: moved }, undefined, { ...frame, timestamp: 600, seq: 6 });
    let previous = x();
    for (let raf = 0; raf < 8; raf++) { await advance(16); expect(x()).toBeLessThanOrEqual(previous); expect(x()).toBeGreaterThanOrEqual(135); previous = x(); }
    expect(x()).toBe(135);
    expect(source.x).toBe(650);
    expect(ring()).toBeNull();
    // Retained positions after target release keep using the same visible part of the element.
    await render({ ...source, positionTarget: moved }, undefined, frame);
    await advance(150);
    expect(x()).toBe(135);
  });

  it('updates the visible point when a clipping parent resizes without resizing the image stage', async () => {
    container.style.overflowX = 'hidden';
    container.style.overflowY = 'hidden';
    const source = { ...pointer(3, 650), positionTarget: { page, seq: 8, timestamp: Date.now(), kind: 'input' as const, actor: 'ai' as const,
      x: 350, y: 120, rect: { x: 280, y: 100, width: 140, height: 40 }, scrollX: 0, scrollY: 0 } };
    await render(source);
    const layer = container.querySelector<HTMLElement>('[data-screen-pointer-layer]')!;
    let clipWidth = 150;
    vi.spyOn(layer, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, toJSON: () => ({}) });
    vi.spyOn(container, 'getBoundingClientRect').mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, right: clipWidth, bottom: 300, width: clipWidth, height: 300, toJSON: () => ({}) }));
    await resize(400, 300);
    await advance(150);
    expect(x()).toBe(145);
    const original = arrow();
    clipWidth = 180;
    await act(async () => resized([{ target: container, contentRect: { width: 180, height: 300 } } as unknown as ResizeObserverEntry], {} as ResizeObserver));
    await advance(150);
    expect(x()).toBe(175);
    expect(arrow()).toBe(original);
    expect(observed.has(container)).toBe(true);
    expect(source.x).toBe(650);
  });

  it('keeps the restored newer element display position and actor after an older Mouse acknowledgement', async () => {
    const source = { ...pointer(1, 650), actor: 'manual' as const,
      positionTarget: { page, seq: 2, timestamp: Date.now(), kind: 'input' as const, actor: 'ai' as const,
        x: 130, y: 80, rect: { x: 80, y: 60, width: 100, height: 40 }, scrollX: 0, scrollY: 0 } };
    await render(source);
    await resize(400, 300);
    expect(x()).toBe(65);
    expect(arrow()!.getAttribute('data-actor')).toBe('ai');
    expect(container.querySelector('[data-screen-pointer-target]')).toBeNull();
    expect(source.x).toBe(650);
    await render({ ...source, seq: 2, x: 500, positionTarget: undefined });
    expect(x()).toBe(250);
    expect(arrow()!.getAttribute('data-actor')).toBe('manual');
  });

  it('cleans pending motion, ring timers, media subscription and measurement on unmount', async () => {
    await render(click(3, 200));
    await resize(400, 300);
    await render({ ...click(3, 200), seq: 4, action: 'move', x: 600 });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    expect(mediaChanged.size).toBe(1);
    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    expect(mediaChanged.size).toBe(0);
    expect(disconnected).toHaveBeenCalledOnce();
    root = createRoot(container);
  });
});
