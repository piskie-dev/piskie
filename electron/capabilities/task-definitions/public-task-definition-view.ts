import type { TaskDefinition } from '../../../shared/types/index.js';
import type { TaskDefinitionSnapshot } from '../../../shared/electron-contracts/task-definitions.js';

export function taskDefinitionSnapshot(
  definition: TaskDefinition,
): TaskDefinitionSnapshot {
  return structuredClone(definition);
}
