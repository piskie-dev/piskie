import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sendMessageItemWeixin, sendMessageWeixin } from '../vendor/src/messaging/send.js';

function response(status: number, body = '{"ret":0}'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn(async () => body),
  } as unknown as Response;
}

function send(signal?: AbortSignal, runId?: string) {
  return sendMessageWeixin({
    to: 'user@im.wechat',
    text: 'hello',
    opts: {
      baseUrl: 'https://example.test/',
      token: 'test-token',
      contextToken: 'test-context',
      timeoutMs: 1000,
      abortSignal: signal,
      runId,
    },
  });
}

describe('Weixin send retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('retries transient failures with the same client_id', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(response(503, 'temporarily unavailable'))
      .mockResolvedValueOnce(response(200));
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = send();
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toMatchObject({ messageId: expect.any(String) });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const clientIds = fetchMock.mock.calls.map(([, init]) =>
      JSON.parse(String((init as RequestInit).body)).msg.client_id as string
    );
    expect(new Set(clientIds).size).toBe(1);
  });

  it('does not retry a non-retryable 4xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(400, 'bad request'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(send()).rejects.toThrow('sendMessage 400');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a Weixin business rejection or malformed JSON', async () => {
    const rejected = vi.fn().mockResolvedValue(response(200, '{"ret":-1,"errmsg":"request timed out"}'));
    vi.stubGlobal('fetch', rejected);
    await expect(send()).rejects.toThrow('ret=-1');
    expect(rejected).toHaveBeenCalledTimes(1);

    const malformed = vi.fn().mockResolvedValue(response(200, 'not-json'));
    vi.stubGlobal('fetch', malformed);
    await expect(send()).rejects.toThrow();
    expect(malformed).toHaveBeenCalledTimes(1);
  });

  it('retries native items with the same client_id and run_id', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(503, 'temporarily unavailable'))
      .mockResolvedValueOnce(response(200));
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = sendMessageItemWeixin({
      to: 'user@im.wechat',
      item: {
        type: 11,
        is_completed: false,
        tool_call_start_item: { tool_name: 'demo', tool_call_id: 'toolu_1' },
      },
      opts: {
        baseUrl: 'https://example.test/',
        token: 'test-token',
        contextToken: 'test-context',
        runId: 'run-1',
      },
    });
    await vi.runAllTimersAsync();
    await expect(resultPromise).resolves.toMatchObject({ messageId: expect.any(String) });

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)).msg);
    expect(new Set(bodies.map((body) => body.client_id)).size).toBe(1);
    expect(bodies.map((body) => body.run_id)).toEqual(['run-1', 'run-1']);
  });

  it('stops after the bounded number of attempts', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = send();
    const rejection = expect(resultPromise).rejects.toThrow('fetch failed');
    await vi.runAllTimersAsync();

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('cancels retry immediately when the connector is aborted', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const resultPromise = send(controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    await expect(resultPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
