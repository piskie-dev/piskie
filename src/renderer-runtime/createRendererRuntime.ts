import type { PiskieDesktopApi } from '@shared/electron-contracts/api';
import { subscribeToConfigDomainRefreshes } from '../features/config/domain-refresh-coordinator';
import { subscribeToIncidentEvents } from '../store/incidentStore';
import { useBrowserEnvironmentStore } from '../store/browserEnvironmentStore';
import { useInferenceStore } from '../store/inferenceStore';
import { useMessagingStore } from '../store/messagingStore';
import { subscribeToOccupancyEvents } from '../store/occupancyStore';
import { useProxyStore } from '../store/proxyStore';
import { useUIStore } from '../store/uiStore';
import { createRuntime, type RendererRuntime } from './renderer-runtime';

export function createRendererRuntime(api: PiskieDesktopApi): RendererRuntime {
  return createRuntime(api, {
    startSubscriptions(register, domains) {
      const refreshInference = useInferenceStore.getState().refresh;
      const fetchSettings = useUIStore.getState().fetchSettings;
      const refreshConnections = useMessagingStore.getState().fetchConnections;
      const refreshEnvironments = useBrowserEnvironmentStore.getState().fetchEnvironments;
      const refreshGlobalProxies = useProxyStore.getState().fetchConfig;
      const unsubscribeConfig = subscribeToConfigDomainRefreshes({
        inference: refreshInference,
        'inference-selections': refreshInference,
        'model-catalog': refreshInference,
        'app-settings': fetchSettings,
        proxies: refreshGlobalProxies,
        'task-definitions': domains.taskDefinitions.refresh,
        'browser-profiles': async () => {
          await refreshEnvironments();
        },
        'im-bots': refreshConnections,
      }, (domain) => {
        void api.observability.clientLogs.record({
          event: 'config.domain.refresh.failed',
          context: { domain },
        });
      });
      register(unsubscribeConfig);
      register(subscribeToIncidentEvents());
      register(subscribeToOccupancyEvents());
      register(useMessagingStore.getState().subscribeMessagingEvents());
    },
    async bootstrap() {
      await Promise.allSettled([
        useUIStore.getState().fetchSettings(),
        useInferenceStore.getState().refresh(),
        useMessagingStore.getState().fetchSenderAuthorizationRequests(),
      ]);
    },
    stop() {},
  });
}
