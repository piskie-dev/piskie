import { JSDOM } from 'jsdom';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireOverlay } from '../../console/chrome/overlayPresence';
import { useGuideStore } from '../guideStore';
import { useFeatureGuide } from '../useFeatureGuide';

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
let guide: ReturnType<typeof useFeatureGuide>;
let now = Date.now();

function Harness() {
  const state = useFeatureGuide('getting-started');
  useEffect(() => { guide = state; }, [state]);
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

beforeEach(async () => {
  now += 120_000;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  useGuideStore.setState({ statuses: {} });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(Harness)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

afterAll(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

describe('one-time introduction', () => {
  it.each(['close', 'complete'] as const)('does not automatically reopen after %s or remount, but allows settings replay', async (action) => {
    expect(guide.open).toBe(false);
    await act(async () => guide.showAutomatically());
    expect(guide.open).toBe(true);
    expect(useGuideStore.getState().statuses['getting-started']).toBe('dismissed');
    await act(async () => guide[action]());
    await act(async () => root.render(null));
    await act(async () => useGuideStore.persist.rehydrate());
    await act(async () => root.render(createElement(Harness)));
    await act(async () => guide.showAutomatically());
    expect(guide.open).toBe(false);
    expect(guide.unread).toBe(action === 'close');
    await act(async () => guide.show());
    expect(guide.open).toBe(true);
    await act(async () => guide.close());
    expect(guide.unread).toBe(action === 'close');
  });

  it('does not consume the introduction while another overlay is open', async () => {
    const release = acquireOverlay();
    try {
      await act(async () => guide.showAutomatically());
      expect(guide.open).toBe(false);
      expect(useGuideStore.getState().statuses).toEqual({});
    } finally {
      release();
    }
    await act(async () => guide.showAutomatically());
    expect(guide.open).toBe(true);
  });
});
