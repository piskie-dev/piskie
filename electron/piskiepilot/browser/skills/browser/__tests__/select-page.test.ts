import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const page = { url: vi.fn(() => 'https://example.test'), bringToFront: vi.fn() };
  const automation = {
    selectPageByIndex: vi.fn(async () => page),
    listPages: vi.fn(async () => [{ pageId: 7, page, navigationSequence: 0 }]),
    getSelectedPageIndex: vi.fn(() => 0),
    consumePageChanges: vi.fn(async () => ({ opened: [], closed: [] })),
  };
  const runExclusive = vi.fn(async (_browserId: string, action: (value: unknown) => unknown) =>
    action({ automation })
  );
  return { page, automation, runExclusive };
});

vi.mock('../../../core/browser/browser-manager.js', () => ({
  BrowserManager: { runExclusive: mocks.runExclusive },
}));

import { selectPage } from '../index.js';

describe('browser selectPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates logical selection without activating the Chromium tab', async () => {
    await expect(selectPage({ pageIdx: 2, browserId: 'browser-a' })).resolves.toContain(
      '0: https://example.test [selected]'
    );

    expect(mocks.automation.selectPageByIndex).toHaveBeenCalledWith(2);
    expect(mocks.page.bringToFront).not.toHaveBeenCalled();
  });
});
