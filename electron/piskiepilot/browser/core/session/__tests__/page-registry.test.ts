import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Browser, Page, Target } from 'puppeteer-core';
import { PageRegistry } from '../page-registry.js';

function fakePage(initialUrl: string) {
  const events = new EventEmitter();
  const target = { page: vi.fn() };
  let closed = false;
  let url = initialUrl;
  const frame = {};
  const page = Object.assign(events, {
    url: vi.fn(() => url),
    setUrl: vi.fn((value: string) => {
      url = value;
    }),
    target: vi.fn(() => target),
    mainFrame: vi.fn(() => frame),
    isClosed: vi.fn(() => closed),
    emulateFocusedPage: vi.fn(async () => undefined),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    close: vi.fn(async () => {
      closed = true;
      events.emit('close');
    }),
  }) as unknown as Page & { setUrl(value: string): void };
  target.page.mockResolvedValue(page);
  return { page, target: target as unknown as Target, frame };
}

function fakeBrowser(initialPages: Page[]) {
  const events = new EventEmitter();
  let pages = [...initialPages];
  const browser = Object.assign(events, {
    pages: vi.fn(async () => pages),
    newPage: vi.fn(async () => {
      const created = fakePage('about:blank').page;
      pages.push(created);
      return created;
    }),
  }) as unknown as Browser;
  return {
    browser,
    setPages(value: Page[]) {
      pages = [...value];
    },
  };
}

describe('PageRegistry', () => {
  beforeEach(() => PageRegistry.resetPageIdsForTesting());

  it('keeps duplicate URLs as distinct pages and selects a deterministic fallback', async () => {
    const first = fakePage('https://example.test/same');
    const second = fakePage('https://example.test/same');
    const runtime = fakeBrowser([first.page, second.page]);
    const selectedChanges = vi.fn();
    const registry = await PageRegistry.create(runtime.browser, {
      selectedPageChanged: selectedChanges,
      mainFrameNavigated: vi.fn(),
    });

    const pages = registry.pages();
    expect(pages).toHaveLength(2);
    expect(pages[0].pageId).not.toBe(pages[1].pageId);
    expect(first.page.emulateFocusedPage).toHaveBeenCalledWith(true);
    expect(first.page.setDefaultTimeout).toHaveBeenCalledWith(5_000);
    expect(first.page.setDefaultNavigationTimeout).toHaveBeenCalledWith(10_000);
    registry.selectByIndex(1);
    expect(second.page.setDefaultTimeout).toHaveBeenCalledWith(5_000);
    expect(second.page.setDefaultNavigationTimeout).toHaveBeenCalledWith(10_000);
    await second.page.close();

    expect(registry.selectedPage().page).toBe(first.page);
    expect(selectedChanges).toHaveBeenLastCalledWith(pages[1].pageId, pages[0].pageId);
    expect(registry.consumeChanges().closed).toEqual([
      expect.objectContaining({ pageId: pages[1].pageId, url: 'https://example.test/same' }),
    ]);
  });

  it('registers target events, journals identity changes, and removes every listener on dispose', async () => {
    const first = fakePage('https://example.test/first');
    const runtime = fakeBrowser([first.page]);
    const navigated = vi.fn();
    const registry = await PageRegistry.create(runtime.browser, {
      selectedPageChanged: vi.fn(),
      mainFrameNavigated: navigated,
    });
    first.page.setUrl('https://example.test/current');
    first.page.emit('framenavigated', first.frame);
    expect(registry.consumeChanges().opened).toEqual([
      expect.objectContaining({ url: 'https://example.test/current' }),
    ]);

    const next = fakePage('https://example.test/next');
    runtime.browser.emit('targetcreated', next.target);
    await vi.waitFor(() => expect(registry.pages()).toHaveLength(2));

    next.page.emit('framenavigated', next.frame);
    expect(navigated).toHaveBeenCalledWith(registry.pages()[1].pageId);
    expect(registry.consumeChanges().opened).toEqual([
      expect.objectContaining({ url: 'https://example.test/next' }),
    ]);

    registry.dispose();
    registry.dispose();
    expect(runtime.browser.listenerCount('targetcreated')).toBe(0);
    expect(runtime.browser.listenerCount('targetdestroyed')).toBe(0);
    expect(first.page.listenerCount('dialog')).toBe(0);
    expect(next.page.listenerCount('framenavigated')).toBe(0);
  });

  it('never reuses page IDs across independent connection registries', async () => {
    const first = fakePage('https://example.test/first');
    const registryA = await PageRegistry.create(fakeBrowser([first.page]).browser, {
      selectedPageChanged: vi.fn(),
      mainFrameNavigated: vi.fn(),
    });
    const firstId = registryA.selectedPage().pageId;
    registryA.dispose();

    const second = fakePage('https://example.test/second');
    const registryB = await PageRegistry.create(fakeBrowser([second.page]).browser, {
      selectedPageChanged: vi.fn(),
      mainFrameNavigated: vi.fn(),
    });
    expect(registryB.selectedPage().pageId).toBeGreaterThan(firstId);
    registryB.dispose();
  });
});
