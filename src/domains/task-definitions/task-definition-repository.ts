import { createStore, type StoreApi } from 'zustand/vanilla';

import type {
  TaskDefinitionClient,
  TaskDefinitionCreateInput,
  TaskDefinitionSnapshot,
  TaskDefinitionUpdateInput,
} from '@shared/electron-contracts/task-definitions';

export type TaskDefinitionQueryPhase = 'idle' | 'loading' | 'ready' | 'refreshing' | 'failed';

export interface TaskDefinitionRepositorySnapshot {
  readonly phase: TaskDefinitionQueryPhase;
  readonly definitions: readonly TaskDefinitionSnapshot[];
  readonly error: string | null;
  readonly revision: number;
}

export interface TaskDefinitionRepository {
  readonly state: StoreApi<TaskDefinitionRepositorySnapshot>;
  refresh(): Promise<void>;
  create(input: TaskDefinitionCreateInput): Promise<TaskDefinitionSnapshot>;
  update(
    definitionId: string,
    updates: TaskDefinitionUpdateInput,
  ): Promise<TaskDefinitionSnapshot>;
  delete(definitionId: string): Promise<{
    affectedBots: Array<{ botId: string; name: string }>;
  }>;
  close(): void;
}

const EMPTY_DEFINITIONS: readonly TaskDefinitionSnapshot[] = Object.freeze([]);
const INITIAL_STATE: TaskDefinitionRepositorySnapshot = Object.freeze({
  phase: 'idle',
  definitions: EMPTY_DEFINITIONS,
  error: null,
  revision: 0,
});

export function createTaskDefinitionRepository(
  client: TaskDefinitionClient,
): TaskDefinitionRepository {
  const state = createStore<TaskDefinitionRepositorySnapshot>(() => INITIAL_STATE);
  let requestSequence = 0;
  let accepting = true;

  const refresh = async (): Promise<void> => {
    if (!accepting) return;
    const request = ++requestSequence;
    const current = state.getState();
    state.setState({
      ...current,
      phase: current.phase === 'idle' ? 'loading' : 'refreshing',
      error: null,
    }, true);
    try {
      const definitions = await client.list();
      if (!accepting || request !== requestSequence) return;
      state.setState({
        phase: 'ready',
        definitions,
        error: null,
        revision: current.revision + 1,
      }, true);
    } catch (error) {
      if (!accepting || request !== requestSequence) return;
      state.setState({
        phase: 'failed',
        definitions: current.definitions,
        error: error instanceof Error ? error.message : String(error),
        revision: current.revision,
      }, true);
    }
  };

  const invalidate = (): void => {
    void refresh();
  };

  const ensureAccepting = (): void => {
    if (!accepting) throw new Error('TaskDefinitionRepository is closed');
  };

  return {
    state,
    refresh,
    async create(input) {
      ensureAccepting();
      const definition = await client.create(input);
      invalidate();
      return definition;
    },
    async update(definitionId, updates) {
      ensureAccepting();
      const definition = await client.update(definitionId, updates);
      invalidate();
      return definition;
    },
    async delete(definitionId) {
      ensureAccepting();
      const result = await client.delete(definitionId);
      invalidate();
      return result;
    },
    close() {
      if (!accepting) return;
      accepting = false;
      requestSequence += 1;
      state.setState(INITIAL_STATE, true);
    },
  };
}
