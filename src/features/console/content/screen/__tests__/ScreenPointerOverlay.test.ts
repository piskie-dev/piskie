import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCREEN_POINTER_POLICY, type PresentedScreenPointer } from '@shared/screen-pointer';
import { ScreenPointerOverlay } from '../ScreenPointerOverlay';

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
let resized: ResizeObserverCallback;
let reduced = false;
const mediaChanged = new Set<() => void>();
const disconnected = vi.fn();
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
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resized = callback; }
    observe() {}
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
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
afterAll(() => { dom.window.close(); vi.unstubAllGlobals(); });
async function render(value: PresentedScreenPointer | null, onPresented?: (pointer: PresentedScreenPointer, at: number) => void, painted = frame) {
  await act(async () => root.render(createElement(ScreenPointerOverlay, { pointer: value, frame: painted, onPresented })));
}
async function resize(width: number, height: number) {
  await act(async () => resized([{ contentRect: { width, height } } as ResizeObserverEntry], {} as ResizeObserver));
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
