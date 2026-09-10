import { z } from 'zod';
import { Agent } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultWebSearchConfig } from '../../config/domains/web-search.adapter.js';
import { SearchService } from '../service.js';
import { SearchAuth } from '../auth.js';
import { registerSearchProvider, searchProviders } from '../providers/index.js';
import { BASIC_SEARCH_CAPABILITIES, type SearchExecutionContext, type SearchRequest } from '../../../shared/types/web-search.js';
import type { ProxyFetchResolver } from '../../core/proxy/proxy-fetch.js';

const services: SearchService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function fixture(work?: (context: SearchExecutionContext) => Promise<void>) {
  const calls: Array<{ id: string; request: SearchRequest; context: SearchExecutionContext; auth: unknown; fetch: unknown }> = [];
  const providers = new Map(['parallel', 'exa'].map((id) => [id, registerSearchProvider({
    id, label: id, authentication: [{ kind: 'anonymous' }, { kind: 'api_key', signupUrl: 'https://example.org' }],
    defaults: { authentication: 'anonymous', options: {} }, readOptionsSchema: z.object({}), writeOptionsSchema: z.strictObject({}),
    getCapabilities: (_options, authentication) => searchProviders.get(id)!.bind({}).getCapabilities(authentication),
    createBackend: (_options, dependencies) => ({ async search(request, context) {
      calls.push({ id, request, context, auth: dependencies.auth, fetch: dependencies.fetch });
      await work?.(context);
      return { evidence: { kind: 'text', text: id } };
    } }),
  })]));
  const routedFetch = vi.fn();
  const resolver = vi.fn<ProxyFetchResolver>(() => routedFetch as typeof globalThis.fetch);
  const service = new SearchService(new SearchAuth('/tmp/sample-search-config'), providers, resolver);
  services.push(service);
  return { calls, service, routedFetch, resolver };
}

