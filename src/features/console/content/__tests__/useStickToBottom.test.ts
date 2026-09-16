import { JSDOM } from 'jsdom';
import { act, createElement, useEffect, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

let useStickToBottom: typeof import('../useStickToBottom').useStickToBottom;
let dom: JSDOM;
let container: HTMLDivElement;
let root: Root;
let resizeCallback: ResizeObserverCallback | undefined;
let resizeTarget: Element | undefined;
let disconnectSpy = vi.fn();

beforeAll(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://piskie.test' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) {
      resizeCallback = callback;
    }

    observe(target: Element) {
      resizeTarget = target;
    }

    disconnect() {
      disconnectSpy();
    }
  });
  ({ useStickToBottom } = await import('../useStickToBottom'));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  resizeCallback = undefined;
  resizeTarget = undefined;
});

afterAll(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

function Harness({
  revision,
  scrollRef,
  contentRef,
  onReady,
}: {
  revision: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  onReady: (stick: ReturnType<typeof useStickToBottom>) => void;
}) {
  const stick = useStickToBottom(scrollRef, contentRef, [revision]);
  useEffect(() => onReady(stick), [onReady, stick]);
  return null;
}

function setDimensions(
  element: HTMLDivElement,
  values: { scrollHeight: number; clientHeight: number; scrollTop: number },
): void {
  let height = values.scrollHeight;
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    get: () => height,
    set: (value: number) => { height = value; },
  });
  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    value: values.clientHeight,
  });
  element.scrollTop = values.scrollTop;
}

describe('useStickToBottom', () => {
  it('keeps a clicked disclosure header in place and pauses following while its content is read', async () => {
    container = document.createElement('div');
    document.body.append(container);
    const hookHost = document.createElement('div');
    const scroll = document.createElement('div');
    const content = document.createElement('div');
    const anchor = document.createElement('button');
    content.append(anchor);
    scroll.append(content);
    container.append(hookHost, scroll);
    let stick: ReturnType<typeof useStickToBottom> | undefined;
    const onReady = (value: ReturnType<typeof useStickToBottom>) => { stick = value; };
    const renderHarness = (revision: number) => createElement(Harness, {
      revision, scrollRef: { current: scroll }, contentRef: { current: content }, onReady,
    });
    root = createRoot(hookHost);
    await act(async () => root.render(renderHarness(0)));
    setDimensions(scroll, { scrollHeight: 500, clientHeight: 100, scrollTop: 400 });
    anchor.getBoundingClientRect = () => ({ top: 480 - scroll.scrollTop }) as DOMRect;
    stick?.preserveAnchor(anchor);

    // The browser may anchor later content when an earlier disclosure grows.
    setDimensions(scroll, { scrollHeight: 1000, clientHeight: 100, scrollTop: 800 });
    await act(async () => root.render(renderHarness(1)));
    expect(anchor.getBoundingClientRect().top).toBe(80);
    expect(scroll.scrollTop).toBe(400);
    expect(stick?.atBottom).toBe(false);
    await act(async () => resizeCallback?.([], {} as ResizeObserver));
    expect(scroll.scrollTop).toBe(400);
    await act(async () => stick?.scrollToBottom());
    expect(scroll.scrollTop).toBe(1000);
  });

  it('follows real content growth at the bottom and preserves an upward reading position', async () => {
    disconnectSpy = vi.fn();
    container = document.createElement('div');
    document.body.append(container);
    const hookHost = document.createElement('div');
    const scroll = document.createElement('div');
    const content = document.createElement('div');
    scroll.append(content);
    container.append(hookHost, scroll);
    const scrollRef = { current: scroll };
    const contentRef = { current: content };
    let stick: ReturnType<typeof useStickToBottom> | undefined;
    const onReady = (value: ReturnType<typeof useStickToBottom>) => { stick = value; };
    const renderHarness = (revision: number) => createElement(Harness, {
      revision,
      scrollRef,
      contentRef,
      onReady,
    });
    root = createRoot(hookHost);
    await act(async () => root.render(renderHarness(0)));

    setDimensions(scroll, { scrollHeight: 500, clientHeight: 100, scrollTop: 400 });
    expect(resizeTarget).toBe(content);

    await act(async () => root.render(renderHarness(1)));
    expect(scroll.scrollTop).toBe(500);

    scroll.scrollTop = 100;
    await act(async () => stick?.onScroll({ currentTarget: scroll } as never));
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 650 });
    await act(async () => resizeCallback?.([], {} as ResizeObserver));
    await act(async () => root.render(renderHarness(2)));
    expect(scroll.scrollTop).toBe(100);

    scroll.scrollTop = 520;
    await act(async () => stick?.onScroll({ currentTarget: scroll } as never));
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 700 });
    await act(async () => resizeCallback?.([], {} as ResizeObserver));
    expect(scroll.scrollTop).toBe(700);

    scroll.scrollTop = 50;
    await act(async () => stick?.scrollToBottom());
    expect(scroll.scrollTop).toBe(700);
  });
});
