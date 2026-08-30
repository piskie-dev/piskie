import { describe, expect, it, vi } from 'vitest';
import { createMarketChanges } from '../change-source.js';

describe('Market changes', () => {
  it('exposes separate application publish and consumer subscribe capabilities', () => {
    const changes = createMarketChanges();
    const listener = vi.fn();
    changes.source.subscribe(listener);
    const event = { kind: 'plugin', type: 'installed', name: 'demo' } as const;

    changes.sink.publish(event);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(event);
    expect('publish' in changes.source).toBe(false);
    expect('subscribe' in changes.sink).toBe(false);
  });

  it('does not let a failed renderer consumer block another consumer', () => {
    const onSubscriberError = vi.fn();
    const changes = createMarketChanges(onSubscriberError);
    const healthy = vi.fn();
    changes.source.subscribe(() => {
      throw new Error('window gone');
    });
    changes.source.subscribe(healthy);

    changes.sink.publish({ kind: 'catalog', type: 'refreshed' });

    expect(healthy).toHaveBeenCalledOnce();
    expect(onSubscriberError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'window gone' }),
      { kind: 'catalog', type: 'refreshed' },
    );
  });
});
