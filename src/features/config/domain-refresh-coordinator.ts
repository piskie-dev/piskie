import type { ConfigDomainRevisionChangedEvent } from '../../../shared/types/config';

export type ConfigDomainRefreshers = Readonly<Record<string, () => Promise<void>>>;

export function subscribeToConfigDomainRefreshes(
  refreshers: ConfigDomainRefreshers,
  onError?: (domain: string, error: unknown) => void,
): () => void {
  const pending = new Map<string, Promise<void>>();
  return window.piskie.configuration.observeChanges((event: ConfigDomainRevisionChangedEvent) => {
    const refresh = refreshers[event.domain];
    if (!refresh) return;
    const previous = pending.get(event.domain) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(refresh)
      .catch((error) => onError?.(event.domain, error))
      .finally(() => {
        if (pending.get(event.domain) === current) pending.delete(event.domain);
      });
    pending.set(event.domain, current);
  });
}
