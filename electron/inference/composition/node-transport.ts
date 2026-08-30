import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { proxyPoolStoredDocumentSchema } from '../../../shared/schemas/proxy.js';
import type { ProxyProfile } from '../../../shared/types/proxy.js';
import { parsePersistedConfig } from '../../config/core/persisted-config-parser.js';
import { NodeProxyTransportRegistry } from '../../core/proxy/node-proxy-transport-registry.js';
import type { ComfySocketFactory } from '../drivers/comfyui-workflow/socket-session.js';

export interface NodeInferenceTransports {
  resolveFetch(proxyId: string | null, fallback: typeof globalThis.fetch): typeof globalThis.fetch;
  resolveSocketFactory(proxyId: string | null, fallback: ComfySocketFactory): ComfySocketFactory;
  close(): Promise<void>;
}

export class InferenceTransportConfigError extends Error {
  constructor(
    readonly code: 'INFERENCE_PROXY_CONFIG_INVALID' | 'INFERENCE_PROXY_NOT_FOUND',
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'InferenceTransportConfigError';
  }
}

export function createNodeInferenceTransports(rootDirectory: string): NodeInferenceTransports {
  let profiles: ReadonlyMap<string, ProxyProfile> | undefined;
  const transports = new NodeProxyTransportRegistry();
  const profile = (proxyId: string): ProxyProfile => {
    profiles ??= readProxyProfiles(rootDirectory);
    const found = profiles.get(proxyId);
    if (!found || !found.enabled) {
      throw new InferenceTransportConfigError(
        'INFERENCE_PROXY_NOT_FOUND',
        `Inference proxy is missing or disabled: ${proxyId}`,
        { proxyId },
      );
    }
    return found;
  };

  return {
    resolveFetch(proxyId, fallback) {
      if (!proxyId) return fallback;
      const dispatcher = transports.getDispatcher(profile(proxyId));
      return (input, init) => fallback(input, { ...init, dispatcher } as RequestInit);
    },
    resolveSocketFactory(proxyId, fallback) {
      if (!proxyId) return fallback;
      const agent = transports.getAgent(profile(proxyId));
      return (url, headers) => new WebSocket(url, { headers: { ...headers }, agent });
    },
    close: () => transports.close(),
  };
}

function readProxyProfiles(rootDirectory: string): ReadonlyMap<string, ProxyProfile> {
  const filePath = path.join(rootDirectory, 'config', 'proxies.json');
  let document: ReturnType<typeof proxyPoolStoredDocumentSchema.parse>;
  try {
    document = parsePersistedConfig(
      JSON.parse(fs.readFileSync(filePath, 'utf8')),
      (candidate) => proxyPoolStoredDocumentSchema.parse(candidate),
    );
  } catch (cause) {
    throw new InferenceTransportConfigError(
      'INFERENCE_PROXY_CONFIG_INVALID',
      `Unable to read inference proxy configuration: ${filePath}`,
      { filePath },
      { cause },
    );
  }
  return new Map(
    Object.entries(document.proxies)
      .map(([id, configured]) => [id, { id, ...configured }]),
  );
}
