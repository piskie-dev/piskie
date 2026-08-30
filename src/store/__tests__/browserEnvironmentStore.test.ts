import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrowserEnvironment } from '../../../shared/types';
import { useBrowserEnvironmentStore } from '../browserEnvironmentStore';

const list = vi.fn();

function environment(id: string): BrowserEnvironment {
  return {
    id,
    name: id,
    status: 'idle',
    createdAt: 1,
    identityPolicy: {
      timezone: { mode: 'real' },
      geolocation: { mode: 'off' },
      language: { mode: 'custom', value: 'zh-CN' },
    },
  };
}

beforeEach(() => {
  list.mockReset();
  vi.stubGlobal('window', {
    piskie: {
      runtime: { host: 'electron' },
      pilot: { environments: { list } },
    },
  });
  useBrowserEnvironmentStore.setState({
    environments: [],
    isLoading: false,
    error: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browserEnvironmentStore authoritative list', () => {
  it('keeps the newest response when overlapping reads resolve out of order', async () => {
    let resolveFirst!: (value: BrowserEnvironment[]) => void;
    let resolveSecond!: (value: BrowserEnvironment[]) => void;
    list
      .mockReturnValueOnce(new Promise<BrowserEnvironment[]>((resolve) => { resolveFirst = resolve; }))
      .mockReturnValueOnce(new Promise<BrowserEnvironment[]>((resolve) => { resolveSecond = resolve; }));

    const first = useBrowserEnvironmentStore.getState().fetchEnvironments();
    const second = useBrowserEnvironmentStore.getState().fetchEnvironments();
    resolveSecond([environment('new')]);
    await second;
    resolveFirst([environment('old')]);
    await first;

    expect(useBrowserEnvironmentStore.getState()).toMatchObject({
      environments: [expect.objectContaining({ id: 'new' })],
      isLoading: false,
      error: null,
    });
  });

  it('exposes no second set of environment mutation actions', () => {
    const state = useBrowserEnvironmentStore.getState();
    for (const retiredAction of [
      'createEnvironment',
      'updateEnvironment',
      'deleteEnvironment',
      'startBrowser',
      'stopBrowser',
      'showWindow',
    ]) {
      expect(state).not.toHaveProperty(retiredAction);
    }
  });
});
