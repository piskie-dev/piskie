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

  it('publishes the saved snapshot before a delayed refresh and ignores an older query', async () => {
    const existing = definition('existing');
    const sibling = definition('sibling');
    const saved = { ...existing, promptTemplate: 'Saved task prompt' };
    const canonical = { ...saved, description: 'Canonical task description' };
    let resolveOlder!: (value: TaskDefinitionSnapshot[]) => void;
    let resolveNewer!: (value: TaskDefinitionSnapshot[]) => void;
    const list = vi.fn()
      .mockResolvedValueOnce([existing, sibling])
      .mockReturnValueOnce(new Promise<TaskDefinitionSnapshot[]>((resolve) => { resolveOlder = resolve; }))
      .mockReturnValueOnce(new Promise<TaskDefinitionSnapshot[]>((resolve) => { resolveNewer = resolve; }));
    const repository = createTaskDefinitionRepository(client({ list, update: vi.fn(async () => saved) }));
    await repository.refresh();
    const older = repository.refresh();

    await expect(repository.update(existing.definitionId, { promptTemplate: saved.promptTemplate })).resolves.toEqual(saved);
    expect(repository.state.getState()).toMatchObject({ phase: 'refreshing', definitions: [saved, sibling] });
    resolveOlder([existing, sibling]);
    await older;
    expect(repository.state.getState().definitions).toEqual([saved, sibling]);
    resolveNewer([canonical, sibling]);
    await settle();
    expect(repository.state.getState()).toMatchObject({ phase: 'ready', definitions: [canonical, sibling] });
  });

  it('retains the closed state when a pending update completes', async () => {
    let resolveUpdate!: (value: TaskDefinitionSnapshot) => void;
    const list = vi.fn(async () => [definition('existing')]);
    const repository = createTaskDefinitionRepository(client({
      list,
      update: vi.fn(() => new Promise<TaskDefinitionSnapshot>((resolve) => { resolveUpdate = resolve; })),
    }));
    await repository.refresh();
    const update = repository.update('existing', { promptTemplate: 'Saved task prompt' });
    repository.close();
    resolveUpdate({ ...definition('existing'), promptTemplate: 'Saved task prompt' });
    await update;
    expect(repository.state.getState()).toMatchObject({ phase: 'idle', definitions: [] });
    expect(list).toHaveBeenCalledOnce();
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
