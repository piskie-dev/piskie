/**
 * 代理解析器
 * 将 proxyId 或 ProxyProfile 解析为 Node.js http.Agent 或 undici Dispatcher，并提供缓存
 */

import type { Agent } from 'http';
import type { Dispatcher } from 'undici';
import type { ProxyProfile } from '../../../shared/types/proxy.js';
import { getProxyPoolSnapshot } from '../storage/proxy-config-store.js';
import { NodeProxyTransportRegistry } from './node-proxy-transport-registry.js';

const configuredTransports = new NodeProxyTransportRegistry();

/**
 * 根据 ProxyProfile 直接创建或获取缓存的 Agent
 */
export function resolveProxyAgent(profile: ProxyProfile): Agent {
  return configuredTransports.getAgent(profile);
}

/**
 * 根据 proxyId 从代理池查找并返回 Agent
 * 如果 proxyId 为空或找不到，返回 undefined
 */
export function resolveProxyAgentById(proxyId?: string): Agent | undefined {
  if (!proxyId) return undefined;
  const config = getProxyPoolSnapshot();
  const profile = config.proxies.find(p => p.id === proxyId && p.enabled);
  if (!profile) return undefined;
  return resolveProxyAgent(profile);
}

/**
 * 根据 ProxyProfile 直接创建或获取缓存的 Dispatcher
 */
function getCachedProxyDispatcher(profile: ProxyProfile): Dispatcher {
  return configuredTransports.getDispatcher(profile);
}

/**
 * 根据 proxyId 从代理池查找并返回 Dispatcher
 * 如果 proxyId 为空或找不到，返回 undefined
 */
function findConfiguredProxyDispatcher(proxyId?: string): Dispatcher | undefined {
  if (!proxyId) return undefined;
  const config = getProxyPoolSnapshot();
  const profile = config.proxies.find(p => p.id === proxyId && p.enabled);
  if (!profile) return undefined;
  return getCachedProxyDispatcher(profile);
}

export function requireProxyAgentById(proxyId: string): Agent {
  const agent = resolveProxyAgentById(proxyId);
  if (!agent) throw new Error(`Inference proxy is missing or disabled: ${proxyId}`);
  return agent;
}

export function requireConfiguredProxyDispatcher(proxyId: string): Dispatcher {
  const dispatcher = findConfiguredProxyDispatcher(proxyId);
  if (!dispatcher) throw new Error(`Inference proxy is missing or disabled: ${proxyId}`);
  return dispatcher;
}

export function reconcileConfiguredProxyTransports(profiles: readonly ProxyProfile[]): void {
  configuredTransports.reconcile(profiles);
}

export function closeConfiguredProxyTransports(): Promise<void> {
  return configuredTransports.close();
}

export function destroyConfiguredProxyTransports(): Promise<void> {
  return configuredTransports.destroy();
}

export function configuredProxyTransportLifecycleSnapshot() {
  return configuredTransports.lifecycleSnapshot();
}
