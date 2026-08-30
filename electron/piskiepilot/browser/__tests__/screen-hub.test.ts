import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const getSelectedPage = vi.fn();
  const casters: Array<{
    page: unknown;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    setOptions: ReturnType<typeof vi.fn>;
    rebind: ReturnType<typeof vi.fn>;
  }> = [];

  class ScreenCaster {
    readonly page: unknown;
    readonly start = vi.fn(async () => undefined);
    readonly stop = vi.fn(async () => undefined);
    readonly setOptions = vi.fn(async () => undefined);
    readonly rebind = vi.fn(async () => undefined);
    readonly on = vi.fn();

    constructor(page: unknown) {
      this.page = page;
      casters.push(this);
    }
  }

  return { casters, getSelectedPage, ScreenCaster };
});

vi.mock('../core/browser/browser-manager.js', () => ({
  BrowserManager: {
    getSelectedPage: mocks.getSelectedPage,
  },
}));

vi.mock('../core/browser/screen-caster.js', () => ({
  ScreenCaster: mocks.ScreenCaster,
}));

import { ScreenStreamHub, type ViewerSink } from '../screen-hub.js';

function openSink(): ViewerSink {
  return { send: vi.fn(), isOpen: vi.fn(() => true) };
}

describe('ScreenStreamHub selected-page ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.casters.length = 0;
  });

  it('recovers the selected page before starting the first viewer', async () => {
    const page = {};
    mocks.getSelectedPage.mockResolvedValue(page);
    const sink = openSink();

    await new ScreenStreamHub().addViewer('browser-a', sink);

    expect(mocks.getSelectedPage).toHaveBeenCalledWith('browser-a');
    expect(mocks.casters).toHaveLength(1);
    expect(mocks.casters[0].page).toBe(page);
    expect(mocks.casters[0].start).toHaveBeenCalledOnce();
    expect(sink.send).toHaveBeenCalledWith({ type: 'started', browserId: 'browser-a' });
  });
});

describe('ScreenStreamHub selected-page follow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.casters.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rebinds when selectedPageIdx changes and stops polling with the final viewer', async () => {
    const selectedTab = { name: 'selected' };
    const nextTab = { name: 'next' };
    mocks.getSelectedPage.mockResolvedValue(selectedTab);

    const hub = new ScreenStreamHub();
    const sink = openSink();
    await hub.addViewer('browser-b', sink);

    expect(mocks.casters[0].page).toBe(selectedTab);

    mocks.getSelectedPage.mockResolvedValue(nextTab);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.casters[0].rebind).toHaveBeenCalledWith(nextTab);

    hub.removeViewer('browser-b', sink);
    expect(mocks.casters[0].stop).toHaveBeenCalledOnce();
    const readsSoFar = mocks.getSelectedPage.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(mocks.getSelectedPage).toHaveBeenCalledTimes(readsSoFar);
  });
});
