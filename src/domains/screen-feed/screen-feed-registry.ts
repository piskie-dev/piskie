import StreamWorker from '../../workers/screen-stream.worker?worker';
import { requestBrowserStreamPort } from '@/services/screen-stream-port';
import {
  ScreenFeed,
  type ScreenFeedDependencies,
  type ScreenWorkerLike,
  type ViewportLease,
} from './screen-feed';
import type { ViewportDemand } from './worker-protocol';

const RELEASE_GRACE_MS = 120;

export interface AcquireViewportOptions {
  readonly agentId: string;
  readonly browserId: string;
  readonly interactive: boolean;
  readonly demand: ViewportDemand;
}

export interface ScreenFeedRegistry {
  acquireViewport(options: AcquireViewportOptions): ViewportLease;
  activeFeedCount(): number;
  close(): Promise<void>;
}

interface RegistryEntry {
  readonly browserId: string;
  readonly feed: ScreenFeed;
  cancelRelease: (() => void) | null;
}

export function createScreenFeedRegistry(
  overrides: Partial<ScreenFeedDependencies> = {},
): ScreenFeedRegistry {
  const dependencies: ScreenFeedDependencies = {
    requestPort: requestBrowserStreamPort,
    createWorker: () => new StreamWorker() as ScreenWorkerLike,
    scheduleFrame,
    scheduleDelay,
    onCloseDegraded: (agentId, browserId) => {
      console.warn('Screen feed worker close acknowledgement timed out', { agentId, browserId });
    },
    ...overrides,
  };
  const feeds = new Map<string, RegistryEntry>();
  const closingFeeds = new Set<Promise<void>>();
  let accepting = true;
  let closePromise: Promise<void> | null = null;

  const closeFeed = (feed: ScreenFeed): Promise<void> => {
    const pending = feed.close();
    closingFeeds.add(pending);
    void pending.finally(() => closingFeeds.delete(pending));
    return pending;
  };

  const scheduleRelease = (agentId: string, entry: RegistryEntry) => {
    if (!accepting || entry.feed.leaseCount() > 0 || entry.cancelRelease) return;
    entry.cancelRelease = dependencies.scheduleDelay(() => {
      entry.cancelRelease = null;
      if (entry.feed.leaseCount() > 0 || feeds.get(agentId) !== entry) return;
      feeds.delete(agentId);
      void closeFeed(entry.feed);
    }, RELEASE_GRACE_MS);
  };

  return {
    acquireViewport(options) {
      if (!accepting) throw new Error('ScreenFeedRegistry is closed');
      let entry = feeds.get(options.agentId);
      if (entry && entry.browserId !== options.browserId) {
        entry.cancelRelease?.();
        feeds.delete(options.agentId);
        void closeFeed(entry.feed);
        entry = undefined;
      }
      if (!entry) {
        entry = {
          browserId: options.browserId,
          feed: new ScreenFeed(options.agentId, options.browserId, dependencies),
          cancelRelease: null,
        };
        feeds.set(options.agentId, entry);
      }
      entry.cancelRelease?.();
      entry.cancelRelease = null;
      const current = entry;
      return current.feed.createLease(options.interactive, options.demand, () => {
        scheduleRelease(options.agentId, current);
      });
    },
    activeFeedCount() {
      return feeds.size;
    },
    close() {
      if (closePromise) return closePromise;
      accepting = false;
      const active = [...feeds.values()];
      feeds.clear();
      for (const entry of active) {
        entry.cancelRelease?.();
        entry.cancelRelease = null;
      }
      closePromise = (async () => {
        await Promise.all(active.map((entry) => closeFeed(entry.feed)));
        while (closingFeeds.size > 0) await Promise.all([...closingFeeds]);
      })();
      return closePromise;
    },
  };
}

function scheduleFrame(callback: () => void): () => void {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(callback, 0);
  return () => clearTimeout(id);
}

function scheduleDelay(callback: () => void, delayMs: number): () => void {
  const id = setTimeout(callback, delayMs);
  return () => clearTimeout(id);
}
