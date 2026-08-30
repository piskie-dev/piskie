import type { AgentModeId } from '../types/index.js';

export const MODE_OPERATIONS = Object.freeze({
  listAvailable: 'modes.listAvailable',
} as const);

export interface AgentModeDescriptor {
  id: AgentModeId;
  label: string;
  runtimeSwitchable: boolean;
}

export interface AgentModeQuery {
  agentSpec?: string;
}

export interface ModesClient {
  listAvailable(query?: AgentModeQuery): Promise<AgentModeDescriptor[]>;
}
