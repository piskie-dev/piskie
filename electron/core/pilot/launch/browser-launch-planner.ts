import { createUuid } from '@shared/utils/identifiers.js';

import type { BrowserLaunchSpec } from '../../../piskiepilot/browser/core/browser/browser-launch-spec.js';
import { getProxyPoolSnapshot } from '../../storage/proxy-config-store.js';
import { toBrowserLaunchProxy } from '../../proxy/browser-launch-proxy.js';
import {
  browserIdentityNeedsIp,
  resolveBrowserIdentity,
} from './browser-identity-resolver.js';
import { IpLocationResolver } from './ip-location-resolver.js';
import type {
  BrowserEnvironmentLaunchRequest,
  BrowserLaunchPlanOptions,
  BrowserTaskLaunchRequest,
  EffectiveNetworkRoute,
} from './browser-launch-types.js';

export class BrowserLaunchPlanner {
  constructor(private readonly dependencies: {
    readProxies: typeof getProxyPoolSnapshot;
    location: IpLocationResolver;
    generation: () => string;
  } = {
    readProxies: getProxyPoolSnapshot,
    location: new IpLocationResolver(),
    generation: createUuid,
  }) {}

  async planEnvironment(
    request: BrowserEnvironmentLaunchRequest,
    options: BrowserLaunchPlanOptions = {},
  ): Promise<BrowserLaunchSpec> {
    const route = this.resolveRoute(request.proxyId);
    const location = browserIdentityNeedsIp(request.identityPolicy)
      ? await this.dependencies.location.resolve(route, options)
      : undefined;
    const resolved = resolveBrowserIdentity(request.identityPolicy, location);
    return this.materialize(request, route, resolved.identity, resolved.fingerprint);
  }

  async planTask(request: BrowserTaskLaunchRequest): Promise<BrowserLaunchSpec> {
    const route = this.resolveRoute(request.proxyId);
    return this.materialize(request, route, request.identity, request.fingerprint ?? {});
  }

  private resolveRoute(proxyId?: string): EffectiveNetworkRoute {
    if (!proxyId) return { kind: 'direct' };
    const profile = this.dependencies.readProxies().proxies.find((proxy) => proxy.id === proxyId);
    if (!profile || !profile.enabled) {
      throw new Error(`Browser proxy is missing or disabled: ${proxyId}`);
    }
    return { kind: 'proxy', profile };
  }

  private materialize(
    request: BrowserEnvironmentLaunchRequest | BrowserTaskLaunchRequest,
    route: EffectiveNetworkRoute,
    identity: BrowserLaunchSpec['identity'],
    fingerprint: BrowserLaunchSpec['fingerprint'],
  ): BrowserLaunchSpec {
    return deepFreeze(structuredClone({
      generation: this.dependencies.generation(),
      browserId: request.browserId,
      userDataId: request.userDataId,
      ...(route.kind === 'proxy' ? { proxy: toBrowserLaunchProxy(route.profile) } : {}),
      identity,
      fingerprint,
      backgroundMode: request.backgroundMode,
    }));
  }
}

export const browserLaunchPlanner = new BrowserLaunchPlanner();

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
