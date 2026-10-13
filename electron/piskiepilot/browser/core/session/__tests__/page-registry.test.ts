import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Browser, Page, Target } from 'puppeteer-core';
import { PageRegistry } from '../page-registry.js';

function fakePage(initialUrl: string, context: import('puppeteer-core').BrowserContext | null = null) {
  const events = new EventEmitter();
  const client = Object.assign(new EventEmitter(), { detached: false });
  const target = { page: vi.fn(), type: () => 'page', url: () => url };
  let closed = false;
  let url = initialUrl;
  const frame = new EventEmitter();
  const page = Object.assign(events, {
    url: vi.fn(() => url),
    setUrl: vi.fn((value: string) => {
      url = value;
    }),
    target: vi.fn(() => target),
    browserContext: () => context,
    mainFrame: vi.fn(() => frame),
    _client: () => client,
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
  return { page, target: target as unknown as Target, frame, client };
}

function fakeBrowser(initialPages: Page[]) {
  const events = new EventEmitter();
  let pages = [...initialPages];
  const browser = Object.assign(events, {
    pages: vi.fn(async () => pages),
    defaultBrowserContext: () => null,
    browserContexts: () => [],
    targets: () => [],
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
    runtime.setPages([first.page]);
    await registry.refresh();

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

describe('fixed-source page IDs, contexts and selection feedback', () => {
  beforeEach(() => PageRegistry.resetPageIdsForTesting());
  const events = () => ({ selectedPageChanged: vi.fn(), mainFrameNavigated: vi.fn(), pageRemoved: vi.fn() });

  it('selects by ID independently of shifting indices and protects the final page', async () => {
    const first = fakePage('https://example.test/a');
    const second = fakePage('https://example.test/b');
    const third = fakePage('https://example.test/c');
    const runtime = fakeBrowser([first.page, second.page, third.page]);
    const registry = await PageRegistry.create(runtime.browser, events());
    const id = registry.pages()[2].pageId;
    await registry.closeById(registry.pages()[0].pageId);
    runtime.setPages([second.page, third.page]);
    await registry.refresh();
    expect(registry.pageByIndex(1).pageId).toBe(id);
    expect(registry.selectById(id).page).toBe(third.page);
    expect(() => registry.selectById(0)).toThrow('No page found');
    await registry.closeById(registry.pages()[0].pageId);
    runtime.setPages([third.page]);
    await registry.refresh();
    await expect(registry.closeById(id)).rejects.toThrow('The last open page cannot be closed. It is fine to keep it open.');
    registry.dispose();
  });

  it('records only automatic closed-selection fallback and consumes it once', async () => {
    const first = fakePage('https://example.test/a');
    const second = fakePage('https://example.test/b');
    const runtime = fakeBrowser([first.page, second.page]);
    const registry = await PageRegistry.create(runtime.browser, events());
    expect(registry.consumeSelectedPageFallback()).toBeUndefined();
    registry.selectById(2);
    expect(registry.consumeSelectedPageFallback()).toBeUndefined();
    await second.page.close();
    runtime.setPages([first.page]);
    expect(() => registry.selectedPage()).toThrow('The selected page has been closed');
    await registry.refresh();
    expect(registry.selectedPage().page).toBe(first.page);
    expect(registry.consumeSelectedPageFallback()).toEqual({ wasClosed: true });
    expect(registry.consumeSelectedPageFallback()).toBeUndefined();
    await registry.newPage({ background: true });
    expect(registry.consumeSelectedPageFallback()).toBeUndefined();
    expect(runtime.browser.newPage).toHaveBeenCalledWith({ background: true });
    registry.dispose();
  });

  it('keeps the owner and live selection when a secondary-session detach omits the Page from enumeration', async () => {
    const first = fakePage('https://example.test/a');
    const second = fakePage('https://example.test/b');
    const runtime = fakeBrowser([first.page, second.page]);
    const observed = events();
    const registry = await PageRegistry.create(runtime.browser, observed);
    const collector = registry.getConsoleCollector(1);
    first.page.emit('framenavigated', first.frame);
    registry.consumeChanges();
    runtime.browser.emit('targetdestroyed', first.target);
    runtime.setPages([second.page]);
    await registry.refresh();
    expect(registry.pages().map(({ pageId }) => pageId)).toEqual([1, 2]);
    expect(registry.pageById(1)).toMatchObject({ page: first.page, navigationSequence: 1 });
    expect(registry.getConsoleCollector(1)).toBe(collector);
    expect(registry.selectedPage().page).toBe(first.page);
    expect(registry.consumeSelectedPageFallback()).toBeUndefined();
    expect(registry.consumeChanges()).toEqual({ opened: [], closed: [] });
    expect(observed.pageRemoved).not.toHaveBeenCalled();
    expect(first.page.listenerCount('dialog')).toBe(1);
    runtime.setPages([first.page, second.page]);
    await registry.refresh();
    expect(registry.pageById(1)).toMatchObject({ page: first.page, navigationSequence: 1 });
    await first.page.close();
    runtime.setPages([second.page]);
    await registry.refresh();
    expect(registry.pageById(1)).toBeUndefined();
    expect(registry.selectedPage().page).toBe(second.page);
    expect(registry.consumeSelectedPageFallback()).toEqual({ wasClosed: true });
    expect(observed.pageRemoved).toHaveBeenCalledExactlyOnceWith(1);
    expect(first.page.listenerCount('dialog')).toBe(0);
    registry.dispose();
  });

  it('preserves a Page registered while an older browser enumeration is pending', async () => {
    const first = fakePage('https://example.test/first');
    const runtime = fakeBrowser([first.page]);
    const registry = await PageRegistry.create(runtime.browser, events());
    registry.consumeChanges();
    let finish!: (pages: Page[]) => void;
    runtime.browser.pages = vi.fn(() => new Promise<Page[]>((resolve) => { finish = resolve; }));
    const refreshing = registry.refresh();
    const popup = fakePage('https://example.test/popup');
    runtime.browser.emit('targetcreated', popup.target);
    await vi.waitFor(() => expect(registry.pages()).toHaveLength(2));
    const owner = registry.pages()[1]!;
    popup.page.emit('framenavigated', popup.frame);
    finish([first.page]);
    await refreshing;
    expect(registry.pageById(owner.pageId)).toMatchObject({ page: popup.page, navigationSequence: 1 });
    expect(registry.consumeChanges()).toEqual({ opened: [expect.objectContaining({ pageId: owner.pageId, url: 'https://example.test/popup' })], closed: [] });
    registry.dispose();
  });

  it('releases a selected Page on close before Puppeteer updates isClosed and rejects closed pages from a stale snapshot', async () => {
    const first = fakePage('https://example.test/first');
    const second = fakePage('https://example.test/second');
    const runtime = fakeBrowser([first.page, second.page]);
    const screenChanged = vi.fn();
    const registry = await PageRegistry.create(runtime.browser, { ...events(), screenChanged });
    first.client.detached = true;
    first.page.emit('close');
    expect(first.page.isClosed()).toBe(false);
    expect(registry.pageById(1)).toBeUndefined();
    expect(screenChanged).toHaveBeenLastCalledWith(undefined);
    vi.mocked(first.page.isClosed).mockReturnValue(true);
    await registry.refresh();
    expect(registry.pages().map(({ pageId }) => pageId)).toEqual([2]);
    expect(registry.selectedPage().page).toBe(second.page);
    expect(registry.consumeSelectedPageFallback()).toEqual({ wasClosed: true });
    runtime.browser.emit('targetcreated', first.target);
    await Promise.resolve();
    expect(registry.pages().map(({ pageId }) => pageId)).toEqual([2]);
    expect(first.page.listenerCount('dialog')).toBe(0);
    registry.dispose();
  });

  it('ends ownership and falls back when the real Page primary session detaches before its close flag updates', async () => {
    const first = fakePage('https://example.test/first');
    const second = fakePage('https://example.test/second');
    const runtime = fakeBrowser([first.page, second.page]);
    const observed = events();
    const registry = await PageRegistry.create(runtime.browser, observed);
    registry.consumeChanges();
    first.client.detached = true;
    runtime.browser.emit('targetdestroyed', first.target);
    expect(first.page.isClosed()).toBe(false);
    expect(registry.pageById(1)).toBeUndefined();
    expect(() => registry.selectedPage()).toThrow('The selected page has been closed');
    runtime.setPages([second.page]);
    await registry.refresh();
    expect(registry.selectedPage().page).toBe(second.page);
    expect(registry.consumeSelectedPageFallback()).toEqual({ wasClosed: true });
    expect(registry.consumeChanges()).toEqual({ opened: [], closed: [expect.objectContaining({ pageId: 1 })] });
    runtime.browser.emit('targetcreated', first.target);
    await Promise.resolve();
    expect(registry.pages().map(({ pageId }) => pageId)).toEqual([2]);
    expect(observed.pageRemoved).toHaveBeenCalledExactlyOnceWith(1);
    registry.dispose();
  });

  it('finishes the existing collector attach before making a new Page the display selection', async () => {
    const first = fakePage('https://example.test/first');
    const next = fakePage('about:blank');
    let finish!: (session: import('puppeteer-core').CDPSession) => void;
    next.page.createCDPSession = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const runtime = fakeBrowser([first.page]);
    runtime.browser.newPage = vi.fn(async () => {
      runtime.setPages([first.page, next.page]);
      runtime.browser.emit('targetcreated', next.target);
      return next.page;
    });
    const registry = await PageRegistry.create(runtime.browser, events());
    const creating = registry.newPage();
    await vi.waitFor(() => expect(next.page.createCDPSession).toHaveBeenCalledOnce());
    expect(registry.pages()[1]).toMatchObject({ page: next.page });
    expect(registry.selectedPage().page).toBe(first.page);
    finish(Object.assign(new EventEmitter(), { detach: vi.fn(async () => {}) }) as unknown as import('puppeteer-core').CDPSession);
    const owner = await creating;
    expect(registry.selectedPage().pageId).toBe(owner.pageId);
    expect(registry.selectedPage().page).toBe(next.page);
    expect(next.page.createCDPSession).toHaveBeenCalledOnce();
    registry.dispose();
  });

  it('creates and reuses named isolated contexts and selects new background pages', async () => {
    const first = fakePage('https://example.test/a');
    const runtime = fakeBrowser([first.page]);
    const contexts: import('puppeteer-core').BrowserContext[] = [];
    const pages = [first.page];
    const context = { closed: false, newPage: vi.fn(async () => {
      const page = fakePage('about:blank', context as unknown as import('puppeteer-core').BrowserContext).page;
      pages.push(page); runtime.setPages(pages); return page;
    }) };
    runtime.browser.browserContexts = () => contexts;
    runtime.browser.createBrowserContext = vi.fn(async () => {
      contexts.push(context as unknown as import('puppeteer-core').BrowserContext);
      return context as unknown as import('puppeteer-core').BrowserContext;
    });
    const registry = await PageRegistry.create(runtime.browser, events());
    const second = await registry.newPage({ isolatedContext: 'sample-context', background: true });
    const third = await registry.newPage({ isolatedContext: 'sample-context', background: false });
    expect(runtime.browser.createBrowserContext).toHaveBeenCalledOnce();
    expect(context.newPage).toHaveBeenNthCalledWith(1, { background: true });
    expect(context.newPage).toHaveBeenNthCalledWith(2, { background: false });
    expect(second.isolatedContextName).toBe('sample-context');
    expect(third.isolatedContextName).toBe('sample-context');
    expect(registry.selectedPage().pageId).toBe(third.pageId);
    expect(registry.consumeSelectedPageFallback()).toBeUndefined();
    registry.dispose();
  });

  it('labels an existing non-default browser context and releases its page and worker observation owners', async () => {
    const context = { closed: false } as import('puppeteer-core').BrowserContext;
    const first = fakePage('https://example.test/a', context);
    const runtime = fakeBrowser([first.page]);
    runtime.browser.browserContexts = () => [context];
    const registry = await PageRegistry.create(runtime.browser, events());
    expect(registry.pages()[0].isolatedContextName).toBe('isolated-context-1');
    const worker = registry.getServiceWorkerConsoleCollector();
    const release = vi.spyOn(worker, 'dispose');
    registry.dispose();
    expect(release).toHaveBeenCalledOnce();
    expect(runtime.browser.listenerCount('targetcreated')).toBe(0);
    expect(first.frame.eventNames()).toEqual([]);
  });
  it('clears an automatic fallback note when explicitly selecting the same page or creating from zero pages', async () => {
    const first = fakePage('https://example.test/a');
    const second = fakePage('https://example.test/b');
    const runtime = fakeBrowser([first.page, second.page]);
    const registry = await PageRegistry.create(runtime.browser, events());
    await first.page.close(); runtime.setPages([second.page]); await registry.refresh();
    registry.selectById(2);
    expect(registry.consumeSelectedPageFallback()).toBeUndefined();
    await second.page.close(); runtime.setPages([]); await registry.refresh();
    expect(registry.pages()).toEqual([]);
    const created = await registry.newPage({ background: true });
    expect(registry.selectedPage().page).toBe(created.page);
    expect(registry.consumeSelectedPageFallback()).toBeUndefined();
    registry.dispose();
  });

});

describe('default URL policy at page owner registration', () => {
  beforeEach(() => PageRegistry.resetPageIdsForTesting());
  const events = () => ({ selectedPageChanged: vi.fn(), mainFrameNavigated: vi.fn(), pageRemoved: vi.fn() });
  const restrictedUrls = [
    'devtools://devtools/bundled/inspector.html', 'chrome://settings/', 'chrome://extensions/',
    'chrome-untrusted://new-tab-page/', 'chrome-extension://sample-extension/page.html',
  ];

  it('filters initial enumeration while tracking regular pages and the source Chrome exceptions', async () => {
    const restricted = restrictedUrls.map((url) => fakePage(url));
    const allowed = ['https://example.test/sample', 'about:blank', 'data:text/html,Sample%20page',
      'chrome://newtab/', 'chrome://new-tab-page/', 'chrome://inspect/#devices'].map((url) => fakePage(url));
    const runtime = fakeBrowser([...restricted.map(({ page }) => page), ...allowed.map(({ page }) => page)]);
    const registry = await PageRegistry.create(runtime.browser, events());
    expect(registry.pages().map(({ page }) => page.url())).toEqual(allowed.map(({ page }) => page.url()));
    expect(registry.pages().map(({ pageId }) => pageId)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(registry.selectedPage().page).toBe(allowed[0].page);
    for (const denied of restricted) {
      expect(denied.page.eventNames()).toEqual([]);
      expect(denied.page.emulateFocusedPage).not.toHaveBeenCalled();
    }
    registry.dispose();
  });

  it('applies the same policy to popup target registration without consuming page IDs or selecting them', async () => {
    const first = fakePage('https://example.test/first');
    const runtime = fakeBrowser([first.page]);
    const registry = await PageRegistry.create(runtime.browser, events());
    registry.consumeChanges();
    const rejected = restrictedUrls.map((url) => fakePage(url));
    for (const denied of rejected) runtime.browser.emit('targetcreated', denied.target);
    const popup = fakePage('https://example.test/popup');
    runtime.browser.emit('targetcreated', popup.target);
    await vi.waitFor(() => expect(registry.pages()).toHaveLength(2));
    expect(registry.pages()[1]).toMatchObject({ pageId: 2, page: popup.page });
    expect(registry.selectedPage().page).toBe(first.page);
    expect(registry.consumeChanges().opened).toEqual([expect.objectContaining({ pageId: 2, url: 'https://example.test/popup' })]);
    for (const denied of rejected) expect(denied.page.eventNames()).toEqual([]);
    registry.dispose();
  });

  it('filters manually opened pages discovered by refresh and keeps the allowed selected identity', async () => {
    const first = fakePage('https://example.test/first');
    const runtime = fakeBrowser([first.page]);
    const registry = await PageRegistry.create(runtime.browser, events());
    const originalId = registry.selectedPage().pageId;
    const denied = fakePage('chrome-extension://sample-extension/page.html');
    const allowed = fakePage('chrome://inspect/#devices');
    runtime.setPages([first.page, denied.page, allowed.page]);
    const pages = await registry.refresh();
    expect(pages.map(({ page }) => page)).toEqual([first.page, allowed.page]);
    expect(registry.selectedPage().pageId).toBe(originalId);
    expect(pages[1].pageId).toBe(2);
    expect(denied.page.listenerCount('dialog')).toBe(0);
    registry.dispose();
  });

  it('prunes a now-restricted page owner while retaining its live selected Page reference without a fallback', async () => {
    const first = fakePage('https://example.test/first');
    const second = fakePage('https://example.test/second');
    const runtime = fakeBrowser([first.page, second.page]);
    const observed = events();
    const registry = await PageRegistry.create(runtime.browser, observed);
    first.page.setUrl('chrome://settings/');
    first.page.emit('framenavigated', first.frame);
    await registry.refresh();
    expect(registry.pages().map(({ pageId }) => pageId)).toEqual([2]);
    expect(registry.pageById(1)).toBeUndefined();
    expect(registry.selectedPage().page).toBe(first.page);
    expect(registry.consumeSelectedPageFallback()).toBeUndefined();
    expect(observed.selectedPageChanged).toHaveBeenCalledOnce();
    expect(observed.pageRemoved).toHaveBeenCalledExactlyOnceWith(1);
    expect(first.page.listenerCount('dialog')).toBe(0);
    expect(first.frame.eventNames()).toEqual([]);
    registry.dispose();
  });

  it('applies the registration policy when a new page changes to a restricted URL before its owner is created', async () => {
    const first = fakePage('https://example.test/first');
    const denied = fakePage('chrome-untrusted://new-tab-page/');
    const runtime = fakeBrowser([first.page]);
    runtime.browser.newPage = vi.fn(async () => { runtime.setPages([first.page, denied.page]); return denied.page; });
    const registry = await PageRegistry.create(runtime.browser, events());
    await expect(registry.newPage()).rejects.toThrow('No page found');
    expect(registry.pages().map(({ page }) => page)).toEqual([first.page]);
    expect(registry.selectedPage().page).toBe(first.page);
    expect(denied.page.eventNames()).toEqual([]);
    registry.dispose();
  });
});
