import { z } from 'zod';
import { WEB_SEARCH_OPERATIONS, type SearchOperationResult, type SearchTestOptions } from '../../../shared/electron-contracts/web-search.js';
import { SearchError } from '../../search/contracts.js';
import type { SearchService } from '../../search/service.js';
import type { ControllerContext, OperationDefinition } from '../catalog.js';
import { PublicOperationError } from '../public-errors.js';
import { identifier } from '../validation.js';

const testOptions = z.strictObject({ operationId: identifier, revision: z.number().int().nonnegative(), sessionId: identifier });

export function createWebSearchController(service: SearchService, openUrl: (url: string) => Promise<void>) {
  const pending = new Map<string, { controller: AbortController; done: Promise<unknown> }>();
  const key = (context: ControllerContext, operationId: string) => `${context.connectionId}:${operationId}`;

  async function test<T>(
    context: ControllerContext, options: SearchTestOptions, action: (signal: AbortSignal) => Promise<T>,
  ): Promise<SearchOperationResult<T>> {
    if (service.revision !== options.revision) {
      throw new PublicOperationError('conflict', 'Search settings changed; save and run the test again.');
    }
    const operationKey = key(context, options.operationId);
    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal]);
    pending.get(operationKey)?.controller.abort();
    const done = outcome(() => action(signal));
    const operation = { controller, done };
    pending.set(operationKey, operation);
    try { return await done; } finally {
      if (pending.get(operationKey) === operation) pending.delete(operationKey);
    }
  }

  const operations: readonly OperationDefinition[] = [
    operation(WEB_SEARCH_OPERATIONS.listProviders, z.tuple([]), () => service.listProviders()),
    operation(WEB_SEARCH_OPERATIONS.connectOAuth, z.tuple([identifier]), (context, [id]) => (
      outcome(() => service.connectOAuth(id, context.signal, openUrl))
    )),
    operation(WEB_SEARCH_OPERATIONS.cancelOAuth, z.tuple([identifier]), (_context, [id]) => service.cancelOAuth(id)),
    operation(WEB_SEARCH_OPERATIONS.disconnectOAuth, z.tuple([identifier]), (_context, [id]) => service.disconnectOAuth(id)),
    operation(WEB_SEARCH_OPERATIONS.checkConnection, z.tuple([identifier, testOptions]), (context, [id, options]) => (
      test(context, options, (signal) => service.checkConnection(id, signal))
    )),
    operation(WEB_SEARCH_OPERATIONS.testSearch, z.tuple([identifier, z.string().trim().min(1), testOptions]), (context, [id, query, options]) => (
      test(context, options, (signal) => service.testSearch(id, { query }, { signal, sessionId: `settings:${options.sessionId}` }))
    )),
    operation(WEB_SEARCH_OPERATIONS.cancelOperation, z.tuple([identifier]), async (context, [id]) => {
      const operation = pending.get(key(context, id));
      operation?.controller.abort();
      await operation?.done.catch(() => undefined);
    }),
  ];
  return {
    operations,
    dispose() { for (const operation of pending.values()) operation.controller.abort(); },
  };
}

async function outcome<T>(action: () => Promise<T>): Promise<SearchOperationResult<T>> {
  try { return { ok: true, value: await action() }; } catch (error) {
    if (error instanceof SearchError) return { ok: false, failure: error.failure };
    if (error instanceof Error && error.name === 'AbortError') return { ok: false, cancelled: true };
    throw error;
  }
}

function operation<Input extends unknown[]>(
  id: string, input: z.ZodType<Input>, execute: (context: ControllerContext, input: Input) => unknown,
): OperationDefinition<Input> {
  return { id, capability: 'web-search', input, execute };
}
