import { describe, expect, it } from 'vitest';
import { RuntimeSnapshotStore, type InferenceRuntimeSnapshot } from '../runtime-snapshot.js';

function snapshot(revision: number): InferenceRuntimeSnapshot {
  return {
    configRevision: revision,
    catalogVersion: `catalog-${revision}`,
    targets: new Map(),
    policies: {
      ai: {
        maxAttempts: 1,
        connectTimeoutMs: 1,
        streamIdleTimeoutMs: 1,
        retryBaseDelayMs: 0,
      },
      image: {
        maxSubmitAttempts: 1,
        submitTimeoutMs: 1,
        operationTimeoutMs: 1,
        allowResubmitAfterAccepted: false,
      },
    },
    createdAt: `revision-${revision}`,
  };
}

describe('RuntimeSnapshotStore', () => {
  it('keeps explicitly published historical revisions without changing the current snapshot', () => {
    const store = new RuntimeSnapshotStore();
    const first = snapshot(1);
    const second = snapshot(2);
    const historical = snapshot(0);

    store.publish(first);
    store.publish(second);
    store.retainHistorical(historical);

    expect(store.capture()).toBe(second);
    expect(store.captureRevision(0)).toBe(historical);
    expect(store.captureRevision(1)).toBe(first);
    expect(store.captureRevision(2)).toBe(second);
  });
});
