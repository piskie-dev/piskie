import { describe, expect, it, vi } from 'vitest';
import { createWebSearchController } from './web-search-controller.js';
import { SearchService } from '../../search/service.js';
import { SearchAuth } from '../../search/auth.js';
import { defaultWebSearchConfig } from '../../config/domains/web-search.adapter.js';
import type { ControllerContext } from '../catalog.js';

const context = (connectionId = 'sample-connection'): ControllerContext => ({
  generation: 'sample-generation', connectionId, windowId: 1, signal: new AbortController().signal,
});

describe('search settings operations', () => {
  it('cancels only the owning connection’s pending test and propagates the settings signal', async () => {
    const service = new SearchService(new SearchAuth('/tmp/example-config'));
    service.publish(defaultWebSearchConfig());
    let signal: AbortSignal | undefined;
    vi.spyOn(service, 'testSearch').mockImplementation(async (_id, _query, execution) => {
      signal = execution.signal;
      expect(execution.sessionId).toBe('settings:sample-session');
      return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
    });
    const controller = createWebSearchController(service, vi.fn());
    const operations = new Map(controller.operations.map((operation) => [operation.id, operation]));
    const owner = context();
    const search = operations.get('web-search.testSearch')!.execute(owner, ['parallel', 'sample query', {
      operationId: 'sample-test', revision: 0, sessionId: 'sample-session',
    }]);
    const cancelled = expect(search).resolves.toEqual({ ok: false, cancelled: true });
    await operations.get('web-search.cancelOperation')!.execute(context('another-connection'), ['sample-test']);
    expect(signal?.aborted).toBe(false);
    await operations.get('web-search.cancelOperation')!.execute(owner, ['sample-test']);
    await cancelled;
    expect(signal?.aborted).toBe(true);
  });

  it('rejects tests submitted against a different saved revision', async () => {
    const service = new SearchService(new SearchAuth('/tmp/example-config'));
    service.publish(defaultWebSearchConfig());
    const check = vi.spyOn(service, 'checkConnection');
    const operation = createWebSearchController(service, vi.fn()).operations.find((item) => item.id === 'web-search.checkConnection')!;
    await expect(operation.execute(context(), ['parallel', { operationId: 'sample-test', revision: 2, sessionId: 'sample-session' }]))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(check).not.toHaveBeenCalled();
  });
});
