import { describe, expect, it, vi } from 'vitest';

import { INFERENCE_OPERATIONS } from '../../../../shared/electron-contracts/inference.js';
import { createInferenceController } from '../inference-controller.js';

const context = {
  generation: 'generation-one',
  connectionId: 'connection-one',
  windowId: 1,
  signal: new AbortController().signal,
};

function refreshOperation(refresh: () => Promise<unknown>) {
  const controller = createInferenceController({ remoteCatalog: { refresh } } as never);
  return controller.find((operation) => operation.id === INFERENCE_OPERATIONS.refreshCatalog)!;
}

describe('inference catalog refresh controller', () => {
  it.each([
    ['updated', true],
    ['current', false],
  ] as const)('maps a completed %s refresh to an observable result', async (state, updated) => {
    const refresh = vi.fn(async () => ({ state, source: 'remote', version: 'example' }));
    const operation = refreshOperation(refresh);

    await expect(operation.execute(context, operation.input.parse([])))
      .resolves.toEqual({ updated });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('rejects a failed refresh instead of reporting false success', async () => {
    const operation = refreshOperation(vi.fn(async () => ({
      state: 'error', source: 'bundled', version: 'example', error: 'network',
    })));

    await expect(operation.execute(context, operation.input.parse([]))).rejects.toMatchObject({
      code: 'unavailable',
      options: { retryable: true },
    });
  });
});
