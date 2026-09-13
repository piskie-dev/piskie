import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readGuideStatuses, useGuideStore } from '../guideStore';

beforeEach(() => {
  const items = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key),
  });
  useGuideStore.setState({ statuses: {} });
});

afterEach(() => vi.unstubAllGlobals());

describe('guide preferences', () => {
  it('carries the previous plan introduction into the combined welcome guide', async () => {
    localStorage.setItem('piskie-feature-guides', JSON.stringify({ version: 1, state: { statuses: { 'plan-mode': 'understood' } } }));
    await useGuideStore.persist.rehydrate();
    expect(useGuideStore.getState().statuses).toEqual({ 'getting-started': 'understood' });
  });

  it('persists a skipped introduction across reloads without marking it understood', async () => {
    useGuideStore.getState().dismiss('getting-started');
    expect(useGuideStore.getState().statuses['getting-started']).toBe('dismissed');
    await useGuideStore.persist.rehydrate();
    expect(useGuideStore.getState().statuses['getting-started']).toBe('dismissed');
    expect(JSON.parse(localStorage.getItem('piskie-feature-guides')!)).toEqual({
      version: 2, state: { statuses: { 'getting-started': 'dismissed' } },
    });
  });

  it('does not downgrade completion when native dialog close fires afterwards', async () => {
    useGuideStore.getState().understand('getting-started');
    useGuideStore.getState().dismiss('getting-started');
    await useGuideStore.persist.rehydrate();
    expect(useGuideStore.getState().statuses['getting-started']).toBe('understood');
  });

  it('only restores known guide states and never merges persisted actions', async () => {
    localStorage.setItem('piskie-feature-guides', JSON.stringify({
      version: 2,
      state: { statuses: { 'getting-started': 'understood', unknown: 'understood' }, understand: false },
    }));
    await useGuideStore.persist.rehydrate();
    expect(useGuideStore.getState().statuses).toEqual({ 'getting-started': 'understood' });
    expect(typeof useGuideStore.getState().understand).toBe('function');
    for (const invalid of [null, [], 'bad', { statuses: null }, { statuses: { 'getting-started': 'invalid' } }]) {
      expect(readGuideStatuses(invalid)).toEqual({});
    }
  });
});
