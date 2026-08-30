import { describe, expect, it, vi } from 'vitest';

import browserCore from '../skill.js';

describe('browser page readiness', () => {
  it('notifies the host after newPage succeeds', async () => {
    const newPage = vi.fn(async () => 'Page opened');
    const notifyPageOpen = vi.fn();

    const output = await browserCore.functions.newPage.run(
      { url: 'https://example.com' },
      {
        signal: new AbortController().signal,
        browserId: 'browser-1',
        browser: {
          core: { newPage },
          notifyPageOpen,
        } as never,
        log: vi.fn(),
      },
    );

    expect(newPage).toHaveBeenCalledWith({
      url: 'https://example.com',
      browserId: 'browser-1',
    });
    expect(notifyPageOpen).toHaveBeenCalledOnce();
    expect(output).toEqual({ ok: true, text: 'Page opened' });
  });

  it('does not notify the host when newPage fails', async () => {
    const error = new Error('page failed');
    const notifyPageOpen = vi.fn();

    await expect(browserCore.functions.newPage.run(
      { url: 'https://example.com' },
      {
        signal: new AbortController().signal,
        browserId: 'browser-1',
        browser: {
          core: { newPage: vi.fn(async () => Promise.reject(error)) },
          notifyPageOpen,
        } as never,
        log: vi.fn(),
      },
    )).rejects.toBe(error);

    expect(notifyPageOpen).not.toHaveBeenCalled();
  });
});
