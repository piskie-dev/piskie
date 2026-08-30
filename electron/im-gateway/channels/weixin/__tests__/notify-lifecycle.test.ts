import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { weixinPlugin } from '../vendor/src/channel.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Weixin online notification lifecycle', () => {
  it('hard-aborts notifyStop at the supplied bound and resolves best-effort', async () => {
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      fetchSignal = init.signal as AbortSignal;
      fetchSignal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    })));

    const stopping = weixinPlugin.gateway.stopAccount({
      account: {
        accountId: 'account-1',
        configured: true,
        token: 'token',
        baseUrl: 'https://example.test',
      },
      timeoutMs: 25,
    });
    await vi.advanceTimersByTimeAsync(25);
    await expect(stopping).resolves.toBeUndefined();
    expect(fetchSignal?.aborted).toBe(true);
  });
});
