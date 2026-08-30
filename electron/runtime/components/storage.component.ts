import type { AgentIncidentStore } from '../../observability/incidents/agent-incident-store.js';
import type { RuntimeComponent } from '../component-manifest.js';

export function createStorageComponent(options: {
  agentIncidentStore: AgentIncidentStore;
}): RuntimeComponent<void> {
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    options.agentIncidentStore.destroy();
    closed = true;
  };

  return {
    id: 'storage',
    requirement: 'required',
    dependsOn: [],
    async start() {},
    stop: close,
    async verifyStopped() {
      return {
        state: closed ? 'stopped' : 'live',
      };
    },
  };
}
