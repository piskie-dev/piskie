import { z } from 'zod';
import {
  proxyPoolStoredDocumentSchema,
  proxyProfileConfigSchema,
} from '../../../shared/schemas/proxy.js';
import type { ProxyPoolSnapshot } from '../../../shared/types/proxy.js';
import type {
  ConfigDomainIntegrations,
  ConfigDomainReader,
} from './integrations.js';
import { createManagedDomain } from './domain-factory.js';

const proxyRecordMetadata = {
  'x-piskie': { keyPlaceholder: 'proxyId', changeImpact: 'May affect inference Provider connectivity.' },
};

export const proxiesWriteSchema = z.strictObject({
  proxies: z.record(z.string().trim().min(1), proxyProfileConfigSchema)
    .describe('Global inference/API proxies keyed by immutable proxy ID.')
    .meta(proxyRecordMetadata),
});

export const proxiesReadSchema = z.strictObject({
  revision: z.number().int().nonnegative().describe('Monotonic proxies revision.'),
  proxies: z.record(z.string().trim().min(1), proxyProfileConfigSchema)
    .describe('Global inference/API proxies keyed by immutable proxy ID.')
    .meta(proxyRecordMetadata),
});

type ProxyWrite = z.infer<typeof proxyProfileConfigSchema>;
type ProxiesWrite = z.infer<typeof proxiesWriteSchema>;
type ProxiesRead = z.infer<typeof proxiesReadSchema>;
interface ProxiesDocument {
  revision: number;
  proxies: Record<string, ProxyWrite>;
}

export function createProxiesDomain(
  rootDirectory: string,
  integration: ConfigDomainIntegrations['proxies'],
  readDomain: ConfigDomainReader,
) {
  return createManagedDomain<ProxiesDocument, ProxiesRead, ProxiesWrite>(rootDirectory, {
    contract: {
      id: 'proxies',
      title: 'Global proxies',
      description: 'Single global proxy pool referenced by browsers, inference, MCP, and other consumers.',
      schemaVersion: 2,
      readSchema: proxiesReadSchema,
      writeSchema: proxiesWriteSchema,
      capabilities: ['show', 'plan', 'validate', 'apply', 'verify', 'history', 'rollback'],
    },
    codec: {
      parse: (raw) => proxiesStoredSchema.parse(raw),
    },
    bootstrap: () => ({ revision: 0, proxies: {} }),
    adapter: {
      projectRead: (stored) => structuredClone(stored),
      normalizeCandidate: (current, patched) => ({
        ...patched,
        revision: current.revision,
        proxies: sortRecord(patched.proxies),
      }),
      dependencyRevisions: async () => ({
        inference: revisionOf(await readDomain('inference')),
        'browser-profiles': revisionOf(await readDomain('browser-profiles')),
        mcp: revisionOf(await readDomain('mcp')),
      }),
      validateSemantic: async (candidate) => validateProxyReferences(
        candidate,
        await readDomain('inference'),
        await readDomain('browser-profiles'),
        await readDomain('mcp'),
      ),
      analyzeImpact: (current, candidate) => {
        const removed = Object.keys(current.proxies).filter((id) => !candidate.proxies[id]);
        return removed.map((id) => ({
          code: 'PROXY_REMOVED',
          severity: 'high' as const,
          path: `/proxies/${escapePointer(id)}`,
          message: `Global proxy ${id} will be removed.`,
        }));
      },
      publish: (candidate, context) => integration.publish(toPoolSnapshot(candidate), context),
    },
  });
}

export const proxiesStoredSchema = proxyPoolStoredDocumentSchema;

function toPoolSnapshot(document: ProxiesDocument): ProxyPoolSnapshot {
  return {
    proxies: Object.entries(document.proxies).map(([id, proxy]) => ({ id, ...proxy })),
  };
}

function validateProxyReferences(
  candidate: ProxiesDocument,
  inference: unknown,
  browserEnvironments: unknown,
  mcp: unknown,
) {
  const referenced = new Set([
    ...referencedInferenceProxyIds(inference),
    ...referencedBrowserProxyIds(browserEnvironments),
    ...referencedMcpProxyIds(mcp),
  ]);
  const missing = [...referenced].filter((id) => !candidate.proxies[id]);
  return {
    valid: missing.length === 0,
    issues: missing.map((id) => ({
      stage: 'reference' as const,
      code: 'PROXY_STILL_REFERENCED',
      path: `/proxies/${escapePointer(id)}`,
      message: `Proxy ${id} is still referenced by a configured consumer.`,
    })),
  };
}

function referencedInferenceProxyIds(value: unknown): Set<string> {
  const result = new Set<string>();
  if (!isRecord(value) || !isRecord(value.providers)) return result;
  for (const provider of Object.values(value.providers)) {
    if (!isRecord(provider) || !isRecord(provider.connection)) continue;
    if (typeof provider.connection.proxyId === 'string') result.add(provider.connection.proxyId);
  }
  return result;
}

function referencedBrowserProxyIds(value: unknown): Set<string> {
  const result = new Set<string>();
  if (!isRecord(value) || !isRecord(value.environments)) return result;
  for (const environment of Object.values(value.environments)) {
    if (isRecord(environment) && typeof environment.proxyId === 'string') {
      result.add(environment.proxyId);
    }
  }
  return result;
}

function referencedMcpProxyIds(value: unknown): Set<string> {
  const result = new Set<string>();
  if (!isRecord(value) || !isRecord(value.mcpServers)) return result;
  for (const server of Object.values(value.mcpServers)) {
    if (isRecord(server) && typeof server.proxyId === 'string') result.add(server.proxyId);
  }
  return result;
}

function revisionOf(value: unknown): number {
  return isRecord(value) && Number.isInteger(value.revision) ? value.revision as number : 0;
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function escapePointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
