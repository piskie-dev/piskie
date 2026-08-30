import type { AgentClient } from './agents.js';
import type { AgentRunClient } from './agent-runs.js';
import type { CapabilityMarketClient } from './market.js';
import type { ConfigurationClient } from './configuration.js';
import type { DesktopClient } from './desktop.js';
import type { InferenceClient } from './inference.js';
import type { MessagingClient } from './messaging.js';
import type { ModesClient } from './modes.js';
import type { ObservabilityClient } from './observability.js';
import type { PilotClient } from './pilot.js';
import type { RuntimeClient } from './runtime.js';
import type { TaskDefinitionClient } from './task-definitions.js';

export interface PiskieDesktopApi {
  readonly runtime: RuntimeClient;
  readonly agents: AgentClient;
  readonly modes: ModesClient;
  readonly taskDefinitions: TaskDefinitionClient;
  readonly agentRuns: AgentRunClient;
  readonly configuration: ConfigurationClient;
  readonly inference: InferenceClient;
  readonly capabilities: CapabilityMarketClient;
  readonly pilot: PilotClient;
  readonly messaging: MessagingClient;
  readonly observability: ObservabilityClient;
  readonly desktop: DesktopClient;
}
