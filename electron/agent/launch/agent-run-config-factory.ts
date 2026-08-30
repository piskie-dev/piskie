import type {
  AgentRunConfig,
  TaskDefinition,
} from '../../../shared/types/index.js';

export function snapshotTaskDefinition(definition: TaskDefinition): AgentRunConfig {
  return {
    name: definition.name,
    description: definition.description,
    ...(definition.category ? { category: definition.category } : {}),
    promptTemplate: definition.promptTemplate,
    ...(definition.systemPrompt ? { systemPrompt: definition.systemPrompt } : {}),
    ...(definition.workspace ? { workspace: definition.workspace } : {}),
    ...(definition.metadata ? { bindings: structuredClone(definition.metadata) } : {}),
    ...(definition.advancedSettings
      ? { advancedSettings: structuredClone(definition.advancedSettings) }
      : {}),
    ...(definition.mcpServers ? { mcpServers: [...definition.mcpServers] } : {}),
  };
}

export function createSystemChatRunConfig(
  input: string,
  workspace?: string,
): AgentRunConfig {
  return {
    name: titleFromInput(input),
    description: input,
    promptTemplate: input,
    ...(workspace ? { workspace } : {}),
  };
}

export function createDirectorRunConfig(
  taskDescription: string,
  defaults: Pick<AgentRunConfig, 'workspace' | 'bindings' | 'advancedSettings' | 'mcpServers'> = {},
): AgentRunConfig {
  return {
    name: titleFromInput(taskDescription),
    description: taskDescription,
    promptTemplate: taskDescription,
    ...(defaults.workspace ? { workspace: defaults.workspace } : {}),
    ...(defaults.bindings ? { bindings: structuredClone(defaults.bindings) } : {}),
    ...(defaults.advancedSettings
      ? { advancedSettings: structuredClone(defaults.advancedSettings) }
      : {}),
    ...(defaults.mcpServers ? { mcpServers: [...defaults.mcpServers] } : {}),
  };
}

function titleFromInput(input: string): string {
  const firstLine = input.trim().split(/\r?\n/, 1)[0] ?? '';
  return firstLine.slice(0, 80) || 'New Agent Run';
}
