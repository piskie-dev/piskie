import { JSDOM } from 'jsdom';
import i18n from 'i18next';
import { StrictMode, act, createElement, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

import type { ViewportLease, ViewportSnapshot } from '@/domains/screen-feed/screen-feed';
import type { ScreenFeedRegistry } from '@/domains/screen-feed/screen-feed-registry';
import { RendererRuntimeProvider } from '@/renderer-runtime/RendererRuntimeProvider';
import type { RendererRuntime } from '@/renderer-runtime/renderer-runtime';
import { useScreenViewport } from '../useScreenViewport';

const RuntimeProvider = RendererRuntimeProvider as ComponentType<{
  readonly runtime: RendererRuntime;
}>;

const SNAPSHOT: ViewportSnapshot = {
  phase: 'streaming',
  epoch: 1,
  failure: null,
  frameSize: { width: 1280, height: 720 },
  stats: {
    receivedFrames: 1,
    decodedFrames: 1,
    decodeFailures: 0,
    sequenceGaps: 0,
    decodedFps: 30,
    decodeMs: 2,
  },
  demand: { fps: 30 },
  ready: true,
  viewportFailure: null,
  drawnFrames: 1,
};

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
let nextTimerId = 1;
let timers = new Map<number, () => void>();

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://piskie.test' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('HTMLCanvasElement', dom.window.HTMLCanvasElement);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

beforeEach(() => {
  timers = new Map();
  nextTimerId = 1;
  vi.spyOn(window, 'setTimeout').mockImplementation(((callback: TimerHandler) => {
    const id = nextTimerId++;
    timers.set(id, callback as () => void);
    return id;
  }) as never);
  vi.spyOn(window, 'clearTimeout').mockImplementation(((id?: number) => {
    if (id !== undefined) timers.delete(id);
  }) as never);
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
    configurable: true,
    value: vi.fn(() => ({} as OffscreenCanvas)),
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  await i18n.changeLanguage('zh-CN');
});

afterAll(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

function Probe() {
  const viewport = useScreenViewport({
    agentId: 'agent-a',
    browserId: 'browser-a',
    enabled: true,
    fps: 30,
    interactive: true,
  });
  return createElement(
    'div',
    null,
    createElement('canvas', { key: viewport.canvasKey, ref: viewport.canvasRef }),
    createElement('span', { 'data-error': true }, viewport.error),
  );
}

function screenFeedsWith(snapshot: ViewportSnapshot): ScreenFeedRegistry {
  const lease: ViewportLease = {
    id: 'lease-error',
    attach: vi.fn(() => 'attached' as const),
    update: vi.fn(),
    sendInput: vi.fn(),
    subscribe: () => () => undefined,
    snapshot: () => snapshot,
    release: vi.fn(),
  };
  return {
    acquireViewport: vi.fn(() => lease),
    activeFeedCount: vi.fn(() => 1),
    close: vi.fn(async () => undefined),
  };
}

async function flushAcquire(): Promise<void> {
  await act(async () => {
    for (const callback of [...timers.values()]) callback();
    timers.clear();
  });
}

describe('useScreenViewport', () => {
  it('defers acquire through the StrictMode probe and transfers the canvas once', async () => {
    const release = vi.fn();
    const attach = vi.fn(() => 'attached' as const);
    const lease: ViewportLease = {
      id: 'lease-a',
      attach,
      update: vi.fn(),
      sendInput: vi.fn(),
      subscribe: () => () => undefined,
      snapshot: () => SNAPSHOT,
      release,
    };
    const screenFeeds = {
      acquireViewport: vi.fn(() => lease),
      activeFeedCount: vi.fn(() => 1),
      close: vi.fn(async () => undefined),
    } satisfies ScreenFeedRegistry;
    const runtime = { screenFeeds } as unknown as RendererRuntime;

    await act(async () => {
      root.render(
        createElement(
          RuntimeProvider,
          { runtime },
          createElement(StrictMode, null, createElement(Probe)),
        ),
      );
    });

    expect(screenFeeds.acquireViewport).not.toHaveBeenCalled();
    expect(timers.size).toBe(1);
    await act(async () => {
      for (const callback of [...timers.values()]) callback();
      timers.clear();
    });

    expect(screenFeeds.acquireViewport).toHaveBeenCalledOnce();
    expect(attach).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
    expect(release).toHaveBeenCalledOnce();
    root = createRoot(container);
  });

  it('reprojects local port failures while preserving external error text', async () => {
    const timeoutSnapshot: ViewportSnapshot = {
      ...SNAPSHOT,
      phase: 'retry-wait',
      ready: false,
      failure: {
        code: 'port-request-timeout',
        retryable: true,
        detail: 'Screen stream port timed out',
      },
    };
    const runtime = {
      screenFeeds: screenFeedsWith(timeoutSnapshot),
    } as unknown as RendererRuntime;

    await i18n.changeLanguage('zh-CN');
    await act(async () => root.render(createElement(RuntimeProvider, { runtime }, createElement(Probe))));
    await flushAcquire();
    expect(container.querySelector('[data-error]')?.textContent).toBe('等待屏幕流连接超时');

    await act(async () => i18n.changeLanguage('en-US'));
    expect(container.querySelector('[data-error]')?.textContent)
      .toBe('Timed out while connecting the screen stream');

    await act(async () => root.unmount());
    root = createRoot(container);
    const externalSnapshot: ViewportSnapshot = {
      ...timeoutSnapshot,
      failure: {
        code: 'port-request-failed',
        retryable: true,
        detail: '代理入口拒绝连接',
      },
    };
    const externalRuntime = {
      screenFeeds: screenFeedsWith(externalSnapshot),
    } as unknown as RendererRuntime;
    await act(async () => root.render(
      createElement(RuntimeProvider, { runtime: externalRuntime }, createElement(Probe)),
    ));
    await flushAcquire();
    expect(container.querySelector('[data-error]')?.textContent).toBe('代理入口拒绝连接');

    await act(async () => i18n.changeLanguage('zh-CN'));
    expect(container.querySelector('[data-error]')?.textContent).toBe('代理入口拒绝连接');
  });
});
