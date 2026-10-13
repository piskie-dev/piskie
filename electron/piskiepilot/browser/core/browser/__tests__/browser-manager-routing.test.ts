import { EventEmitter } from 'node:events';
import type { Browser, Frame, Page } from 'puppeteer-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserAutomationSession } from '../../session/browser-automation-session.js';
import { PageRegistry } from '../../session/page-registry.js';
import { BrowserManager } from '../browser-manager.js';
import { Mutex } from '../shared-mutex.js';

const browserId = 'sample-routed-browser';
const manager = BrowserManager as unknown as { instances: Map<string, unknown> };
let session: BrowserAutomationSession;
let pages: Page[];
let browser: Browser;
function page(name: string): Page {
  const frame = Object.assign(new EventEmitter(), { _id: name }) as unknown as Frame;
  return Object.assign(new EventEmitter(), {
    url: () => `https://example.test/${name}`, mainFrame: () => frame, target: () => ({}),
    browserContext: () => null, isClosed: () => false, emulateFocusedPage: async () => {},
    setDefaultTimeout: () => {}, setDefaultNavigationTimeout: () => {},
    mouse: { move: vi.fn(async () => {}), down: vi.fn(async () => {}), up: vi.fn(async () => {}) },
  }) as unknown as Page;
}

beforeEach(async () => {
  PageRegistry.resetPageIdsForTesting();
  pages = [page('a'), page('b'), page('c')];
  browser = Object.assign(new EventEmitter(), {
    connected: true, pages: async () => pages, targets: () => [],
    browserContexts: () => [], defaultBrowserContext: () => null, disconnect: vi.fn(async () => {}),
  }) as unknown as Browser;
  session = await BrowserAutomationSession.create(browser);
  const instance = { automation: session, browser, mutex: new Mutex() };
  manager.instances.set(browserId, { getReady: () => instance });
  vi.spyOn(BrowserManager, 'getOrCreate').mockResolvedValue(browserId);
});
afterEach(() => { session.dispose(); manager.instances.clear(); vi.restoreAllMocks(); });

describe('exclusive target resolution and display', () => {
  it('resolves B before starting outer feedback while preserving selected A', async () => {
    const result = await BrowserManager.runExclusive(browserId, ({ automation }) => {
      expect(automation.getScreenTarget()?.page).toBe(pages[1]);
      expect(automation.getPage()).toBe(pages[1]);
      expect(automation.getSelectedPage()).toBe(pages[0]);
      return 'Sample result';
    }, undefined, { pageId: 2, feedback: true });
    expect(result).toBe('Sample result');
    expect(session.getScreenTarget()?.page).toBe(pages[0]);
    expect(session.getSelectedPageId()).toBe(1);
  });

  it('keeps passive page B reads outside feedback and propagates target failures', async () => {
    const events = vi.fn(); session.subscribeScreen(events); events.mockClear();
    await BrowserManager.runExclusive(browserId, ({ automation }) => {
      expect(automation.getPage()).toBe(pages[1]);
      expect(automation.getScreenTarget()?.page).toBe(pages[0]);
    }, undefined, { pageId: 2 });
    await BrowserManager.runExclusive(browserId, () => 'Sample browser read');
    const dispatch = vi.fn();
    await expect(BrowserManager.runExclusive(browserId, dispatch, undefined, { pageId: 99, feedback: true })).rejects.toThrow('No page found');
    expect(dispatch).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
  });

  it('resolves stable page IDs after acquiring the lock and restores a newer logical selection', async () => {
    let release!: () => void;
    const first = BrowserManager.runExclusive(browserId, async ({ automation }) => {
      await new Promise<void>((resolve) => { release = resolve; });
      await automation.selectPageById(3);
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const second = BrowserManager.runExclusive(browserId, ({ automation }) => {
      expect(automation.getPage()).toBe(pages[1]);
      expect(automation.getScreenTarget()?.page).toBe(pages[1]);
      expect(automation.getSelectedPageId()).toBe(3);
    }, undefined, { pageId: 2, feedback: true });
    release();
    await Promise.all([first, second]);
    expect(session.getScreenTarget()?.page).toBe(pages[2]);
  });

  it('restores selected display on cancellation before a pending callback finishes', async () => {
    const controller = new AbortController();
    let release!: () => void;
    const operation = BrowserManager.runExclusive(browserId, () => new Promise<void>((resolve) => { release = resolve; }),
      controller.signal, { pageId: 2, feedback: true });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(session.getScreenTarget()?.page).toBe(pages[1]);
    const reason = new Error('Sample cancelled operation');
    controller.abort(reason);
    await expect(operation).rejects.toBe(reason);
    expect(session.getScreenTarget()?.page).toBe(pages[0]);
    expect(browser.disconnect).toHaveBeenCalledOnce();
    release();
    await Promise.resolve();
  });
});
