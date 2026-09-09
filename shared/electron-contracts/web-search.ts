import type { SearchExecutionResult, SearchFailure, SearchProviderPreset } from '../types/web-search.js';

export const WEB_SEARCH_OPERATIONS = {
  listProviders: 'web-search.listProviders',
  connectOAuth: 'web-search.connectOAuth',
  cancelOAuth: 'web-search.cancelOAuth',
  disconnectOAuth: 'web-search.disconnectOAuth',
  checkConnection: 'web-search.checkConnection',
  testSearch: 'web-search.testSearch',
  cancelOperation: 'web-search.cancelOperation',
} as const;

export type SearchOperationResult<T> = { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: SearchFailure }
  | { readonly ok: false; readonly cancelled: true };

export interface SearchTestOptions {
  readonly operationId: string;
  readonly revision: number;
  readonly sessionId: string;
}

export interface WebSearchClient {
  listProviders(): Promise<SearchProviderPreset[]>;
  connectOAuth(providerId: string): Promise<SearchOperationResult<void>>;
  cancelOAuth(providerId: string): Promise<void>;
  disconnectOAuth(providerId: string): Promise<void>;
  checkConnection(providerId: string, options: SearchTestOptions): Promise<SearchOperationResult<void>>;
  testSearch(providerId: string, query: string, options: SearchTestOptions): Promise<SearchOperationResult<SearchExecutionResult>>;
  cancelOperation(operationId: string): Promise<void>;
}
