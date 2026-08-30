import { describe, expect, it, vi } from 'vitest';

import type { TaskDefinition } from '../../../../shared/types/index.js';
import { TaskDefinitionApplication } from '../task-definition-application.js';

const definition: TaskDefinition = {
  definitionId: 'td-AAAAAA',
  name: 'Reusable task',
  description: 'Reusable task',
  purpose: 'messaging',
  promptTemplate: 'run',
  defaultModeId: 'normal',
  defaultApprovalMode: 'confirm',
  createdAt: '2026-08-14T00:00:00.000Z',
};

function harness(found = true) {
  let current = {
    revision: 1,
    definitions: found
      ? { [definition.definitionId]: withoutId(definition) }
      : {},
  };
  let pendingPatch: Array<{ op: string; path: string }> = [];
  const config = {
    show: vi.fn(async () => structuredClone(current)),
    createPatchPlan: vi.fn(async (_domain: string, patch: typeof pendingPatch) => {
      pendingPatch = patch;
      return { id: 'plan-1' };
    }),
    validate: vi.fn(async () => ({ id: 'plan-1' })),
    apply: vi.fn(async () => {
      const removedId = pendingPatch[0]!.path.slice('/definitions/'.length);
      const definitions = structuredClone(current.definitions) as Record<string, unknown>;
      delete definitions[removedId];
      current = { revision: current.revision + 1, definitions } as typeof current;
      return { revision: current.revision };
    }),
  };
  const messaging = {
    getBotConfigs: vi.fn(() => [{
      id: 'bot-1',
      name: 'Bound Bot',
      definitionId: definition.definitionId,
    }, {
      id: 'bot-2',
      name: 'Other Bot',
      definitionId: 'td-other',
    }]),
  };
  const application = new TaskDefinitionApplication({
    config,
    definitions: {
      get: () => found ? structuredClone(definition) : null,
      list: () => found ? [structuredClone(definition)] : [],
    },
    messaging,
  } as never);
  return { application, config };
}

describe('TaskDefinitionApplication deletion', () => {
  it('deletes only the reusable definition and reports affected IM Bots', async () => {
    const { application, config } = harness();

    await expect(application.delete(definition.definitionId)).resolves.toEqual({
      affectedBots: [{ botId: 'bot-1', name: 'Bound Bot' }],
    });
    expect(config.createPatchPlan).toHaveBeenCalledWith('task-definitions', [{
      op: 'remove',
      path: `/definitions/${definition.definitionId}`,
    }]);
  });

  it('rejects an unknown definition before writing configuration', async () => {
    const { application, config } = harness(false);

    await expect(application.delete(definition.definitionId)).rejects.toMatchObject({
      code: 'not-found',
    });
    expect(config.createPatchPlan).not.toHaveBeenCalled();
  });
});

function withoutId(value: TaskDefinition): Omit<TaskDefinition, 'definitionId'> {
  const { definitionId: _definitionId, ...stored } = value;
  return stored;
}
