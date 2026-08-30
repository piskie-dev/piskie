import type {
  AgentControlState,
  AgentRunHeader,
  ChildSnapshot,
} from '../types/agent-control.js';
import type {
  AgentRunConfig,
  SubagentConfig,
  TaskAdvancedSettings,
} from '../types/index.js';
import type {
  CompactionHistoryView,
  CompactionMessagePage,
} from '../types/context.js';

export const AGENT_RUN_OPERATIONS = Object.freeze({
  list: 'agent-runs.list',
  state: 'agent-runs.state',
  delete: 'agent-runs.delete',
  readPlan: 'agent-runs.plan.read',
  listCompactions: 'agent-runs.compaction.list',
  originalCompactionMessages: 'agent-runs.compaction.originalMessages',
} as const);

export type TaskAdvancedSettingsSnapshot = TaskAdvancedSettings;

export type AgentRunConfigSnapshot = Omit<AgentRunConfig, 'advancedSettings'> & {
  advancedSettings?: TaskAdvancedSettingsSnapshot;
};

export type SubagentConfigSnapshot = Omit<SubagentConfig, 'advancedSettings'> & {
  advancedSettings?: TaskAdvancedSettingsSnapshot;
};

type AgentChildSnapshot = Omit<ChildSnapshot, 'config'> & {
  config: SubagentConfigSnapshot;
};

export type AgentRunSnapshot = Omit<AgentRunHeader, 'runConfig' | 'childAgents'> & {
  runConfig: AgentRunConfigSnapshot;
  childAgents: AgentChildSnapshot[];
};

export type AgentControlSnapshot = Omit<AgentControlState, 'runConfig'> & {
  runConfig: AgentRunConfigSnapshot;
};

export interface AgentControlChangedEvent {
  agentId: string;
  state: AgentControlSnapshot | null;
}

interface AgentRunsClient {
  list(): Promise<AgentRunSnapshot[]>;
  state(agentId: string): Promise<AgentControlSnapshot | null>;
  delete(agentId: string): Promise<void>;
  readPlan(agentId: string): Promise<{
    planId: string;
    taskSummary: string;
    documentPath: string;
    createdAt: string;
    content: string;
  }>;
  listCompactions(agentId: string): Promise<CompactionHistoryView>;
  originalCompactionMessages(input: {
    agentId: string;
    summaryId: string;
    offset?: number;
    limit?: number;
  }): Promise<CompactionMessagePage>;
}

export type AgentRunClient = AgentRunsClient;
