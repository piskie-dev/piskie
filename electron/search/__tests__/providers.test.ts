import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { exaProvider } from '../providers/exa.js';
import { parallelProvider } from '../providers/parallel.js';
import type { ResolvedSearchAuth } from '../contracts.js';

function server(result: Record<string, unknown>, format: 'json' | 'sse' = 'json', status = 200) {
  const requests: Array<{ url: string; headers: Headers; body: { method: string; id?: number; params?: Record<string, unknown> } }> = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = new Request(input, init);
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const body = await request.json() as { method: string; id?: number; params?: Record<string, unknown> };
    requests.push({ url: request.url, headers: request.headers, body });
    if (body.method === 'server/discover') return new Response(null, { status: 404 });
    if (body.id === undefined) return new Response(null, { status: 202 });
    if (body.method === 'tools/call' && status !== 200) return new Response('Request failed', { status, headers: { 'retry-after': '2' } });
    const payload = body.method === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : body.method === 'tools/list'
        ? { tools: ['web_search', 'web_search_exa'].map((name) => ({ name, inputSchema: { type: 'object' } })) }
        : result;
    const text = JSON.stringify({ jsonrpc: '2.0', id: body.id, result: payload });
    return new Response(format === 'json' ? text : `event: message\ndata: ${text}\n\n`, {
      headers: { 'content-type': format === 'json' ? 'application/json' : 'text/event-stream' },
    });
  });
  return { fetch, requests, calls: () => requests.filter((item) => item.body.method === 'tools/call') };
}

const context = () => ({ signal: new AbortController().signal, sessionId: 'conversation:sample-run' });