describe('provider-independent search service', () => {
  it('projects capabilities from the current provider, authentication and enabled state', () => {
    const { service } = fixture();
    const base = defaultWebSearchConfig();
    expect(service.capabilities).toEqual(BASIC_SEARCH_CAPABILITIES);
    service.publish(base);
    expect(service.capabilities).toEqual(BASIC_SEARCH_CAPABILITIES);
    for (const authentication of ['api_key', 'oauth'] as const) {
      service.publish({ ...base, providers: { ...base.providers, parallel: { ...base.providers.parallel!, authentication } } });
      expect(service.capabilities).toEqual({ domains: true, publishedAfter: true, publishedBefore: false });
    }
    service.publish({ ...base, defaultProvider: 'exa' });
    expect(service.capabilities).toEqual({ domains: true, publishedAfter: true, publishedBefore: true });
    service.publish({ ...base, defaultProvider: 'exa', enabled: false });
    expect(service.capabilities).toEqual(BASIC_SEARCH_CAPABILITIES);
    service.publish({ ...base, defaultProvider: null });
    expect(service.capabilities).toEqual(BASIC_SEARCH_CAPABILITIES);
  });

  it('forwards supported filters intact and rejects a stale filtered call after switching providers', async () => {
    const { service, calls } = fixture();
    const base = defaultWebSearchConfig();
    const request: SearchRequest = { query: 'sample',
      domains: { mode: 'include', values: ['example.org'] }, publishedAfter: '2026-01-01', publishedBefore: '2026-02-01' };
    const context = { signal: new AbortController().signal, sessionId: 'conversation:example' };
    service.publish({ ...base, defaultProvider: 'exa' });
    await service.search(request, context);
    expect(calls[0]?.request).toBe(request);
    service.publish(base);
    const failure = service.search(request, context);
    await expect(failure).rejects.toMatchObject({ failure: { code: 'unsupported_filter' } });
    await expect(failure).rejects.toThrow('domains、publishedAfter、publishedBefore');
    expect(calls).toHaveLength(1);
    await service.search({ query: request.query }, context);
    expect(calls[1]?.request).toEqual({ query: request.query });
  });

  it('checks only supported filters for authenticated Parallel', async () => {
    const { service, calls } = fixture();
    const base = defaultWebSearchConfig();
    service.publish({ ...base, providers: { ...base.providers, parallel: {
      ...base.providers.parallel!, authentication: 'api_key', apiKey: 'fake-key',
    } } });
    const request: SearchRequest = { query: 'sample', domains: { mode: 'exclude', values: ['example.net'] }, publishedAfter: '2026-01-01' };
    const context = { signal: new AbortController().signal, sessionId: 'example' };
    await service.search(request, context);
    expect(calls[0]?.request).toBe(request);
    await expect(service.search({ ...request, publishedBefore: '2026-02-01' }, context))
      .rejects.toMatchObject({ failure: { code: 'unsupported_filter', message: expect.stringContaining('publishedBefore') } });
    expect(calls).toHaveLength(1);
  });

  it('uses the published selection on every call, including calls in the same conversation', async () => {
    const { service, calls } = fixture();
    const signal = new AbortController().signal;
    const context = { signal, sessionId: 'conversation:example' };
    service.publish(defaultWebSearchConfig());
    expect((await service.search({ query: 'sample' }, context)).diagnostics.providerId).toBe('parallel');
    service.publish({ ...defaultWebSearchConfig(), revision: 1, defaultProvider: 'exa' });
    expect((await service.search({ query: 'sample' }, context)).diagnostics.providerId).toBe('exa');
    expect(calls.map((call) => call.id)).toEqual(['parallel', 'exa']);
    expect(calls.every((call) => call.context.sessionId === context.sessionId && !call.context.signal.aborted)).toBe(true);
  });

  it('resolves the saved key and proxy once for the request', async () => {
    const { service, calls, resolver, routedFetch } = fixture();
    const base = defaultWebSearchConfig();
    service.publish({ ...base, providers: { ...base.providers, parallel: {
      ...base.providers.parallel!, authentication: 'api_key', apiKey: 'fake-key', proxyId: 'sample-proxy',
    } } });
    const result = await service.search({ query: 'sample' }, { signal: new AbortController().signal, sessionId: 'example' });
    expect(resolver).toHaveBeenCalledWith('sample-proxy', expect.any(Function));
    expect(calls[0]).toMatchObject({ auth: { kind: 'api_key', key: 'fake-key' }, fetch: routedFetch });
    expect(JSON.stringify(result)).not.toContain('fake-key');
  });

  it('reports disabled, absent selection and missing key through the same failure contract', async () => {
    const { service } = fixture();
    const run = () => service.search({ query: 'sample' }, { signal: new AbortController().signal, sessionId: 'example' });
    const base = defaultWebSearchConfig();
    service.publish({ ...base, enabled: false });
    await expect(run()).rejects.toMatchObject({ failure: { code: 'disabled' } });
    service.publish({ ...base, defaultProvider: null });
    await expect(run()).rejects.toMatchObject({ failure: { code: 'not_configured' } });
    service.publish({ ...base, providers: { parallel: { ...base.providers.parallel!, authentication: 'api_key' } } });
    await expect(run()).rejects.toMatchObject({ failure: { code: 'auth_required' } });
  });

  it('allows a slow search to complete after the former thirty-second limit', async () => {
    vi.useFakeTimers();
    const { service } = fixture(() => new Promise((resolve) => setTimeout(resolve, 45_000)));
    service.publish(defaultWebSearchConfig());
    const call = service.search({ query: 'sample' }, { signal: new AbortController().signal, sessionId: 'example' });
    await vi.advanceTimersByTimeAsync(45_000);
    await expect(call).resolves.toMatchObject({ document: { evidence: { text: 'parallel' } } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shares one sixty-second deadline across authentication and provider execution', async () => {
    vi.useFakeTimers();
    const { service, calls } = fixture(() => new Promise(() => {}));
    vi.spyOn(service.auth, 'resolve').mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve({ kind: 'anonymous' }), 25_000);
    }));
    service.publish(defaultWebSearchConfig());
    const caller = new AbortController();
    const call = service.search({ query: 'sample' }, { signal: caller.signal, sessionId: 'example' });
    const rejected = expect(call).rejects.toMatchObject({ failure: { code: 'timeout' } });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.context.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(calls[0]!.context.signal.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a pending search immediately with the original caller reason', async () => {
    vi.useFakeTimers();
    const { service, calls } = fixture(() => new Promise(() => {}));
    service.publish(defaultWebSearchConfig());
    const caller = new AbortController();
    const reason = new Error('Sample user interruption');
    const call = service.search({ query: 'sample' }, { signal: caller.signal, sessionId: 'example' });
    const rejected = expect(call).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(1_000);
    caller.abort(reason);
    await rejected;
    expect(calls[0]!.context.signal.reason).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reuses its direct transport, respects proxy overrides, and releases its own dispatcher', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    const { service, resolver } = fixture();
    service.publish(defaultWebSearchConfig());
    const signal = new AbortController().signal;
    await service.search({ query: 'sample' }, { signal, sessionId: 'example' });
    const fallback = resolver.mock.calls[0]![1];
    await fallback('https://example.org/one', { signal });
    await fallback('https://example.org/two', { signal });
    const first = fetch.mock.calls[0]![1] as RequestInit & { dispatcher: Agent };
    const second = fetch.mock.calls[1]![1] as RequestInit & { dispatcher: Agent };
    expect(first.dispatcher).toBeInstanceOf(Agent);
    expect(second.dispatcher).toBe(first.dispatcher);
    expect(first.signal).toBe(signal);
    const proxy = new Agent();
    try {
      await fallback('https://example.org/three', { dispatcher: proxy, signal } as RequestInit);
      expect(fetch.mock.calls[2]![1]).toMatchObject({ dispatcher: proxy, signal });
      await service.close();
      services.splice(services.indexOf(service), 1);
      expect(first.dispatcher.closed).toBe(true);
      expect(proxy.closed).toBe(false);
    } finally {
      await proxy.close();
    }
  });
});
