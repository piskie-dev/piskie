import path from 'node:path';
import { createMarketChanges, type MarketChanges } from '../market/change-source.js';
import { mcpConnectionManager } from '../mcp/runtime/index.js';
import { agentService, type AgentServiceRuntimeBindings } from '../services/agent.service.js';
import { agentIncidentStore } from '../observability/incidents/agent-incident-store.js';
import { browserEnvironmentRuntime } from '../services/browser-environment-runtime.js';
import { screenStreamService } from '../services/screen-stream.service.js';
import { imGateway } from '../im-gateway/index.js';
import { pilotRuntimeHost } from '../core/pilot/pilot-manager.js';
import { appLog } from '../observability/logging/app-log.js';
import { FileLogStore } from '../observability/logging/file-log-store.js';
import type { RuntimeComponent } from './component-manifest.js';
import { BackendRuntime } from './lifecycle/backend-runtime.js';
import { createAgentComponent } from './components/agent.component.js';
import {
  createHostAssetsComponent,
  type HostAssetsState,
} from './components/host-assets.component.js';
import {
  createInferenceComponent,
  type InferenceComponentState,
} from './components/inference.component.js';
import { createMarketWatchersComponent } from './components/market-watchers.component.js';
import { createMcpComponent } from './components/mcp.component.js';
import { createMessagingComponent } from './components/messaging.component.js';
import { createPilotComponent } from './components/pilot.component.js';
import { createBrowserEnvironmentComponent } from './components/browser-environment.component.js';
import { createScreenStreamsComponent } from './components/screen-streams.component.js';
import { createStorageComponent } from './components/storage.component.js';
import { createProxyTransportsComponent } from './components/proxy-transports.component.js';

export interface BackendCapabilitySet {
  readonly userDataDirectory: string;
  readonly agent: typeof agentService;
  readonly systemLogs: FileLogStore;
  readonly browserEnvironments: typeof browserEnvironmentRuntime;
  readonly screenStreams: typeof screenStreamService;
  readonly incidents: typeof agentIncidentStore;
  readonly messaging: typeof imGateway;
  readonly inference: AgentServiceRuntimeBindings;
  readonly pilot: typeof pilotRuntimeHost;
  readonly mcp: typeof mcpConnectionManager;
  readonly marketChanges: MarketChanges;
  readonly hostAssets: Readonly<HostAssetsState>;
}

export interface BackendComposition {
  readonly runtime: BackendRuntime<BackendCapabilitySet>;
  readonly marketChanges: MarketChanges;
  readonly inferenceState: InferenceComponentState;
  readonly hostAssetsState: HostAssetsState;
  readonly components: readonly RuntimeComponent[];
}

export function createBackendComposition(options: {
  userDataDirectory: string;
  generation?: string;
  stopTimeoutMs?: number;
}): BackendComposition {
  const systemLogs = new FileLogStore(path.join(options.userDataDirectory, 'logs', 'app'));
  const marketChanges = createMarketChanges((error, change) => {
    appLog.error({
      event: 'market.change.notify.failed',
      message: 'Market change notification failed',
      context: { scope: 'market.change', kind: change.kind, changeType: change.type },
      error,
    });
  });
  const inferenceState: InferenceComponentState = {};
  const hostAssetsState: HostAssetsState = {};

  const components: readonly RuntimeComponent[] = Object.freeze([
    createStorageComponent({
      agentIncidentStore,
    }),
    createProxyTransportsComponent(),
    createInferenceComponent({
      userDataDirectory: options.userDataDirectory,
      agentService,
      state: inferenceState,
    }),
    createPilotComponent(),
    createMcpComponent(),
    createHostAssetsComponent({
      userDataDirectory: options.userDataDirectory,
      state: hostAssetsState,
    }),
    createBrowserEnvironmentComponent(browserEnvironmentRuntime),
    createAgentComponent({ agentService, inference: inferenceState }),
    createScreenStreamsComponent(screenStreamService),
    createMarketWatchersComponent({
      userDataDirectory: options.userDataDirectory,
      inference: inferenceState,
      changes: marketChanges.sink,
    }),
    createMessagingComponent({ gateway: imGateway, agentService, inference: inferenceState }),
  ]);

  const runtime = new BackendRuntime<BackendCapabilitySet>({
    components,
    generation: options.generation,
    stopTimeoutMs: options.stopTimeoutMs,
    createCapabilities(ready) {
      const inference = ready.get('inference') as AgentServiceRuntimeBindings | undefined;
      if (!inference) throw new Error('Inference capability is missing after backend startup');
      return Object.freeze({
        userDataDirectory: options.userDataDirectory,
        agent: agentService,
        systemLogs,
        browserEnvironments: browserEnvironmentRuntime,
        screenStreams: screenStreamService,
        incidents: agentIncidentStore,
        messaging: imGateway,
        inference,
        pilot: pilotRuntimeHost,
        mcp: mcpConnectionManager,
        marketChanges,
        hostAssets: Object.freeze({ ...hostAssetsState }),
      });
    },
  });

  return Object.freeze({
    runtime,
    marketChanges,
    inferenceState,
    hostAssetsState,
    components,
  });
}
