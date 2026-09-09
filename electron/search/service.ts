import { z } from 'zod';
import { Agent } from 'undici';
import { BASIC_SEARCH_CAPABILITIES } from '../../shared/types/web-search.js';
import type {
  SearchCapabilities, SearchExecutionContext, SearchExecutionResult, SearchPort, SearchProviderPreset, SearchRequest, WebSearchConfig,
} from '../../shared/types/web-search.js';
import { resolvePublishedProxyFetch, type ProxyFetchResolver } from '../core/proxy/proxy-fetch.js';
import { SearchAuth } from './auth.js';
import { normalizeSearchError, searchError, unsupportedSearchFilters } from './errors.js';
import { searchProviders, type RegisteredSearchProvider } from './providers/index.js';
import { raceAbort } from '../utils/abort.js';
import { SEARCH_TIMEOUTS } from './timeouts.js';

export class SearchService implements SearchPort {
  private config: WebSearchConfig | undefined;
  private readonly calls = new Set<Promise<unknown>>();
  private readonly dispatcher = new Agent({ connect: {
    timeout: SEARCH_TIMEOUTS.connectMs,
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: SEARCH_TIMEOUTS.addressAttemptMs,
  } });
  // A configured proxy can replace this default dispatcher through RequestInit.
  private readonly fetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, {
    dispatcher: this.dispatcher, ...init,
  } as RequestInit);

  constructor(
    readonly auth: SearchAuth,
    private readonly providers: ReadonlyMap<string, RegisteredSearchProvider> = searchProviders,
    private readonly resolveFetch: ProxyFetchResolver = resolvePublishedProxyFetch,
  ) {}

  get revision(): number | undefined { return this.config?.revision; }

  get capabilities(): SearchCapabilities {
    const config = this.config;
    if (!config?.enabled || !config.defaultProvider) return BASIC_SEARCH_CAPABILITIES;
    const { definition, config: provider } = this.configuredProvider(config.defaultProvider);
    return definition.bind(provider.options).getCapabilities(provider.authentication);
  }

  publish(config: WebSearchConfig): void {
    this.config = structuredClone(config);
  }

  async listProviders(): Promise<SearchProviderPreset[]> {
    return Promise.all([...this.providers.values()].map(async (provider) => ({
      id: provider.id, label: provider.label, authentication: provider.authentication,
      defaults: provider.defaults, optionsSchema: z.toJSONSchema(provider.writeOptionsSchema), connectionCheck: provider.connectionCheck,
      oauth: await this.auth.status(provider),
    })));
  }

  search(request: SearchRequest, context: SearchExecutionContext): Promise<SearchExecutionResult> {
    return this.track(context.signal, async (signal) => {
      const config = this.config;
      if (config && !config.enabled) throw searchError('disabled');
      if (!config?.defaultProvider) throw searchError('not_configured');
      return this.executeSearch(config.defaultProvider, request, { ...context, signal });
    });
  }

  testSearch(providerId: string, request: SearchRequest, context: SearchExecutionContext): Promise<SearchExecutionResult> {
    return this.track(context.signal, (signal) => this.executeSearch(providerId, request, { ...context, signal }));
  }

  checkConnection(providerId: string, signal: AbortSignal): Promise<void> {
    return this.track(signal, async (requestSignal) => {
      const { factory, dependencies } = await this.prepare(providerId, requestSignal);
      if (!factory.checkConnection) throw searchError('not_configured');
      await factory.checkConnection(dependencies, requestSignal);
    });
  }

  connectOAuth(providerId: string, signal: AbortSignal, openUrl: (url: string) => Promise<void>): Promise<void> {
    const { definition, config } = this.configuredProvider(providerId);
    return this.auth.connect(definition, this.resolveFetch(config.proxyId, this.fetch), signal, openUrl);
  }

  cancelOAuth(providerId: string): Promise<void> {
    return this.auth.cancel(providerId);
  }

  disconnectOAuth(providerId: string): Promise<void> {
    const definition = this.providers.get(providerId);
    if (!definition) throw searchError('not_configured');
    return this.auth.disconnect(definition);
  }

  async close(): Promise<void> {
    await this.auth.close();
    await Promise.allSettled([...this.calls]);
    await this.dispatcher.close();
  }

  private configuredProvider(providerId: string) {
    const definition = this.providers.get(providerId);
    const config = this.config?.providers[providerId];
    if (!definition || !config) throw searchError('not_configured');
    return { definition, config };
  }

  private async prepare(providerId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const { definition, config } = this.configuredProvider(providerId);
    if (!config.enabled) throw searchError('not_configured');
    try {
      const fetch = this.resolveFetch(config.proxyId, this.fetch);
      const auth = await this.auth.resolve(definition, config, fetch, signal);
      signal.throwIfAborted();
      return { factory: definition.bind(config.options), dependencies: { fetch, auth } };
    } catch (error) {
      throw normalizeSearchError(error, signal, config.apiKey ? [config.apiKey] : []);
    }
  }

  private async executeSearch(
    providerId: string, request: SearchRequest, context: SearchExecutionContext,
  ): Promise<SearchExecutionResult> {
    const started = performance.now();
    const { factory, dependencies } = await this.prepare(providerId, context.signal);
    try {
      const capabilities = factory.getCapabilities(dependencies.auth.kind);
      const unsupported = (Object.keys(capabilities) as Array<keyof SearchCapabilities>)
        .filter((field) => request[field] !== undefined && !capabilities[field]);
      if (unsupported.length) throw unsupportedSearchFilters(unsupported);
      const document = await factory.createBackend(dependencies).search(request, context);
      context.signal.throwIfAborted();
      return {
        document,
        diagnostics: {
          providerId, durationMs: Math.round(performance.now() - started),
          ...(document.evidence.kind === 'sources' ? { sourceCount: document.evidence.sources.length } : {}),
        },
      };
    } catch (error) {
      throw normalizeSearchError(error, context.signal);
    }
  }

  private async track<T>(signal: AbortSignal, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new DOMException('Search request timed out', 'TimeoutError')),
      SEARCH_TIMEOUTS.requestMs);
    timer.unref();
    const requestSignal = AbortSignal.any([signal, deadline.signal]);
    const call = raceAbort(action(requestSignal), requestSignal);
    this.calls.add(call);
    try {
      return await call;
    } catch (error) {
      throw normalizeSearchError(error, signal);
    } finally {
      clearTimeout(timer);
      this.calls.delete(call);
    }
  }
}
