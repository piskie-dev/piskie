export interface SearchRequest {
  readonly query: string;
  readonly domains?: {
    readonly mode: 'include' | 'exclude';
    readonly values: readonly string[];
  };
  readonly publishedAfter?: string;
  readonly publishedBefore?: string;
}

export interface SearchCapabilities {
  readonly domains: boolean;
  readonly publishedAfter: boolean;
  readonly publishedBefore: boolean;
}

export const BASIC_SEARCH_CAPABILITIES: SearchCapabilities = Object.freeze({
  domains: false, publishedAfter: false, publishedBefore: false,
});

export interface SearchSource {
  readonly url: string;
  readonly title?: string;
  readonly excerpts: readonly string[];
  readonly publishedDate?: string;
}

export type SearchEvidence =
  | { readonly kind: 'sources'; readonly sources: readonly SearchSource[] }
  | { readonly kind: 'text'; readonly text: string };

export interface SearchDocument {
  readonly evidence: SearchEvidence;
  readonly notices?: readonly string[];
}

export interface SearchExecutionContext {
  readonly signal: AbortSignal;
  readonly sessionId: string;
}

export interface SearchDiagnostics {
  readonly providerId: string;
  readonly durationMs: number;
  readonly sourceCount?: number;
}

export interface SearchExecutionResult {
  readonly document: SearchDocument;
  readonly diagnostics: SearchDiagnostics;
}

export interface SearchPort {
  readonly capabilities: SearchCapabilities;
  search(request: SearchRequest, context: SearchExecutionContext): Promise<SearchExecutionResult>;
}

export type SearchAuthentication =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'api_key'; readonly signupUrl: string }
  | { readonly kind: 'oauth'; readonly resourceUrl: string; readonly scopes: readonly string[] };

export type SearchErrorCode =
  | 'disabled' | 'not_configured' | 'auth_required' | 'rate_limited'
  | 'quota_exhausted' | 'timeout' | 'upstream_error' | 'invalid_response' | 'unsupported_filter';

export interface SearchFailure {
  readonly code: SearchErrorCode;
  readonly message: string;
  readonly retryAfterMs?: number;
}

export interface SearchProviderConfig {
  readonly displayName: string;
  readonly enabled: boolean;
  readonly authentication: SearchAuthentication['kind'];
  readonly apiKey?: string;
  readonly proxyId?: string;
  readonly options?: Record<string, unknown>;
}

export interface WebSearchConfig {
  readonly revision: number;
  readonly enabled: boolean;
  readonly defaultProvider: string | null;
  readonly providers: Record<string, SearchProviderConfig>;
}

export interface SearchProviderPreset {
  readonly id: string;
  readonly label: string;
  readonly authentication: readonly SearchAuthentication[];
  readonly defaults: {
    readonly authentication: SearchAuthentication['kind'];
    readonly options: Record<string, unknown>;
  };
  readonly optionsSchema: Record<string, unknown>;
  readonly connectionCheck: boolean;
  readonly oauth: { readonly connected: boolean; readonly expiresAt?: number };
}
