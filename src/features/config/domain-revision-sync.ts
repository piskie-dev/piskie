import type { ConfigDomainRevisionChangedEvent } from '../../../shared/types/config';

export interface ConfigDomainVersionSnapshot {
  revision?: number;
  descriptorHash?: string;
}

export interface ConfigDomainRevisionSyncOptions {
  domain: string;
  subscribe: (
    listener: (event: ConfigDomainRevisionChangedEvent) => void,
  ) => () => void;
  getSnapshot: () => ConfigDomainVersionSnapshot;
  refresh: () => Promise<void>;
  onError?: (error: unknown) => void;
}

export function shouldRefreshConfigDomain(
  event: ConfigDomainRevisionChangedEvent,
  snapshot: ConfigDomainVersionSnapshot,
): boolean {
  if (snapshot.revision === undefined) return true;
  if (event.revision > snapshot.revision) return true;
  if (event.revision < snapshot.revision) return false;
  return event.descriptorHash !== snapshot.descriptorHash;
}

export function subscribeToConfigDomainRevisions(
  options: ConfigDomainRevisionSyncOptions,
): () => void {
  let disposed = false;
  let running = false;
  let pending: ConfigDomainRevisionChangedEvent | undefined;

  const synchronize = async (): Promise<void> => {
    if (running || disposed) return;
    running = true;
    try {
      while (pending && !disposed) {
        const target = pending;
        pending = undefined;
        if (!shouldRefreshConfigDomain(target, options.getSnapshot())) continue;
        await options.refresh();

        // A refresh already in flight before Apply may have read the old revision.
        if (!disposed && shouldRefreshConfigDomain(target, options.getSnapshot())) {
          await options.refresh();
          if (shouldRefreshConfigDomain(target, options.getSnapshot())) {
            throw new Error(
              `Config domain ${options.domain} did not reach revision ${target.revision} after refresh`,
            );
          }
        }
      }
    } catch (error) {
      pending = undefined;
      try {
        options.onError?.(error);
      } catch {
        // Error reporting is isolated from the event subscription lifecycle.
      }
    } finally {
      running = false;
      if (pending && !disposed) void synchronize();
    }
  };

  const unsubscribe = options.subscribe((event) => {
    if (disposed || event.domain !== options.domain) return;
    if (!shouldRefreshConfigDomain(event, options.getSnapshot())) return;
    if (!pending
      || event.revision > pending.revision
      || event.revision === pending.revision) {
      pending = event;
    }
    void synchronize();
  });

  return () => {
    disposed = true;
    pending = undefined;
    unsubscribe();
  };
}