describe('official search MCP adapters through the shared SDK client', () => {
  it.each(['json', 'sse'] as const)('preserves structured Parallel evidence over %s', async (format) => {
    const remote = server({ content: [], structuredContent: { results: [
      { url: 'https://example.org/a', title: 'Example A', excerpts: ['First evidence', 'Second evidence'], publish_date: '2026-01-01' },
      { url: 'https://example.org/b', title: null, excerpts: [], publish_date: null },
    ] } }, format);
    const document = await parallelProvider.createBackend({}, { fetch: remote.fetch, auth: { kind: 'anonymous' } })
      .search({ query: 'example query' }, context());
    expect(document.evidence).toEqual({ kind: 'sources', sources: [
      { url: 'https://example.org/a', title: 'Example A', excerpts: ['First evidence', 'Second evidence'], publishedDate: '2026-01-01' },
      { url: 'https://example.org/b', excerpts: [] },
    ] });
    expect(remote.calls()[0]?.body.params).toEqual({ name: 'web_search', arguments: {
      objective: 'example query', search_queries: ['example query'],
      session_id: createHash('sha256').update('piskie:parallel:web-search:conversation:sample-run').digest('hex'),
    } });
    expect(remote.requests.every((request) => !request.headers.has('authorization'))).toBe(true);
  });

  it('preserves complete Exa text and sends the published input fields', async () => {
    const text = 'Title: Example\nURL: https://example.org\nBody mentions Title: and URL: as ordinary text.';
    const remote = server({ content: [{ type: 'text', text }, { type: 'text', text: 'Another source\nFull evidence' }] }, 'sse');
    const document = await exaProvider.createBackend({}, { fetch: remote.fetch, auth: { kind: 'api_key', key: 'fake-exa-key' } })
      .search({ query: 'sample query' }, context());
    expect(document.evidence).toEqual({ kind: 'text', text: `${text}\n\nAnother source\nFull evidence` });
    expect(remote.calls()[0]?.body.params).toEqual({ name: 'web_search_exa', arguments: { query: 'sample query', numResults: 5 } });
    expect(remote.calls()[0]?.headers.get('x-api-key')).toBe('fake-exa-key');
  });

  it('passes anonymous search preferences as text using each published query contract', async () => {
    const parallel = server({ content: [], structuredContent: { results: [] } });
    const exa = server({ content: [{ type: 'text', text: 'Example evidence' }] });
    const request = { query: 'sample query, prefer recent official documentation' };
    await parallelProvider.createBackend({}, { fetch: parallel.fetch, auth: { kind: 'anonymous' } }).search(request, context());
    await exaProvider.createBackend({}, { fetch: exa.fetch, auth: { kind: 'anonymous' } }).search(request, context());
    expect(parallel.calls()[0]?.body.params).toMatchObject({ name: 'web_search', arguments: {
      objective: request.query, search_queries: [request.query],
    } });
    expect(parallel.calls()[0]?.headers.has('x-parallel-search-config')).toBe(false);
    expect(exa.calls()[0]?.body.params).toEqual({ name: 'web_search_exa', arguments: {
      query: request.query, numResults: 5,
    } });
  });

  it.each(['include', 'exclude'] as const)('maps authenticated Parallel %s domains and dates through its official header', async (mode) => {
    const remote = server({ content: [], structuredContent: { results: [
      { url: 'https://docs.example.org/a', excerpts: ['Included evidence'], publish_date: '2026-01-01' },
      { url: 'https://example.net/b', excerpts: ['Other evidence'], publish_date: '2026-01-02' },
      { url: 'https://example.org/old', excerpts: [], publish_date: '2025-12-31' },
      { url: 'https://example.net/undated', excerpts: [] },
    ] } });
    const document = await parallelProvider.createBackend({}, { fetch: remote.fetch, auth: { kind: 'api_key', key: 'fake-key' } })
      .search({ query: 'sample', domains: { mode, values: ['EXAMPLE.ORG'] }, publishedAfter: '2026-01-01' }, context());
    expect(JSON.parse(remote.calls()[0]!.headers.get('x-parallel-search-config')!)).toEqual({ mode: 'fast', advanced_settings: {
      source_policy: { [mode === 'include' ? 'include_domains' : 'exclude_domains']: ['example.org'], after_date: '2026-01-01' },
    } });
    expect(document.evidence).toEqual({ kind: 'sources', sources: mode === 'include'
      ? [{ url: 'https://docs.example.org/a', excerpts: ['Included evidence'], publishedDate: '2026-01-01' }]
      : [{ url: 'https://example.net/b', excerpts: ['Other evidence'], publishedDate: '2026-01-02' }] });
  });

  it.each([
    [{ kind: 'anonymous' }, 'include'], [{ kind: 'api_key', key: 'fake-exa-key' }, 'exclude'],
  ] as const)('uses Exa advanced search for %j with %s domains and date bounds', async (auth, mode) => {
    const remote = server({ content: [{ type: 'text', text: JSON.stringify({ requestId: 'sample-request', results: [
      { url: 'https://docs.example.org/a', title: 'Example', highlights: ['Relevant passage'], text: 'Longer source', publishedDate: '2026-01-01' },
      { url: 'https://example.net/b', title: null, text: 'Full evidence', publishedDate: '2026-01-31T23:59:59Z' },
      { url: 'https://example.org/old', text: 'Old evidence', publishedDate: '2025-12-31' },
      { url: 'https://example.net/later', text: 'Later evidence', publishedDate: '2026-02-01' },
      { url: 'https://example.org/undated', text: 'Undated evidence' },
    ] }) }] }, 'sse');
    const document = await exaProvider.createBackend({}, { fetch: remote.fetch, auth }).search({ query: 'sample query',
      domains: { mode, values: ['EXAMPLE.ORG'] }, publishedAfter: '2026-01-01', publishedBefore: '2026-02-01',
    }, context());
    const call = remote.calls()[0]!;
    expect(new URL(call.url).searchParams.get('tools')).toBe('web_search_advanced_exa');
    expect(call.headers.get('x-api-key')).toBe(auth.kind === 'api_key' ? auth.key : null);
    expect(call.body.params).toEqual({ name: 'web_search_advanced_exa', arguments: {
      query: 'sample query', numResults: 5, type: 'auto', textMaxCharacters: 4000,
      [mode === 'include' ? 'includeDomains' : 'excludeDomains']: ['example.org'],
      startPublishedDate: '2026-01-01T00:00:00.000Z', endPublishedDate: '2026-02-01T00:00:00.000Z',
    } });
    expect(document.evidence).toEqual({ kind: 'sources', sources: mode === 'include'
      ? [{ url: 'https://docs.example.org/a', title: 'Example', excerpts: ['Relevant passage'], publishedDate: '2026-01-01' }]
      : [{ url: 'https://example.net/b', excerpts: ['Full evidence'], publishedDate: '2026-01-31T23:59:59Z' }] });
  });

  it('accepts empty Exa advanced results as a successful search', async () => {
    const remote = server({ content: [{ type: 'text', text: '{"results":[]}' }] });
    expect(await exaProvider.createBackend({}, { fetch: remote.fetch, auth: { kind: 'anonymous' } })
      .search({ query: 'sample', publishedBefore: '2026-01-01' }, context())).toEqual({ evidence: { kind: 'sources', sources: [] } });
  });

  it.each(['not JSON', '{}', '{"results":[{"url":"invalid"}]}'])('rejects invalid advanced response %s', async (text) => {
    const remote = server({ content: [{ type: 'text', text }] });
    await expect(exaProvider.createBackend({}, { fetch: remote.fetch, auth: { kind: 'anonymous' } })
      .search({ query: 'sample', domains: { mode: 'include', values: ['example.org'] } }, context()))
      .rejects.toMatchObject({ failure: { code: 'invalid_response' } });
  });

  it.each([false, undefined])('recognizes the observed Exa free limit when isError is %s', async (isError) => {
    const remote = server({ isError, content: [{ type: 'text', text: "You've hit Exa's free MCP rate limit. Please configure an API key." }] });
    await expect(exaProvider.createBackend({}, { fetch: remote.fetch, auth: { kind: 'anonymous' } }).search({ query: 'sample' }, context()))
      .rejects.toMatchObject({ failure: { code: 'rate_limited' } });
  });

  it('preserves search content discussing rate limits', async () => {
    const text = "Title: Rate limit troubleshooting\nURL: https://example.org\nArticle discusses You've hit Exa's free MCP rate limit.";
    const remote = server({ content: [{ type: 'text', text }] });
    expect(await exaProvider.createBackend({}, { fetch: remote.fetch, auth: { kind: 'anonymous' } }).search({ query: 'rate limit examples' }, context()))
      .toEqual({ evidence: { kind: 'text', text } });
  });

  it.each([
    [{ kind: 'api_key', key: 'fake-key' }, '/mcp', 'Bearer fake-key'],
    [{ kind: 'oauth', accessToken: 'fake-token' }, '/mcp-oauth', 'Bearer fake-token'],
  ] as const)('selects the official Parallel authentication endpoint for %j', async (auth, path, header) => {
    const remote = server({ content: [], structuredContent: { results: [] } });
    await parallelProvider.createBackend({}, { fetch: remote.fetch, auth: auth as ResolvedSearchAuth }).search({ query: 'sample' }, context());
    expect(new URL(remote.calls()[0]!.url).pathname).toBe(path);
    expect(remote.calls()[0]?.headers.get('authorization')).toBe(header);
    expect(JSON.parse(remote.calls()[0]!.headers.get('x-parallel-search-config')!)).toEqual({ mode: 'fast' });
  });

  it('checks availability without performing a search', async () => {
    const remote = server({ content: [] });
    await exaProvider.checkConnection!({}, { fetch: remote.fetch, auth: { kind: 'anonymous' } }, context().signal);
    expect(remote.requests.some((request) => request.body.method === 'tools/list')).toBe(true);
    expect(remote.calls()).toHaveLength(0);
  });

  it.each([[401, 'auth_required'], [402, 'quota_exhausted'], [429, 'rate_limited'], [503, 'upstream_error']])(
    'normalizes upstream HTTP %s', async (status, code) => {
      const remote = server({}, 'json', Number(status));
      await expect(exaProvider.createBackend({}, { fetch: remote.fetch, auth: { kind: 'anonymous' } }).search({ query: 'sample' }, context()))
        .rejects.toMatchObject({ failure: { code } });
    },
  );

  it('preserves a supplier retry delay', async () => {
    const remote = server({}, 'json', 429);
    await expect(exaProvider.createBackend({}, { fetch: remote.fetch, auth: { kind: 'anonymous' } }).search({ query: 'sample' }, context()))
      .rejects.toMatchObject({ failure: { code: 'rate_limited', retryAfterMs: 2000 } });
  });

  it('recognizes HTTP 200 business failures and keeps secret error text out of the result', async () => {
    const remote = server({ isError: true, content: [{ type: 'text', text: 'Rate limit for fake-secret-key exceeded' }] });
    const call = exaProvider.createBackend({}, { fetch: remote.fetch, auth: { kind: 'api_key', key: 'fake-secret-key' } })
      .search({ query: 'sample' }, context());
    await expect(call).rejects.toMatchObject({ failure: { code: 'rate_limited' } });
    await expect(call).rejects.not.toThrow('fake-secret-key');
  });

  it('rejects malformed structured results', async () => {
    const remote = server({ content: [], structuredContent: { results: [{ url: 'invalid', excerpts: [] }] } });
    await expect(parallelProvider.createBackend({}, { fetch: remote.fetch, auth: { kind: 'anonymous' } }).search({ query: 'sample' }, context()))
      .rejects.toMatchObject({ failure: { code: 'invalid_response' } });
  });
});
