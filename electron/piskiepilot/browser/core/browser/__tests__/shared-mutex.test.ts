import { describe, expect, it } from 'vitest';

import { Mutex } from '../shared-mutex.js';

describe('Mutex cancellation', () => {
  it('removes an aborted waiter without blocking the next owner', async () => {
    const mutex = new Mutex();
    const first = await mutex.acquire();
    const controller = new AbortController();
    const reason = new Error('stop waiting');

    const cancelled = mutex.acquire(controller.signal);
    const next = mutex.acquire();
    controller.abort(reason);

    await expect(cancelled).rejects.toBe(reason);
    first.dispose();
    const nextGuard = await next;
    nextGuard.dispose();

    const finalGuard = await mutex.acquire();
    finalGuard.dispose();
  });

  it('does not acquire a lock for an already aborted signal', async () => {
    const mutex = new Mutex();
    const controller = new AbortController();
    const reason = new Error('already stopped');
    controller.abort(reason);

    await expect(mutex.acquire(controller.signal)).rejects.toBe(reason);
    const guard = await mutex.acquire();
    guard.dispose();
  });
});
