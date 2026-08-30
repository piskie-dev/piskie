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
      signal
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
      getSelectedPage: vi.fn(() => page),
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
      getSelectedPage: vi.fn(() => page),
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

    expect(page.goto).toHaveBeenCalledWith('https://example.test/', { timeout: 0 });
    expect(automation.waitForAction).toHaveBeenLastCalledWith(expect.any(Function), {
      navigationTimeoutMs: 0,
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
      getSelectedPage: vi.fn(() => page),
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
