import { describe, expect, it, vi } from 'vitest';
import { createChangeChannel } from '../change-channel.js';

describe('change channel', () => {
  it('separates publish and subscribe capabilities and preserves registration order', () => {
    const channel = createChangeChannel<number>();
    const seen: string[] = [];

    channel.source.subscribe((value) => seen.push(`first:${value}`));
    channel.source.subscribe((value) => seen.push(`second:${value}`));
    channel.sink.publish(7);

    expect(seen).toEqual(['first:7', 'second:7']);
    expect('publish' in channel.source).toBe(false);
    expect('subscribe' in channel.sink).toBe(false);
  });

  it('returns an idempotent disposer', () => {
    const channel = createChangeChannel<number>();
    const listener = vi.fn();
    const unsubscribe = channel.source.subscribe(listener);

    channel.sink.publish(1);
    unsubscribe();
    unsubscribe();
    channel.sink.publish(2);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(1);
  });

  it('binds a subscription to an AbortSignal', () => {
    const channel = createChangeChannel<number>();
    const listener = vi.fn();
    const controller = new AbortController();

    channel.source.subscribe(listener, { signal: controller.signal });
    channel.sink.publish(1);
    controller.abort();
    channel.sink.publish(2);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(1);
  });

  it('does not register against an already-aborted signal', () => {
    const channel = createChangeChannel<number>();
    const listener = vi.fn();
    const controller = new AbortController();
    controller.abort();

    const unsubscribe = channel.source.subscribe(listener, { signal: controller.signal });
    channel.sink.publish(1);
    unsubscribe();

    expect(listener).not.toHaveBeenCalled();
  });

  it('uses a listener snapshot for subscribe and unsubscribe during publication', () => {
    const channel = createChangeChannel<number>();
    const seen: string[] = [];
    let removeSecond = () => undefined;

    channel.source.subscribe((value) => {
      seen.push(`first:${value}`);
      removeSecond();
      channel.source.subscribe((next) => seen.push(`late:${next}`));
    });
    removeSecond = channel.source.subscribe((value) => seen.push(`second:${value}`));

    channel.sink.publish(1);
    channel.sink.publish(2);

    expect(seen).toEqual(['first:1', 'second:1', 'first:2', 'late:2']);
  });

  it('isolates synchronous and asynchronous subscriber failures', async () => {
    const errors: unknown[] = [];
    const channel = createChangeChannel<number>({
      onSubscriberError: (error) => errors.push(error),
    });
    const healthy = vi.fn();

    channel.source.subscribe(() => {
      throw new Error('sync failure');
    });
    channel.source.subscribe(() => Promise.reject(new Error('async failure')) as unknown as void);
    channel.source.subscribe(healthy);

    expect(() => channel.sink.publish(3)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(healthy).toHaveBeenCalledWith(3);
    expect(errors.map((error) => (error as Error).message)).toEqual([
      'sync failure',
      'async failure',
    ]);
  });

  it('isolates failures in the diagnostic callback itself', () => {
    const channel = createChangeChannel<number>({
      onSubscriberError: () => {
        throw new Error('diagnostic failure');
      },
    });
    channel.source.subscribe(() => {
      throw new Error('subscriber failure');
    });

    expect(() => channel.sink.publish(1)).not.toThrow();
  });
});
