import { useSyncExternalStore } from 'react';

import type {
  PiskieUpdateStatus,
  UpdateClient,
} from '@shared/electron-contracts/updates';

interface UpdateStatusStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => PiskieUpdateStatus | undefined;
  readonly publish: (status: PiskieUpdateStatus) => void;
}

const stores = new WeakMap<UpdateClient, UpdateStatusStore>();

export function useUpdateStatus(): PiskieUpdateStatus | undefined {
  const store = storeFor(window.piskie.updates);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function publishUpdateStatus(status: PiskieUpdateStatus): void {
  storeFor(window.piskie.updates).publish(status);
}

function storeFor(client: UpdateClient): UpdateStatusStore {
  const existing = stores.get(client);
  if (existing) return existing;
  const store = createUpdateStatusStore(client);
  stores.set(client, store);
  return store;
}

function createUpdateStatusStore(client: UpdateClient): UpdateStatusStore {
  let snapshot: PiskieUpdateStatus | undefined;
  let disconnect: (() => void) | undefined;
  let connection = 0;
  const listeners = new Set<() => void>();

  const publish = (status: PiskieUpdateStatus): void => {
    snapshot = status;
    for (const listener of [...listeners]) listener();
  };

  const connect = (): void => {
    if (disconnect) return;
    const activeConnection = ++connection;
    let observedVersion = 0;
    const applyObserved = (status: PiskieUpdateStatus): void => {
      if (activeConnection !== connection) return;
      observedVersion += 1;
      publish(status);
    };
    const unsubscribe = client.observeStatus(applyObserved);
    disconnect = () => {
      if (activeConnection !== connection) return;
      connection += 1;
      unsubscribe();
      disconnect = undefined;
    };

    const observedAtRead = observedVersion;
    void client.status().then((status) => {
      if (activeConnection === connection && observedVersion === observedAtRead) publish(status);
    }).catch(() => {
      if (activeConnection !== connection || observedVersion !== observedAtRead) return;
      publish({
        state: 'error',
        currentVersion: window.piskie.runtime.version,
        error: 'generic',
        checkedAt: new Date().toISOString(),
        retryable: true,
      });
    });
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) connect();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) disconnect?.();
      };
    },
    getSnapshot: () => snapshot,
    publish,
  };
}
