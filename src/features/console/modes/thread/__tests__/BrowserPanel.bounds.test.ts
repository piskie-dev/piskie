import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_EMBEDDED_BROWSER_STATE } from '../../../../../../shared/types/embedded-browser';
import { BrowserPanel } from '../BrowserPanel';

const api = { setBounds: vi.fn(async () => undefined), setVisible: vi.fn(async () => undefined) };
const target = { agentId: 'session-example' };
const state = { ...EMPTY_EMBEDDED_BROWSER_STATE, open: true, url: 'about:blank' };

let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;
let hostRect: { x: number; y: number; width: number; height: number };
let observers: Array<{ observed: Set<Element>; callback: ResizeObserverCallback }>;

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class {
    readonly observed = new Set<Element>();
    constructor(readonly callback: ResizeObserverCallback) { observers.push(this); }
    observe(element: Element) { this.observed.add(element); }
    disconnect() { this.observed.clear(); }
  });
  Object.assign(dom.window, { piskie: { pilot: { embeddedBrowser: api } } });
});

beforeEach(() => {
  vi.clearAllMocks();
  observers = [];
  hostRect = { x: 480, y: 72, width: 400, height: 500 };
  vi.spyOn(dom.window.HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    ...hostRect,
    left: hostRect.x,
    top: hostRect.y,
    right: hostRect.x + hostRect.width,
    bottom: hostRect.y + hostRect.height,
  }) as DOMRect);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});
afterAll(() => { dom.window.close(); vi.unstubAllGlobals(); });

function resize(element: Element) {
  for (const observer of observers) {
    if (observer.observed.has(element)) observer.callback([], observer as unknown as ResizeObserver);
  }
}

describe('embedded browser view placement', () => {
  it('remeasures when preceding columns move a same-size host, as well as on host/window resize', async () => {
    const threads = document.createElement('div');
    const center = document.createElement('div');
    const anchors = [{ current: threads }, { current: center }];
    await act(async () => root.render(createElement(BrowserPanel, { target, state, layoutAnchors: anchors })));
    const host = container.querySelector<HTMLDivElement>('[class*="viewHost"]')!;
    expect(host).toBeTruthy();
    expect(observers[0]?.observed).toEqual(new Set([host, threads, center]));
    expect(api.setBounds).toHaveBeenLastCalledWith(target, hostRect);

    const reports = api.setBounds.mock.calls.length;
    hostRect = { ...hostRect, x: 660 }; // Only the position changed; host ResizeObserver will not fire.
    expect(api.setBounds).toHaveBeenCalledTimes(reports);
    resize(threads);
    expect(api.setBounds).toHaveBeenLastCalledWith(target, hostRect);

    hostRect = { ...hostRect, x: 700 };
    resize(center);
    expect(api.setBounds).toHaveBeenLastCalledWith(target, hostRect);

    hostRect = { ...hostRect, width: 214 };
    resize(host);
    expect(api.setBounds).toHaveBeenLastCalledWith(target, hostRect);

    hostRect = { ...hostRect, y: 100 };
    dom.window.dispatchEvent(new dom.window.Event('resize'));
    expect(api.setBounds).toHaveBeenLastCalledWith(target, hostRect);

    const lastReport = api.setBounds.mock.calls.length;
    await act(async () => root.unmount());
    resize(center);
    dom.window.dispatchEvent(new dom.window.Event('resize'));
    expect(api.setBounds).toHaveBeenCalledTimes(lastReport);
  });
});
