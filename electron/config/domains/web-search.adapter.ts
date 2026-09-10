import { z } from 'zod';
import type { WebSearchConfig } from '../../../shared/types/web-search.js';
import { searchProviders } from '../../search/providers/index.js';
import type { ConfigDomainIntegrations, ConfigDomainReader } from './integrations.js';
import { createManagedDomain } from './domain-factory.js';

function providerShape(strict: boolean) {
  return Object.fromEntries([...searchProviders.values()].map((provider) => {
    const fields = {
      displayName: z.string().trim().min(1).default(provider.label).describe('User-visible search provider name.'),
      enabled: z.boolean().default(true).describe('Whether this search provider can be used.'),
      authentication: z.enum(provider.authentication.map((item) => item.kind))
        .default(provider.defaults.authentication).describe('Authentication method for subsequent requests.'),
      apiKey: z.string().optional().describe('Personal API key, used only with API key authentication.'),
      proxyId: z.string().trim().min(1).optional().describe('Optional global proxy ID.'),
      options: (strict ? provider.writeOptionsSchema : provider.readOptionsSchema)
        .optional().describe('Provider-specific search options.'),
    };
    return [provider.id, (strict ? z.strictObject(fields) : z.object(fields)).optional()];
  }));
}

const rootFields = {
  enabled: z.boolean().describe('Whether the built-in web search tool is enabled.'),
  defaultProvider: z.string().nullable().describe('Selected search provider ID; null means no selection.'),
};

export const webSearchWriteSchema = z.strictObject({
  ...rootFields,
  providers: z.strictObject(providerShape(true)).describe('Configured search providers keyed by registered ID.'),
});

export const webSearchReadSchema = webSearchWriteSchema.extend({
  revision: z.number().int().nonnegative().describe('Monotonic web-search revision.'),
});

const storedSchema = z.object({
  revision: z.number().int().nonnegative(),
  ...rootFields,
  providers: z.object(providerShape(false)),
});

export function parseWebSearchConfig(raw: unknown): WebSearchConfig {
  const parsed = storedSchema.parse(raw);
  const providers = Object.fromEntries(Object.entries(parsed.providers).filter((entry) => entry[1] !== undefined));
  const selected = parsed.defaultProvider;
  return {
    ...parsed, providers,
    defaultProvider: selected && providers[selected]?.enabled ? selected : null,
  } as WebSearchConfig;
}

export function defaultWebSearchConfig(): WebSearchConfig {
  return {
    revision: 0, enabled: true, defaultProvider: 'parallel',
    providers: Object.fromEntries([...searchProviders.values()].map((provider) => [provider.id, {
      displayName: provider.label, enabled: true, authentication: provider.defaults.authentication,
    }])),
  };
}

export function createWebSearchDomain(
  rootDirectory: string,
  integration: ConfigDomainIntegrations['webSearch'],
  readDomain: ConfigDomainReader,
) {
  return createManagedDomain<WebSearchConfig, WebSearchConfig, Omit<WebSearchConfig, 'revision'>>(rootDirectory, {
    contract: {
      id: 'web-search', title: 'Web search',
      description: 'Built-in web search providers, authentication, routing and current selection.',
      schemaVersion: 1, readSchema: webSearchReadSchema, writeSchema: webSearchWriteSchema,
      capabilities: ['show', 'plan', 'validate', 'apply', 'verify', 'history', 'rollback'],
    },
    codec: { parse: parseWebSearchConfig },
    bootstrap: defaultWebSearchConfig,
    adapter: {
      projectRead: (stored) => stored,
      normalizeCandidate: (current, patched) => ({ ...patched, revision: current.revision }),
      dependencyRevisions: async () => {
        const proxies = await readDomain('proxies') as { revision: number };
        return { proxies: proxies.revision };
      },
      validateSemantic: async (candidate) => {
        const issues: Array<{ stage: 'reference'; code: string; path: string; message: string }> = [];
        const selected = candidate.defaultProvider;
        if (selected && !candidate.providers[selected]?.enabled) {
          issues.push({ stage: 'reference', code: 'SEARCH_PROVIDER_UNAVAILABLE', path: '/defaultProvider',
            message: 'Select an enabled configured search provider, or clear the selection.' });
        }
        const proxies = await readDomain('proxies') as { proxies: Record<string, unknown> };
        for (const [id, provider] of Object.entries(candidate.providers)) {
          if (provider.proxyId && !proxies.proxies[provider.proxyId]) {
            issues.push({ stage: 'reference', code: 'SEARCH_PROXY_MISSING', path: `/providers/${id}/proxyId`,
              message: `Search provider ${id} references an unknown proxy.` });
          }
        }
        return { valid: issues.length === 0, issues };
      },
      publish: (candidate, context) => integration.publish(candidate, context),
    },
  });
}
