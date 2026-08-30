import { describe, expect, it } from 'vitest';
import { createAttemptFetchObserver } from '../observed-fetch.js';

describe('createAttemptFetchObserver', () => {
  it('preserves a non-standard JSON error body without consuming the SDK response', async () => {
    const observer = createAttemptFetchObserver(async () => new Response(
      JSON.stringify({ detail: 'provider-specific failure' }),
      { status: 418, headers: { 'content-type': 'application/json', 'x-request-id': 'req-418' } },
    ));

    const response = await observer.fetch('https://example.test/v1/chat/completions');

    expect(await response.json()).toEqual({ detail: 'provider-specific failure' });
    expect(observer.failure()).toMatchObject({
      kind: 'http',
      status: 418,
      requestId: 'req-418',
      body: { detail: 'provider-specific failure' },
    });
  });

  it('keeps observations attempt-local under concurrency', async () => {
    const first = createAttemptFetchObserver(async () => new Response('first', { status: 500 }));
    const second = createAttemptFetchObserver(async () => new Response('second', { status: 429 }));

    await Promise.all([
      first.fetch('https://first.test'),
      second.fetch('https://second.test'),
    ]);

    expect(first.failure()).toMatchObject({ status: 500, body: 'first' });
    expect(second.failure()).toMatchObject({ status: 429, body: 'second' });
  });
});

