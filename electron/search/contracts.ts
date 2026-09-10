import type { z } from 'zod';
import type {
  SearchAuthentication, SearchCapabilities, SearchDocument, SearchExecutionContext, SearchFailure, SearchRequest,
} from '../../shared/types/web-search.js';

export interface SearchBackend {
  search(request: SearchRequest, context: SearchExecutionContext): Promise<SearchDocument>;
}

export type ResolvedSearchAuth =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'api_key'; readonly key: string }
  | { readonly kind: 'oauth'; readonly accessToken: string };

export interface SearchBackendDependencies {
  readonly fetch: typeof globalThis.fetch;
  readonly auth: ResolvedSearchAuth;
}

export interface SearchProviderDefinition<Options extends Record<string, unknown>> {
  readonly id: string;
  readonly label: string;
  readonly authentication: readonly SearchAuthentication[];
  readonly defaults: { readonly authentication: SearchAuthentication['kind']; readonly options: Options };
  readonly readOptionsSchema: z.ZodType<Options>;
  readonly writeOptionsSchema: z.ZodType<Options>;
  getCapabilities(options: Options, authentication: SearchAuthentication['kind']): SearchCapabilities;
  createBackend(options: Options, dependencies: SearchBackendDependencies): SearchBackend;
  checkConnection?(options: Options, dependencies: SearchBackendDependencies, signal: AbortSignal): Promise<void>;
}

export class SearchError extends Error {
  constructor(readonly failure: SearchFailure) {
    super(failure.message);
    this.name = 'SearchError';
  }
}
