import WebSocket from 'ws';
import {
  requireProxyAgentById,
  requireConfiguredProxyDispatcher,
} from '../../core/proxy/proxy-resolver.js';
import type { ComfySocketFactory } from '../drivers/comfyui-workflow/socket-session.js';

export function resolveElectronInferenceFetch(
  proxyId: string | null,
  fallback: typeof globalThis.fetch,
): typeof globalThis.fetch {
  if (!proxyId) return fallback;
  const dispatcher = requireConfiguredProxyDispatcher(proxyId);
  return (input, init) => fallback(input, { ...init, dispatcher } as RequestInit);
}

export function resolveElectronComfySocketFactory(
  proxyId: string | null,
  fallback: ComfySocketFactory,
): ComfySocketFactory {
  if (!proxyId) return fallback;
  const agent = requireProxyAgentById(proxyId);
  return (url, headers) => new WebSocket(url, { headers: { ...headers }, agent });
}
