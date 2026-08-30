import type { TaskDefinition } from '../../../shared/types/index.js';

export class TaskDefinitionStore {
  private definitions: TaskDefinition[] = [];

  list(): TaskDefinition[] {
    return structuredClone(this.definitions);
  }

  get(definitionId: string): TaskDefinition | null {
    return this.list().find((definition) => definition.definitionId === definitionId) ?? null;
  }

  publish(definitions: readonly TaskDefinition[]): void {
    this.definitions = structuredClone([...definitions]);
  }
}

export const taskDefinitionStore = new TaskDefinitionStore();
