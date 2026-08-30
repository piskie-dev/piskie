import { describe, expect, it, vi } from 'vitest';

import type {
  TaskDefinitionClient,
  TaskDefinitionCreateInput,
  TaskDefinitionSnapshot,
} from '@shared/electron-contracts/task-definitions';
import { createTaskDefinitionRepository } from '../task-definition-repository';

const INPUT: TaskDefinitionCreateInput = {
  name: 'Task',
  description: 'Task description',
  purpose: 'general',
  promptTemplate: 'Do the task',
};

function definition(definitionId: string, name = INPUT.name): TaskDefinitionSnapshot {
  return {
    definitionId,
    ...INPUT,
    name,
    defaultModeId: 'normal',
    defaultApprovalMode: 'confirm',
    createdAt: '2026-08-19T00:00:00.000Z',
  };
}

function client(overrides: Partial<TaskDefinitionClient> = {}): TaskDefinitionClient {
  return {
    list: vi.fn(async () => []),
    create: vi.fn(async () => definition('created')),
    update: vi.fn(async (definitionId) => definition(definitionId)),
    delete: vi.fn(async () => ({ affectedBots: [] })),
    ...overrides,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('TaskDefinitionRepository', () => {
  it('lets the newest query win when an older response arrives late', async () => {
    let resolveOlder!: (value: TaskDefinitionSnapshot[]) => void;
    let resolveNewer!: (value: TaskDefinitionSnapshot[]) => void;
    const list = vi.fn()
      .mockReturnValueOnce(new Promise<TaskDefinitionSnapshot[]>((resolve) => {
        resolveOlder = resolve;
      }))
      .mockReturnValueOnce(new Promise<TaskDefinitionSnapshot[]>((resolve) => {
        resolveNewer = resolve;
      }));
    const repository = createTaskDefinitionRepository(client({ list }));

    const older = repository.refresh();
    const newer = repository.refresh();
    resolveNewer([definition('canonical', 'Canonical')]);
    await newer;
    resolveOlder([definition('stale', 'Stale')]);
    await older;

    expect(repository.state.getState()).toMatchObject({
      phase: 'ready',
      definitions: [{ definitionId: 'canonical', name: 'Canonical' }],
      error: null,
    });
  });

  it('invalidates from a successful mutation without writing a local projection', async () => {
    const canonical = definition('created', 'Canonical from Main');
    const create = vi.fn(async () => definition('created', 'Mutation response'));
    const list = vi.fn(async () => [canonical]);
    const repository = createTaskDefinitionRepository(client({ create, list }));

    await expect(repository.create(INPUT)).resolves.toMatchObject({ name: 'Mutation response' });
    await settle();

    expect(list).toHaveBeenCalledOnce();
    expect(repository.state.getState().definitions).toEqual([canonical]);
  });

  it('keeps retained data and scopes a query failure to this repository', async () => {
    const existing = definition('existing');
    const list = vi.fn()
      .mockResolvedValueOnce([existing])
      .mockRejectedValueOnce(new Error('offline'));
    const repository = createTaskDefinitionRepository(client({ list }));

    await repository.refresh();
    await repository.refresh();

    expect(repository.state.getState()).toEqual({
      phase: 'failed',
      definitions: [existing],
      error: 'offline',
      revision: 1,
    });
  });
});
