import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const page = { url: vi.fn(() => 'https://example.test'), title: vi.fn(async () => ''), bringToFront: vi.fn() };
  const automation = {
    selectPageById: vi.fn(async (_id: number, bringToFront: boolean) => {
      if (bringToFront) await page.bringToFront();
      return page;
    }),
    listPages: vi.fn(async () => [{ pageId: 7, page, navigationSequence: 0 }]),
    getSelectedPageId: vi.fn(() => 7),
    consumeSelectedPageFallback: vi.fn(() => undefined),
  };
  const runExclusive = vi.fn(async (_browserId: string, action: (value: unknown) => unknown) =>
    action({ automation })
  );
  return { page, automation, runExclusive };
});

vi.mock('../../../core/browser/browser-manager.js', () => ({
  BrowserManager: { runExclusive: mocks.runExclusive },
}));

import { select_page } from '../index.js';

describe('browser select_page', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses stable IDs and changes logical selection without activating the tab by default', async () => {
    await expect(select_page({ pageId: 7, browserId: 'browser-a' })).resolves.toBe(
      '## Pages\n7: https://example.test [selected]',
    );
    expect(mocks.automation.selectPageById).toHaveBeenCalledExactlyOnceWith(7, false);
    expect(mocks.page.bringToFront).not.toHaveBeenCalled();
  });

  it('activates only when bringToFront is explicitly true', async () => {
    await select_page({ pageId: 7, bringToFront: true, browserId: 'browser-a' });
    expect(mocks.automation.selectPageById).toHaveBeenCalledExactlyOnceWith(7, true);
    expect(mocks.page.bringToFront).toHaveBeenCalledOnce();
  });
});
