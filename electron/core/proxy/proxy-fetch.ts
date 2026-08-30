import fs from 'node:fs';
import path from 'node:path';
import type { Dispatcher } from 'undici';
import { proxyPoolStoredDocumentSchema } from '../../../shared/schemas/proxy.js';
import type { ProxyProfile } from '../../../shared/types/proxy.js';
import { parsePersistedConfig } from '../../config/core/persisted-config-parser.js';
import { getProxyPoolSnapshot } from '../storage/proxy-config-store.js';
import { NodeProxyTransportRegistry } from './node-proxy-transport-registry.js';
import { requireConfiguredProxyDispatcher } from './proxy-resolver.js';

export interface ProxyFetchResolver {
  (
    proxyId: string | undefined,
    fallback: typeof globalThis.fetch,
  ): typeof globalThis.fetch;
  close?(): Promise<void>;
}

export function resolvePublishedProxyFetch(
  proxyId: string | undefined,
  fallback: typeof globalThis.fetch,
): typeof globalThis.fetch {
  if (!proxyId) return fallback;
  requireEnabledProfile(getProxyPoolSnapshot().proxies, proxyId);
  return fetchThrough(requireConfiguredProxyDispatcher(proxyId), fallback);
}

export function createFileProxyFetchResolver(rootDirectory: string): ProxyFetchResolver {
  const transports = new NodeProxyTransportRegistry();
  const resolve: ProxyFetchResolver = (proxyId, fallback) => {
    if (!proxyId) return fallback;
    const filePath = path.join(rootDirectory, 'config', 'proxies.json');
    let document: ReturnType<typeof proxyPoolStoredDocumentSchema.parse>;
    try {
      document = parsePersistedConfig(
        JSON.parse(fs.readFileSync(filePath, 'utf8')),
        (candidate) => proxyPoolStoredDocumentSchema.parse(candidate),
      );
    } catch (cause) {
      throw new Error(`Unable to read global proxy configuration: ${filePath}`, { cause });
    }
    const profiles = Object.entries(document.proxies).map(([id, profile]) => ({ id, ...profile }));
    transports.reconcile(profiles);
    return fetchThrough(transports.getDispatcher(requireEnabledProfile(profiles, proxyId)), fallback);
  };
  resolve.close = () => transports.close();
  return resolve;
}

function requireEnabledProfile(profiles: readonly ProxyProfile[], proxyId: string): ProxyProfile {
  const profile = profiles.find((candidate) => candidate.id === proxyId);
  if (!profile || !profile.enabled) {
    throw new Error(`MCP proxy is missing or disabled: ${proxyId}`);
  }
  return profile;
}

function fetchThrough(
  dispatcher: Dispatcher,
  fallback: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return (input, init) => fallback(input, { ...init, dispatcher } as RequestInit);
}
