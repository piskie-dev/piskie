import { describe, expect, it, vi } from 'vitest';
import type { ConfigDomainRevisionChangedEvent } from '../../../../shared/types/config';
import {
  shouldRefreshConfigDomain,
  subscribeToConfigDomainRevisions,
} from '../domain-revision-sync';

function event(
  revision: number,
  descriptorHash = 'descriptor-a',
): ConfigDomainRevisionChangedEvent {
  return {
    domain: 'inference',
    revision,
    descriptorHash,
    source: 'external',
  };
}

describe('config domain revision sync', () => {
  it('refreshes newer revisions and same revisions with a changed Descriptor', () => {
    expect(shouldRefreshConfigDomain(event(15), {
      revision: 14,
      descriptorHash: 'descriptor-a',
    })).toBe(true);
    expect(shouldRefreshConfigDomain(event(15, 'descriptor-b'), {
      revision: 15,
      descriptorHash: 'descriptor-a',
    })).toBe(true);
  });

  it('ignores stale and already observed events', () => {
    expect(shouldRefreshConfigDomain(event(14), {
      revision: 15,
      descriptorHash: 'descriptor-a',
    })).toBe(false);
    expect(shouldRefreshConfigDomain(event(15), {
      revision: 15,
      descriptorHash: 'descriptor-a',
    })).toBe(false);
  });

  it('filters domains and coalesces duplicate events during refresh', async () => {
    let listener: ((change: ConfigDomainRevisionChangedEvent) => void) | undefined;
    let snapshot = { revision: 14, descriptorHash: 'descriptor-a' };
    let release: (() => void) | undefined;
    const refresh = vi.fn(() => new Promise<void>((resolve) => {
      release = () => {
        snapshot = { revision: 15, descriptorHash: 'descriptor-a' };
        resolve();
      };
    }));
    const unsubscribe = vi.fn();
    const stop = subscribeToConfigDomainRevisions({
      domain: 'inference',
      subscribe: (next) => {
        listener = next;
        return unsubscribe;
      },
      getSnapshot: () => snapshot,
      refresh,
    });

    listener?.({ ...event(15), domain: 'appearance' });
    listener?.(event(15));
    listener?.(event(15));
    expect(refresh).toHaveBeenCalledTimes(1);
    release?.();
    await vi.waitFor(() => expect(snapshot.revision).toBe(15));
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);

    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
