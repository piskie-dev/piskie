import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const automation = {};
  const runExclusive = vi.fn(
    async (_browserId: string, operation: (session: { automation: object }) => unknown) =>
      operation({ automation })
  );
  return { automation, runExclusive };
});

vi.mock('../browser-manager.js', () => ({
  BrowserManager: { runExclusive: mocks.runExclusive },
}));

import { BrowserOperations, type BrowserNavigationResult } from '../browser-operations.js';
import type { BrowserAutomationSession } from '../../session/browser-automation-session.js';

describe('BrowserOperations', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('owns navigation locking and passes only session-scoped inputs to the operation', async () => {
    const signal = new AbortController().signal;
    const result: BrowserNavigationResult = {
      type: 'url',
      url: 'https://example.test/',
      title: 'Example',
      message: 'Successfully navigated to https://example.test/.',
      receipt: {
        navigated: true,
        domSettled: true,
        openedPageIds: [],
        closedPageIds: [],
      },
    };
    const navigateInSession = vi
      .spyOn(BrowserOperations, 'navigateInSession')
      .mockResolvedValue(result);

    await expect(BrowserOperations.navigate({
      browserId: 'browser-1',
      type: 'url',
      url: result.url,
      timeout: 1_234,
      signal,
    })).resolves.toBe(result);

    expect(mocks.runExclusive).toHaveBeenCalledOnce();
    expect(mocks.runExclusive).toHaveBeenCalledWith(
      'browser-1',
      expect.any(Function),
      signal,
      { pageId: undefined, feedback: true },
    );
    expect(navigateInSession).toHaveBeenCalledWith(mocks.automation, {
      type: 'url',
      url: result.url,
      timeout: 1_234,
    });
  });

  it('accepts and clears beforeunload while preserving the requested navigation result', async () => {
    const page = {
      goto: vi.fn(async () => undefined),
      url: vi.fn(() => 'https://example.test/after'),
      title: vi.fn(async () => 'After'),
    };
    const receipt = {
      navigated: true,
      domSettled: true,
      dialogHandled: true,
      dialog: {
        type: 'beforeunload',
        message: 'Leave this page?',
        defaultValue: '',
        handled: true,
      },
      openedPageIds: [],
      closedPageIds: [],
    };
    const automation = {
      getPage: vi.fn(() => page),
      waitForAction: vi.fn(async (action: () => Promise<void>) => {
        await action();
        return receipt;
      }),
      clearDialog: vi.fn(),
    } as unknown as BrowserAutomationSession;

    await expect(BrowserOperations.navigateInSession(automation, {
      type: 'url',
      url: 'https://example.test/after',
      timeout: 1_234,
    })).resolves.toMatchObject({
      type: 'url',
      url: 'https://example.test/after',
      title: 'After',
    });

    expect(automation.waitForAction).toHaveBeenCalledWith(expect.any(Function), {
      pageId: undefined,
      navigationTimeoutMs: 1_234,
      handleDialog: { beforeunload: 'accept' },
    });
    expect(automation.clearDialog).toHaveBeenCalledOnce();
  });

  it('keeps the upstream navigation parameter errors and timeout transform', async () => {
    const page = {
      goto: vi.fn(async () => undefined),
      url: vi.fn(() => 'about:blank'),
      title: vi.fn(async () => ''),
    };
    const automation = {
      getPage: vi.fn(() => page),
      waitForAction: vi.fn(async (action: () => Promise<void>) => {
        await action();
        return {
          navigated: false,
          domSettled: true,
          openedPageIds: [],
          closedPageIds: [],
        };
      }),
      clearDialog: vi.fn(),
    } as unknown as BrowserAutomationSession;

    await expect(BrowserOperations.navigateInSession(automation, {})).rejects.toThrow(
      'Either URL or a type is required.'
    );
    await expect(BrowserOperations.navigateInSession(automation, {
      type: 'url',
    })).rejects.toThrow('A URL is required for navigation of type=url.');
    await BrowserOperations.navigateInSession(automation, {
      type: 'url',
      url: 'https://example.test/',
      timeout: 0,
    });

    expect(page.goto).toHaveBeenCalledWith('https://example.test/', { timeout: undefined });
    expect(automation.waitForAction).toHaveBeenLastCalledWith(expect.any(Function), {
      pageId: undefined,
      navigationTimeoutMs: undefined,
      handleDialog: { beforeunload: 'accept' },
    });
  });

  it('returns the upstream navigation error result after a dispatched navigation fails', async () => {
    const page = {
      goto: vi.fn(async () => {
        throw new Error('net::ERR_NAME_NOT_RESOLVED');
      }),
      url: vi.fn(() => 'chrome-error://chromewebdata/'),
      title: vi.fn(async () => 'Error'),
    };
    const receipt = {
      navigated: true,
      domSettled: false,
      openedPageIds: [],
      closedPageIds: [],
    };
    const automation = {
      getPage: vi.fn(() => page),
      waitForAction: vi.fn(async (action: () => Promise<void>) => {
        await action();
        return receipt;
      }),
    } as unknown as BrowserAutomationSession;

    await expect(BrowserOperations.navigateInSession(automation, {
      type: 'url',
      url: 'https://missing.example.test',
    })).resolves.toMatchObject({
      type: 'url',
      url: 'chrome-error://chromewebdata/',
      title: 'Error',
      error: 'net::ERR_NAME_NOT_RESOLVED',
    });
  });
});

