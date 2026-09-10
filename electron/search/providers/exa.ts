import { z } from 'zod';
import type { SearchBackendDependencies, SearchProviderDefinition } from '../contracts.js';
import { searchError } from '../errors.js';
import { callSearchMcp, checkSearchMcp } from '../mcp-client.js';
import { filterSearchSources, hasSearchFilters, searchDomains } from '../request.js';

const optionsSchema = z.object({});
const advancedResultSchema = z.object({
  results: z.array(z.object({
    url: z.url({ protocol: /^https?$/ }),
    title: z.string().nullable().optional(),
    text: z.string().optional(),
    highlights: z.array(z.string()).optional(),
    publishedDate: z.string().nullable().optional(),
  })),
});

function endpoint({ auth }: SearchBackendDependencies, advanced = false) {
  const headers: Record<string, string> = {};
  if (auth.kind === 'api_key') headers['x-api-key'] = auth.key;
  return {
    url: advanced ? 'https://mcp.exa.ai/mcp?tools=web_search_advanced_exa' : 'https://mcp.exa.ai/mcp',
    headers, tool: advanced ? 'web_search_advanced_exa' : 'web_search_exa',
  };
}

export const exaProvider: SearchProviderDefinition<z.infer<typeof optionsSchema>> = {
  id: 'exa', label: 'Exa',
  authentication: [
    { kind: 'anonymous' },
    { kind: 'api_key', signupUrl: 'https://dashboard.exa.ai/' },
  ],
  defaults: { authentication: 'anonymous', options: {} },
  readOptionsSchema: optionsSchema, writeOptionsSchema: optionsSchema.strict(),
  getCapabilities: () => ({ domains: true, publishedAfter: true, publishedBefore: true }),
  createBackend: (_options, dependencies) => ({
    async search(request, context) {
      const advanced = hasSearchFilters(request);
      const result = await callSearchMcp(endpoint(dependencies, advanced), dependencies, {
        query: request.query, numResults: 5,
        ...(advanced ? { type: 'auto', textMaxCharacters: 4000 } : {}),
        ...(request.domains ? {
          [request.domains.mode === 'include' ? 'includeDomains' : 'excludeDomains']: searchDomains(request),
        } : {}),
        ...(request.publishedAfter ? { startPublishedDate: `${request.publishedAfter}T00:00:00.000Z` } : {}),
        ...(request.publishedBefore ? { endPublishedDate: `${request.publishedBefore}T00:00:00.000Z` } : {}),
      }, context.signal);
      const text = result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n\n');
      if (!text.trim()) throw searchError('invalid_response');
      // The hosted free endpoint also returns this failure without setting isError.
      if (text.trimStart().startsWith("You've hit Exa's free MCP rate limit.")) throw searchError('rate_limited');
      if (!advanced) return { evidence: { kind: 'text', text } };

      let data: unknown;
      try { data = JSON.parse(text); } catch { throw searchError('invalid_response'); }
      const parsed = advancedResultSchema.safeParse(data);
      if (!parsed.success) throw searchError('invalid_response');
      return { evidence: { kind: 'sources', sources: filterSearchSources(parsed.data.results.map((source) => ({
        url: source.url,
        excerpts: source.highlights?.length ? source.highlights : source.text ? [source.text] : [],
        ...(source.title ? { title: source.title } : {}),
        ...(source.publishedDate ? { publishedDate: source.publishedDate } : {}),
      })), request) } };
    },
  }),
  checkConnection: (_options, dependencies, signal) => checkSearchMcp(endpoint(dependencies), dependencies, signal),
};
