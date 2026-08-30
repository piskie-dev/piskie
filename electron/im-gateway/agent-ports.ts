import type { AgentObservationSource } from '../agent/observations.js';
import type { AgentControlState } from '../../shared/types/agent-control.js';
import type { AgentInputEvent } from '../../shared/types/index.js';
import type { ResolvedAgentLaunch } from '../agent/launch/resolved-agent-launch.js';

export interface IMAgentCommands {
  startAgent(launch: ResolvedAgentLaunch): Promise<AgentControlState>;
  resumeAgent(
    agentId: string,
    options?: { autoStart?: boolean },
  ): Promise<AgentControlState | null>;
  stopAgent(agentId: string): Promise<void>;
  injectEventToAgent(agentId: string, event: AgentInputEvent): Promise<boolean>;
  hasAgentInMemory(agentId: string): boolean;
}

export type IMAgentObservations = Pick<
  AgentObservationSource,
  'outputs' | 'runtimeReleases'
>;
