import { describe, expect, it } from 'vitest';

import type { TaskDefinition } from '../../../../shared/types/index.js';
import { taskDefinitionSnapshot } from '../public-task-definition-view.js';

describe('Task Definition public view', () => {
  it('returns an isolated snapshot of the stored definition', () => {
    const definition: TaskDefinition = {
      definitionId: 'td-AAAAAA',
      name: 'Private task',
      description: 'Private task',
      purpose: 'general',
      promptTemplate: 'run',
      defaultModeId: 'plan',
      defaultApprovalMode: 'confirm',
      metadata: { type: 'standard', boundEnvironmentIds: ['browser-1'] },
      advancedSettings: { backgroundMode: false },
      createdAt: '2026-08-11T00:00:00.000Z',
    };

    const snapshot = taskDefinitionSnapshot(definition);
    snapshot.name = 'changed by consumer';
    snapshot.metadata!.boundEnvironmentIds!.push('browser-2');

    expect(definition.name).toBe('Private task');
    expect(definition.metadata?.boundEnvironmentIds).toEqual(['browser-1']);
  });
});
