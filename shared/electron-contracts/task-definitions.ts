import type {
  ApprovalMode,
  StandardTaskBindings,
  TaskAdvancedSettings,
  TaskDefinition,
  TaskDefinitionModeId,
  TaskDefinitionPurpose,
} from '../types/index.js';

export const TASK_DEFINITION_OPERATIONS = Object.freeze({
  list: 'task-definitions.list',
  create: 'task-definitions.create',
  update: 'task-definitions.update',
  delete: 'task-definitions.delete',
} as const);

export type TaskDefinitionSnapshot = Omit<TaskDefinition, 'advancedSettings'> & {
  advancedSettings?: TaskAdvancedSettings;
};

export interface TaskDefinitionCreateInput {
  name: string;
  description: string;
  category?: string;
  purpose: TaskDefinitionPurpose;
  promptTemplate: string;
  systemPrompt?: string;
  defaultModeId?: TaskDefinitionModeId;
  defaultApprovalMode?: ApprovalMode;
  workspace?: string;
  metadata?: StandardTaskBindings;
  advancedSettings?: TaskAdvancedSettings;
  mcpServers?: string[];
}

export type TaskDefinitionUpdateInput = Partial<TaskDefinitionCreateInput>;

export interface TaskDefinitionClient {
  list(): Promise<TaskDefinitionSnapshot[]>;
  create(input: TaskDefinitionCreateInput): Promise<TaskDefinitionSnapshot>;
  update(
    definitionId: string,
    updates: TaskDefinitionUpdateInput,
  ): Promise<TaskDefinitionSnapshot>;
  delete(definitionId: string): Promise<{
    affectedBots: Array<{ botId: string; name: string }>;
  }>;
}
