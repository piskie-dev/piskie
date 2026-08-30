import type {
  AgentControlState,
  AgentRunHeader,
} from '../../../shared/types/agent-control.js';
import type { AgentStateChangeEvent } from '../../../shared/types/index.js';
import type {
  AgentControlChangedEvent,
  AgentControlSnapshot,
  AgentRunSnapshot,
} from '../../../shared/electron-contracts/agent-runs.js';

export function agentControlSnapshot(state: AgentControlState): AgentControlSnapshot {
  return structuredClone(state);
}

export function agentControlSnapshots(
  states: Readonly<Record<string, AgentControlState>>,
): Record<string, AgentControlSnapshot> {
  return Object.fromEntries(Object.entries(states).map(([agentId, state]) => (
    [agentId, agentControlSnapshot(state)]
  )));
}

export function agentControlChangedEvent(
  event: AgentStateChangeEvent,
): AgentControlChangedEvent {
  return {
    agentId: event.agentId,
    state: event.state ? agentControlSnapshot(event.state) : null,
  };
}

export function agentRunSnapshot(header: AgentRunHeader): AgentRunSnapshot {
  return structuredClone(header);
}
