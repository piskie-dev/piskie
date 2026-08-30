import type { AgentService } from '../../services/agent.service.js';
import type { RuntimeComponent } from '../component-manifest.js';
import type { InferenceComponentState } from './inference.component.js';

export function createAgentComponent(options: {
  agentService: AgentService;
  inference: InferenceComponentState;
}): RuntimeComponent<AgentService> {
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= options.agentService.destroyApplication();
    return closePromise;
  };

  return {
    id: 'agent',
    requirement: 'required',
    dependsOn: ['inference', 'pilot', 'mcp', 'browser-environment'],
    async start(_context, scope) {
      scope.register({
        kind: 'custom',
        label: 'agent-application',
        close,
        inspect: () => {
          const snapshot = options.agentService.lifecycleSnapshot();
          return !snapshot.initialized && snapshot.activeRuntimeIds.length === 0
            ? 'closed'
            : 'live';
        },
        describe: () => options.agentService.lifecycleSnapshot(),
      });
      if (!options.inference.bindings) throw new Error('Inference component is not ready');
      await options.agentService.initializeApplication(options.inference.bindings);
      return options.agentService;
    },
    stop: close,
    async verifyStopped() {
      const snapshot = options.agentService.lifecycleSnapshot();
      return {
        state: !snapshot.initialized
          && !snapshot.inferenceBound
          && snapshot.activeRuntimeIds.length === 0
          ? 'stopped'
          : 'live',
        details: snapshot,
      };
    },
  };
}
