import { beforeEach, describe, expect, it } from 'vitest';

import type { TaskDefinition } from '../../../../shared/types/index.js';
import { taskDefinitionStore } from '../task-definition-store.js';

function makeDefinition(
  definitionId: string,
  overrides: Partial<TaskDefinition> = {},
): TaskDefinition {
  return {
    definitionId,
    name: `Task ${definitionId}`,
    description: 'Test task',
    purpose: 'general',
    promptTemplate: 'Do something',
    defaultModeId: 'normal',
    defaultApprovalMode: 'confirm',
    createdAt: '2026-08-14T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  taskDefinitionStore.publish([]);
});

describe('TaskDefinitionStore', () => {
  it('is empty before ConfigHost publishes a snapshot', () => {
    expect(taskDefinitionStore.list()).toEqual([]);
    expect(taskDefinitionStore.get('nonexistent')).toBeNull();
  });

  it('reads the complete snapshot published by ConfigHost', () => {
    const definition = makeDefinition('td-1', { category: 'Custom', workspace: '/ws' });
    taskDefinitionStore.publish([definition]);

    expect(taskDefinitionStore.get('td-1')).toEqual(definition);
    expect(taskDefinitionStore.list()).toEqual([definition]);
  });

  it('isolates both published and returned values', () => {
    const definition = makeDefinition('td-1');
    taskDefinitionStore.publish([definition]);
    definition.name = 'external mutation';
    const read = taskDefinitionStore.list();
    read[0]!.name = 'consumer mutation';

    expect(taskDefinitionStore.get('td-1')?.name).toBe('Task td-1');
  });
});
