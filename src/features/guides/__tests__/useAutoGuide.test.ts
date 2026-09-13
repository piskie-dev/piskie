import { JSDOM } from 'jsdom';
import { act, createElement, Fragment, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireOverlay } from '../../console/chrome/overlayPresence';
import { consumeWelcomeDeferral } from '../guideSession';
import { useGuideStore } from '../guideStore';
import { useAutoGuide, type AutoGuideOptions } from '../useAutoGuide';

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
let guide: ReturnType<typeof useAutoGuide>;
const candidates = new Map<string, ReturnType<typeof useAutoGuide>>();
let now = Date.now();

function Harness(props: AutoGuideOptions) {
  const current = useAutoGuide(props);
  useEffect(() => { guide = current; candidates.set(props.id, current); }, [current, props.id]);
  return null;
}

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('localStorage', dom.window.localStorage);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

beforeEach(() => {
  vi.useFakeTimers();
  now += 180_000;
  vi.setSystemTime(now);
  consumeWelcomeDeferral();
  candidates.clear();
  useGuideStore.setState({ statuses: {} });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

afterAll(() => { dom.window.close(); vi.unstubAllGlobals(); });

const render = async (props: Partial<AutoGuideOptions> = {}) => {
  await act(async () => root.render(createElement(Harness, { id: 'model-setup', ready: true, eligible: true, ...props })));
};
const tick = async (ms = 650) => { await act(async () => vi.advanceTimersByTimeAsync(ms)); };
const leave = async () => { await act(async () => root.render(null)); };

describe('business introduction timing', () => {
  it('shares the model setup record between welcome and AI settings', async () => {
    await render({ visitKey: 'welcome' });
    await tick();
    expect(guide.open).toBe(true);
    await act(async () => guide.close());
    await leave();
    await render({ visitKey: 'ai-settings' });
    await tick();
    expect(guide.open).toBe(false);
    await act(async () => guide.show());
    expect(guide.open).toBe(true);
  });

  it('does not show while loading and cancels the visit when the user starts typing', async () => {
    await render({ ready: false });
    await tick();
    expect(guide.open).toBe(false);
    document.dispatchEvent(new dom.window.Event('input'));
    await render({ ready: true });
    await tick();
    expect(guide.open).toBe(false);
    expect(useGuideStore.getState().statuses).toEqual({});
  });

  it('cancels a scheduled introduction on interaction, unmount or a slow read', async () => {
    await render();
    document.dispatchEvent(new dom.window.Event('pointerdown'));
    await tick();
    expect(guide.open).toBe(false);
    await leave();
    await render();
    await leave();
    await tick();
    expect(useGuideStore.getState().statuses).toEqual({});
    await render({ ready: false });
    await tick(5000);
    await render({ ready: true });
    await tick();
    expect(guide.open).toBe(false);
  });

  it('does not queue behind another dialog', async () => {
    const release = acquireOverlay();
    await render();
    await tick();
    expect(guide.open).toBe(false);
    release();
    await tick();
    await render();
    expect(guide.open).toBe(false);
    expect(useGuideStore.getState().statuses).toEqual({});
  });

  it.each(['browser', 'extensions', 'messaging', 'templates', 'getting-started', 'agents'] as const)('does not introduce %s to an experienced user even after records are removed', async (id) => {
    await render({ id, eligible: false });
    await tick();
    await leave();
    await render({ id });
    await tick();
    expect(guide.open).toBe(false);
    expect(useGuideStore.getState().statuses[id]).toBe('dismissed');
  });

  it('defers getting started on the return from configuration, but allows a later welcome visit', async () => {
    await render({ visitKey: 'welcome' });
    await tick();
    await act(async () => guide.complete());
    await render({ id: 'getting-started', visitKey: 'welcome' });
    await tick();
    expect(guide.open).toBe(false);
    await leave();
    await render({ id: 'getting-started', visitKey: 'welcome' });
    await tick();
    expect(guide.open).toBe(false);
    await leave();
    await render({ id: 'getting-started', visitKey: 'welcome' });
    await tick();
    expect(guide.open).toBe(true);
  });

  it('allows the next page to introduce its feature immediately after another guide closes', async () => {
    await render();
    await tick();
    await act(async () => guide.close());
    await leave();
    await render({ id: 'browser' });
    await tick();
    expect(guide.open).toBe(true);
  });

  it('shows only one simultaneous candidate and does not queue the other after it closes', async () => {
    await act(async () => root.render(createElement(Fragment, null,
      createElement(Harness, { id: 'browser', ready: true, eligible: true }),
      createElement(Harness, { id: 'extensions', ready: true, eligible: true }),
    )));
    await tick();
    expect(candidates.get('browser')?.open).toBe(true);
    expect(candidates.get('extensions')?.open).toBe(false);
    await act(async () => candidates.get('browser')!.close());
    await tick(3000);
    expect(candidates.get('extensions')?.open).toBe(false);
    expect(useGuideStore.getState().statuses.extensions).toBeUndefined();
    await leave();
    await render({ id: 'extensions' });
    await tick();
    expect(guide.open).toBe(true);
  });

  it('skips without queuing when an overlay opens during the presentation delay', async () => {
    await render({ id: 'browser' });
    await tick(100);
    const release = acquireOverlay();
    await tick();
    expect(guide.open).toBe(false);
    release();
    await tick(3000);
    expect(guide.open).toBe(false);
    expect(useGuideStore.getState().statuses.browser).toBeUndefined();
  });
});
