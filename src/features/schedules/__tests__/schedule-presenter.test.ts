import { describe, expect, it } from 'vitest';

import type { TaskDefinitionSnapshot } from '@shared/electron-contracts/task-definitions';
import { orderDefinitionsByAvailability } from '../schedule-presenter';

function definition(definitionId: string): TaskDefinitionSnapshot {
  return {
    definitionId,
    name: definitionId,
    description: '',
    purpose: 'general',
    promptTemplate: 'Run a generic task.',
    defaultModeId: 'normal',
    defaultApprovalMode: 'confirm',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('orderDefinitionsByAvailability', () => {
  it('keeps available templates first without changing the order within either group', () => {
    const definitions = [
      definition('bound-first'),
      definition('available-first'),
      definition('bound-second'),
      definition('available-second'),
    ];
    const boundTemplates = new Map([
      ['bound-first', 'Bot A'],
      ['bound-second', 'Bot B'],
    ]);

    const ordered = orderDefinitionsByAvailability(definitions, boundTemplates);

    expect(ordered.map((item) => item.definitionId)).toEqual([
      'available-first',
      'available-second',
      'bound-first',
      'bound-second',
    ]);
    expect(definitions.map((item) => item.definitionId)).toEqual([
      'bound-first',
      'available-first',
      'bound-second',
      'available-second',
    ]);
  });
});