describe('explicit navigation target and fixed-source text', () => {
  it('runs and removes an init script on the actual page and handles beforeunload at that page', async () => {
    const order: string[] = [];
    const page = {
      evaluateOnNewDocument: vi.fn(async (_script: string) => { order.push('init'); return { identifier: 'sample-script-id' }; }),
      removeScriptToEvaluateOnNewDocument: vi.fn(async () => { order.push('remove'); }),
      goto: vi.fn(async () => { order.push('navigate'); }),
      url: () => 'https://example.test/b', title: async () => 'Sample target',
    };
    const automation = {
      getPage: vi.fn(() => page), getSelectedPage: vi.fn(() => { throw new Error('Unexpected selection lookup'); }),
      waitForAction: vi.fn(async (action: () => Promise<unknown>) => {
        await action();
        return { navigated: true, domSettled: false, dialogHandled: true, openedPageIds: [], closedPageIds: [] };
      }),
      clearDialog: vi.fn(),
    } as unknown as BrowserAutomationSession;
    const result = await BrowserOperations.navigateInSession(automation, {
      pageId: 22, url: 'https://example.test/b', initScript: 'globalThis.sampleFlag = true', handleBeforeUnload: 'dismiss', timeout: 1200,
    });
    expect(order).toEqual(['init', 'navigate', 'remove']);
    expect(automation.getPage).toHaveBeenCalledWith(22);
    expect(automation.waitForAction).toHaveBeenCalledWith(expect.any(Function), {
      pageId: 22, navigationTimeoutMs: 1200, handleDialog: { beforeunload: 'dismiss' },
    });
    expect(automation.clearDialog).toHaveBeenCalledWith(22);
    expect(page.removeScriptToEvaluateOnNewDocument).toHaveBeenCalledExactlyOnceWith('sample-script-id');
    expect(result).toMatchObject({ url: 'https://example.test/b', title: 'Sample target', message: 'Successfully navigated to https://example.test/b.' });
  });

  it.each([
    ['url', 'Unable to navigate in the selected page: Sample navigation failure.'],
    ['back', 'Unable to navigate back in the selected page: Sample navigation failure.'],
    ['forward', 'Unable to navigate forward in the selected page: Sample navigation failure.'],
    ['reload', 'Unable to reload the selected page: Sample navigation failure.'],
  ] as const)('preserves the source Unable result for %s and removes the one-navigation script', async (type, message) => {
    const failure = new Error('Sample navigation failure');
    const page = {
      goto: vi.fn(async () => { throw failure; }), goBack: vi.fn(async () => { throw failure; }),
      goForward: vi.fn(async () => { throw failure; }), reload: vi.fn(async () => { throw failure; }),
      evaluateOnNewDocument: vi.fn(async () => ({ identifier: 'sample-script-id' })),
      removeScriptToEvaluateOnNewDocument: vi.fn(async () => {}), url: () => 'https://example.test/after', title: async () => 'Sample title',
    };
    const automation = {
      getPage: () => page, clearDialog: vi.fn(),
      waitForAction: async (action: () => Promise<unknown>) => {
        await action(); return { navigated: false, domSettled: false, openedPageIds: [], closedPageIds: [] };
      },
    } as unknown as BrowserAutomationSession;
    await expect(BrowserOperations.navigateInSession(automation, {
      pageId: 22, type, url: type === 'url' ? 'https://example.test/sample' : undefined,
      initScript: 'globalThis.sampleFlag = true', ignoreCache: true,
    })).resolves.toMatchObject({ message, error: failure.message });
    expect(page.removeScriptToEvaluateOnNewDocument).toHaveBeenCalledOnce();
  });
  it('bounds the optional title read on a paused renderer without replacing navigation text', async () => {
    vi.useFakeTimers();
    try {
      const page = { goto: async () => {}, url: () => 'https://example.test/after', title: () => new Promise<string>(() => {}) };
      const automation = {
        getPage: () => page,
        waitForAction: async (action: () => Promise<unknown>) => {
          await action(); return { navigated: true, domSettled: false, openedPageIds: [], closedPageIds: [] };
        },
      } as unknown as BrowserAutomationSession;
      const result = BrowserOperations.navigateInSession(automation, { pageId: 22, url: 'https://example.test/after' });
      await vi.advanceTimersByTimeAsync(1000);
      await expect(result).resolves.toMatchObject({ title: '', message: 'Successfully navigated to https://example.test/after.' });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

});
