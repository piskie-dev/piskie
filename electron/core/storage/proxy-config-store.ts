import type { ProxyPoolSnapshot } from '../../../shared/types/proxy.js';

let controlledConfig: ProxyPoolSnapshot = { proxies: [] };

export function getProxyPoolSnapshot(): ProxyPoolSnapshot {
  return {
    ...controlledConfig,
    proxies: controlledConfig.proxies.map((proxy) => ({ ...proxy })),
  };
}

/** ConfigHost publication bridge for synchronous transport readers. */
export function publishProxyPoolSnapshot(config: ProxyPoolSnapshot): void {
  controlledConfig = {
    ...config,
    proxies: config.proxies.map((proxy) => ({ ...proxy })),
  };
}
