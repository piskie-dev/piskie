import { specRegistry } from '../agent/specs/index.js';
import {
  AgentModeCatalog,
  createBuiltinAgentModes,
} from '../agent/modes/index.js';
import { compactionArchive } from '../agent-runs/compaction-archive.js';
import { planRepository } from '../agent-runs/plan-repository.js';
import { screenService } from '../services/screen.service.js';
import { themeService } from '../services/theme.service.js';
import { appConfigStore, taskDefinitionStore } from '../core/storage/index.js';
import { browserControlPort } from '../core/pilot/pilot-manager.js';
import { occupancyRegistry } from '../core/occupancy/index.js';
import type { BackendCapabilitySet } from '../runtime/backend-composition.js';
import type { BackendRuntime } from '../runtime/lifecycle/backend-runtime.js';
import type {
  DesktopAppearancePort,
  DesktopPresentationPort,
} from '../desktop/desktop-presentation-port.js';
import { createControllerCatalog, type ControllerCatalog, type TopicDefinition } from './catalog.js';
import { createAgentController } from './agents/agent-controller.js';
import { ConfigurationApplication } from './configuration/configuration-application.js';
import { createConfigurationController } from './configuration/configuration-controller.js';
import { AgentRunApplication } from './agent-runs/agent-run-application.js';
import { createAgentRunController } from './agent-runs/agent-run-controller.js';
import { TaskDefinitionApplication } from './task-definitions/task-definition-application.js';
import { createTaskDefinitionController } from './task-definitions/task-definition-controller.js';
import { createInferenceController } from './inference/inference-controller.js';
import { createModeController } from './modes/mode-controller.js';
import { CapabilityMarketApplication } from './market/capability-market-application.js';
import { createCapabilityMarketController } from './market/capability-market-controller.js';
import { MessagingApplication } from './messaging/messaging-application.js';
import { createMessagingController } from './messaging/messaging-controller.js';
import { ObservabilityApplication } from './observability/observability-application.js';
import { createObservabilityController } from './observability/observability-controller.js';
import { PilotApplication } from './pilot/pilot-application.js';
import { createPilotController } from './pilot/pilot-controller.js';
import { createRuntimeController } from './runtime/runtime-controller.js';
import { DesktopApplication } from '../desktop/capabilities/desktop-application.js';
import { createDesktopController } from '../desktop/capabilities/desktop-controller.js';

export interface ApplicationComposition {
  readonly catalog: ControllerCatalog;
  releaseConnection(connectionId: string): void;
}

export function createApplicationComposition(options: {
  backend: BackendRuntime<BackendCapabilitySet>;
  capabilities: Readonly<BackendCapabilitySet>;
  presentation: DesktopPresentationPort;
  appearance: DesktopAppearancePort;
  app: {
    name: string;
    version: string;
    development: boolean;
  };
}): ApplicationComposition {
  const { capabilities } = options;
  capabilities.pilot.setCallerWindowResolver(() => options.presentation.pilotCallerWindow());
  capabilities.pilot.setBrowserLaunchWindowSizeResolver(
    () => options.presentation.pilotBrowserWindowSize(),
  );
  const configHost = capabilities.inference.inferenceHost.configHost;
  const taskDefinitionApplication = new TaskDefinitionApplication({
    config: configHost,
    definitions: taskDefinitionStore,
    messaging: capabilities.messaging,
  });
  const agentRunApplication = new AgentRunApplication({
    agent: capabilities.agent,
    plans: planRepository,
    compactions: compactionArchive,
    messaging: capabilities.messaging,
  });
  const modeCatalog = new AgentModeCatalog(createBuiltinAgentModes(), {
    specs: specRegistry,
    agent: capabilities.agent,
    resolveTaskDefinition: (definitionId) => taskDefinitionStore.get(definitionId),
  });
  const agent = createAgentController(
    capabilities.agent,
    modeCatalog,
  );
  const taskDefinitions = createTaskDefinitionController(taskDefinitionApplication);
  const agentRuns = createAgentRunController(agentRunApplication);
  const modes = createModeController(modeCatalog);
  const configuration = createConfigurationController(
    new ConfigurationApplication({
      host: configHost,
      settings: appConfigStore,
      developmentFeatures: options.app.development,
    }),
    createConfigurationTopic(configHost),
  );
  const marketApplication = new CapabilityMarketApplication({
    userDataDirectory: capabilities.userDataDirectory,
    agent: capabilities.agent,
    manager: capabilities.mcp,
    presentation: options.presentation,
    changes: capabilities.marketChanges,
  });
  const market = createCapabilityMarketController(marketApplication);
  const pilot = createPilotController(new PilotApplication({
    config: configHost,
    environments: capabilities.browserEnvironments,
    screens: screenService,
    streams: capabilities.screenStreams,
    browser: browserControlPort,
    presentation: options.presentation,
  }));
  const messaging = createMessagingController(new MessagingApplication({
    config: configHost,
    gateway: capabilities.messaging,
  }));
  const observabilityApplication = new ObservabilityApplication({
    incidents: capabilities.incidents,
    systemLogs: capabilities.systemLogs,
    occupancy: occupancyRegistry,
    presentation: options.presentation,
  });
  const observability = createObservabilityController(observabilityApplication);
  const desktop = createDesktopController(new DesktopApplication({
    name: options.app.name,
    version: options.app.version,
    userDataDirectory: capabilities.userDataDirectory,
    development: options.app.development,
    presentation: options.presentation,
    appearance: options.appearance,
    theme: themeService,
  }));
  const inference = createInferenceController(capabilities.inference.inferenceHost);
  const runtime = createRuntimeController(() => options.backend.snapshot());

  const catalog = createControllerCatalog({
    operations: [
      ...runtime,
      ...agent.operations,
      ...modes,
      ...taskDefinitions,
      ...agentRuns,
      ...configuration.operations,
      ...inference,
      ...market.operations,
      ...pilot.operations,
      ...messaging.operations,
      ...observability.operations,
      ...desktop.operations,
    ],
    topics: [
      ...agent.topics,
      ...configuration.topics,
      ...market.topics,
      ...pilot.topics,
      ...messaging.topics,
      ...observability.topics,
      ...desktop.topics,
    ],
  });

  return Object.freeze({
    catalog,
    releaseConnection: (connectionId: string) => {
      observabilityApplication.releaseConnection(connectionId);
    },
  });
}

function createConfigurationTopic(
  host: BackendCapabilitySet['inference']['inferenceHost']['configHost'],
): TopicDefinition['open'] {
  return (context, _input, emit) => {
    const dispose = host.subscribe(emit);
    const abort = (): void => dispose();
    context.signal.addEventListener('abort', abort, { once: true });
    return {
      snapshot: host.domains(),
      dispose: () => {
        context.signal.removeEventListener('abort', abort);
        dispose();
      },
    };
  };
}
