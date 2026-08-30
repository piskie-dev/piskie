import {
  closeConfiguredProxyTransports,
  configuredProxyTransportLifecycleSnapshot,
  destroyConfiguredProxyTransports,
} from '../../core/proxy/proxy-resolver.js';
import type { RuntimeComponent } from '../component-manifest.js';

export function createProxyTransportsComponent(): RuntimeComponent<void> {
  let stopped = false;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= closeConfiguredProxyTransports().then(() => {
      stopped = true;
    });
    return closePromise;
  };

  return {
    id: 'proxy-transports',
    requirement: 'required',
    dependsOn: ['storage'],
    async start(_context, scope) {
      scope.register({
        kind: 'custom',
        label: 'node-proxy-transports',
        close,
        inspect: () => hasLiveTransports() ? 'live' : 'closed',
        describe: configuredProxyTransportLifecycleSnapshot,
      });
    },
    stop: close,
    async forceClose() {
      await destroyConfiguredProxyTransports();
      stopped = true;
      closePromise = Promise.resolve();
    },
    async verifyStopped() {
      const details = configuredProxyTransportLifecycleSnapshot();
      return {
        state: stopped && !hasLiveTransports(details) ? 'stopped' : 'live',
        details,
      };
    },
  };
}

function hasLiveTransports(
  snapshot = configuredProxyTransportLifecycleSnapshot(),
): boolean {
  return snapshot.agents > 0
    || snapshot.dispatchers > 0
    || snapshot.retiringDispatchers > 0;
}
