import type { AgentModeDescriptor } from '../../../shared/electron-contracts/index.js';
import type { AgentSpec } from '../specs/spec.js';

export interface AgentModeDefinition {
  descriptor: AgentModeDescriptor;
  systemChatAgentSpec: string;
  isAvailableFor(spec: AgentSpec): boolean;
}
