import { createStore, type StoreApi } from 'zustand/vanilla';
import type { AgentClient } from '@shared/electron-contracts/agents';
import type { ContextSnapshot } from '@shared/types/token';

export type ContextInspectorResourceSnapshot =
  | {
      readonly phase: 'closed';
      readonly agentId: null;
      readonly snapshot: null;
      readonly error: null;
      readonly generation: number;
    }
  | {
      readonly phase: 'opening';
      readonly agentId: string;
      readonly snapshot: null;
      readonly error: null;
      readonly generation: number;
    }
  | {
      readonly phase: 'ready';
      readonly agentId: string;
      readonly snapshot: ContextSnapshot;
      readonly error: null;
      readonly generation: number;
    }
  | {
      readonly phase: 'refreshing';
      readonly agentId: string;
      readonly snapshot: ContextSnapshot;
      readonly error: null;
      readonly generation: number;
    }
  | {
      readonly phase: 'failed';
      readonly agentId: string;
      readonly snapshot: ContextSnapshot | null;
      readonly error: string;
      readonly generation: number;
    };

export interface ContextInspectorResource {
  readonly state: StoreApi<ContextInspectorResourceSnapshot>;
  open(agentId: string): Promise<void>;
  refresh(): Promise<void>;
  close(agentId?: string): void;
}

const INITIAL_STATE: ContextInspectorResourceSnapshot = Object.freeze({
  phase: 'closed',
  agentId: null,
  snapshot: null,
  error: null,
  generation: 0,
});

export function createContextInspectorResource(agents: AgentClient): ContextInspectorResource {
  const state = createStore<ContextInspectorResourceSnapshot>(() => INITIAL_STATE);
  let requestSequence = 0;
  let requestController: AbortController | null = null;
  let inFlight: Promise<void> | null = null;

  const load = (agentId: string, preserveSnapshot: boolean): Promise<void> => {
    requestController?.abort();
    const controller = new AbortController();
    requestController = controller;
    const request = ++requestSequence;
    const current = state.getState();
    const retained = preserveSnapshot && current.agentId === agentId
      ? current.snapshot
      : null;
    state.setState(retained
      ? {
          phase: 'refreshing',
          agentId,
          snapshot: retained,
          error: null,
          generation: current.generation,
        }
      : {
          phase: 'opening',
          agentId,
          snapshot: null,
          error: null,
          generation: current.generation,
        }, true);

    const task = agents.context(agentId)
      .then((snapshot) => {
        if (controller.signal.aborted || request !== requestSequence) return;
        state.setState({
          phase: 'ready',
          agentId,
          snapshot,
          error: null,
          generation: state.getState().generation + 1,
        }, true);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || request !== requestSequence) return;
        state.setState({
          phase: 'failed',
          agentId,
          snapshot: retained,
          error: error instanceof Error ? error.message : String(error),
          generation: state.getState().generation,
        }, true);
      })
      .finally(() => {
        if (request === requestSequence) {
          requestController = null;
          inFlight = null;
        }
      });
    inFlight = task;
    return task;
  };

  return {
    state,
    open(agentId) {
      const current = state.getState();
      if (current.agentId === agentId) {
        if (current.phase === 'ready') return Promise.resolve();
        if (current.phase === 'opening' || current.phase === 'refreshing') {
          return inFlight ?? Promise.resolve();
        }
      }
      return load(agentId, false);
    },
    refresh() {
      const current = state.getState();
      if (current.agentId === null) return Promise.resolve();
      return load(current.agentId, true);
    },
    close(agentId) {
      if (agentId && state.getState().agentId !== agentId) return;
      requestSequence += 1;
      requestController?.abort();
      requestController = null;
      inFlight = null;
      const generation = state.getState().generation;
      state.setState({ ...INITIAL_STATE, generation }, true);
    },
  };
}
