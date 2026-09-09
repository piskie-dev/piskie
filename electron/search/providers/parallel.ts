import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BASIC_SEARCH_CAPABILITIES, type SearchRequest } from '../../../shared/types/web-search.js';
import type { SearchBackendDependencies, SearchProviderDefinition } from '../contracts.js';
import { searchError } from '../errors.js';
import { callSearchMcp, checkSearchMcp } from '../mcp-client.js';
import { filterSearchSources, searchDomains } from '../request.js';

const optionsSchema = z.object({});
const resultSchema = z.object({
  results: z.array(z.object({
    url: z.url({ protocol: /^https?$/ }),
    title: z.string().nullable().optional(),
    excerpts: z.array(z.string()),
    publish_date: z.string().nullable().optional(),
  })),
});

function endpoint({ auth }: SearchBackendDependencies, request?: SearchRequest) {
  const headers: Record<string, string> = {};
  if (auth.kind === 'api_key') headers.Authorization = `Bearer ${auth.key}`;
  if (auth.kind === 'oauth') headers.Authorization = `Bearer ${auth.accessToken}`;
  if (auth.kind !== 'anonymous') {
    const sourcePolicy = {
      ...(request?.domains ? {
        [request.domains.mode === 'include' ? 'include_domains' : 'exclude_domains']: searchDomains(request),
      } : {}),
      ...(request?.publishedAfter ? { after_date: request.publishedAfter } : {}),
    };
    headers['x-parallel-search-config'] = JSON.stringify({
      mode: 'fast',
      ...(Object.keys(sourcePolicy).length ? { advanced_settings: { source_policy: sourcePolicy } } : {}),
    });
  }
  return {
    url: auth.kind === 'oauth' ? 'https://search.parallel.ai/mcp-oauth' : 'https://search.parallel.ai/mcp',
    headers, tool: 'web_search',
  };
}

export const parallelProvider: SearchProviderDefinition<z.infer<typeof optionsSchema>> = {
  id: 'parallel', label: 'Parallel',
  authentication: [
    { kind: 'anonymous' },
    { kind: 'api_key', signupUrl: 'https://platform.parallel.ai/' },
    { kind: 'oauth', resourceUrl: 'https://search.parallel.ai/mcp-oauth', scopes: ['key:read'] },
  ],
  defaults: { authentication: 'anonymous', options: {} },
  readOptionsSchema: optionsSchema, writeOptionsSchema: optionsSchema.strict(),
  getCapabilities: (_options, authentication) => authentication === 'anonymous'
    ? BASIC_SEARCH_CAPABILITIES
    : { domains: true, publishedAfter: true, publishedBefore: false },
  createBackend: (_options, dependencies) => ({
    async search(request, context) {
      const result = await callSearchMcp(endpoint(dependencies, request), dependencies, {
        objective: request.query,
        search_queries: [request.query],
        session_id: createHash('sha256').update(`piskie:parallel:web-search:${context.sessionId}`).digest('hex'),
      }, context.signal);
      const parsed = resultSchema.safeParse(result.structuredContent);
      if (!parsed.success) throw searchError('invalid_response');
      return { evidence: {
        kind: 'sources',
        sources: filterSearchSources(parsed.data.results.map((source) => ({
          url: source.url, excerpts: source.excerpts,
          ...(source.title ? { title: source.title } : {}),
          ...(source.publish_date ? { publishedDate: source.publish_date } : {}),
        })), request),
      } };
    },
  }),
  checkConnection: (_options, dependencies, signal) => checkSearchMcp(endpoint(dependencies), dependencies, signal),
};
