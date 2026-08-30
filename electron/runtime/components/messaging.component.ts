import type { IMGateway } from '../../im-gateway/index.js';
import type { AgentService } from '../../services/agent.service.js';
import type { RuntimeComponent } from '../component-manifest.js';
import type { InferenceComponentState } from './inference.component.js';

export function createMessagingComponent(options: {
  gateway: IMGateway;
  agentService: AgentService;
  inference: InferenceComponentState;
}): RuntimeComponent<IMGateway> {
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= options.gateway.destroy();
    return closePromise;
  };

  return {
    id: 'messaging',
    requirement: 'required',
    dependsOn: ['agent'],
    async start(_context, scope) {
      scope.register({
        kind: 'custom',
        label: 'im-gateway',
        close,
        inspect: () => {
          const snapshot = options.gateway.lifecycleSnapshot();
          return !snapshot.initialized
            && snapshot.activeBotIds.length === 0
            && !snapshot.hasPowerSaveBlocker
            && snapshot.observationBindingCount === 0
            ? 'closed'
            : 'live';
        },
        describe: () => options.gateway.lifecycleSnapshot(),
      });
      await options.gateway.initialize();
      const config = options.inference.bindings?.inferenceHost.configHost;
      if (!config) throw new Error('ConfigHost is unavailable during Messaging startup');
      options.gateway.injectDependencies({
        agentService: options.agentService,
        observations: options.agentService.observations,
        config,
      });
      return options.gateway;
    },
    stop: close,
    async verifyStopped() {
      const snapshot = options.gateway.lifecycleSnapshot();
      return {
        state: !snapshot.initialized
          && snapshot.activeBotIds.length === 0
          && !snapshot.hasPowerSaveBlocker
          && snapshot.observationBindingCount === 0
          ? 'stopped'
          : 'live',
        details: snapshot,
      };
    },
  };
}
