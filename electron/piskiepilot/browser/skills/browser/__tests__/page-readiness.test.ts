import { describe, expect, it, vi } from 'vitest';

import browserCore from '../skill.js';

describe('browser page readiness', () => {
  it('notifies the host after new_page succeeds', async () => {
    const new_page = vi.fn(async () => 'Page opened');
    const notifyPageOpen = vi.fn();
    const signal = new AbortController().signal;

    const output = await browserCore.functions.new_page.run(
      { url: 'https://example.test' },
      {
        signal,
        browserId: 'browser-1',
        browser: {
          core: { new_page },
          notifyPageOpen,
        } as never,
        log: vi.fn(),
      },
    );

    expect(new_page).toHaveBeenCalledWith({
      url: 'https://example.test',
      browserId: 'browser-1',
      signal,
      timeout: undefined,
    });
    expect(notifyPageOpen).toHaveBeenCalledOnce();
    expect(output).toEqual({ ok: true, text: 'Page opened' });
  });

  it('does not notify the host when new_page fails', async () => {
    const error = new Error('page failed');
    const notifyPageOpen = vi.fn();

    await expect(browserCore.functions.new_page.run(
      { url: 'https://example.test' },
      {
        signal: new AbortController().signal,
        browserId: 'browser-1',
        browser: {
          core: { new_page: vi.fn(async () => Promise.reject(error)) },
          notifyPageOpen,
        } as never,
        log: vi.fn(),
      },
    )).rejects.toBe(error);

    expect(notifyPageOpen).not.toHaveBeenCalled();
  });
});
