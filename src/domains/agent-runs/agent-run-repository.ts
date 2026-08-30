import { createStore, type StoreApi } from 'zustand/vanilla';

import type {
  AgentControlSnapshot,
  AgentRunClient,
  AgentRunSnapshot,
} from '@shared/electron-contracts/agent-runs';

export type AgentRunQueryPhase = 'idle' | 'loading' | 'ready' | 'refreshing' | 'failed';

export interface AgentRunListSnapshot {
  readonly phase: AgentRunQueryPhase;
  readonly runs: readonly AgentRunSnapshot[];
  readonly error: string | null;
  readonly revision: number;
}

export type AgentRunPreviewSnapshot =
  | {
      readonly phase: 'idle';
      readonly agentId: null;
      readonly state: null;
      readonly error: null;
    }
  | {
      readonly phase: 'loading';
      readonly agentId: string;
      readonly state: null;
      readonly error: null;
    }
  | {
      readonly phase: 'ready';
      readonly agentId: string;
      readonly state: AgentControlSnapshot;
      readonly error: null;
    }
  | {
      readonly phase: 'failed';
      readonly agentId: string;
      readonly state: null;
      readonly error: string;
    };

export interface AgentRunRepository {
  readonly listState: StoreApi<AgentRunListSnapshot>;
  readonly previewState: StoreApi<AgentRunPreviewSnapshot>;
  refresh(): Promise<void>;
  loadPreview(agentId: string): Promise<AgentControlSnapshot | null>;
  clearPreview(agentId?: string): void;
  delete(agentId: string): Promise<void>;
  close(): void;
}

const EMPTY_RUNS: readonly AgentRunSnapshot[] = Object.freeze([]);
const INITIAL_LIST: AgentRunListSnapshot = Object.freeze({
  phase: 'idle',
  runs: EMPTY_RUNS,
  error: null,
  revision: 0,
});
const INITIAL_PREVIEW: AgentRunPreviewSnapshot = Object.freeze({
  phase: 'idle',
  agentId: null,
  state: null,
  error: null,
});

export function createAgentRunRepository(client: AgentRunClient): AgentRunRepository {
  const listState = createStore<AgentRunListSnapshot>(() => INITIAL_LIST);
  const previewState = createStore<AgentRunPreviewSnapshot>(() => INITIAL_PREVIEW);
  let listRequest = 0;
  let previewRequest = 0;
  let accepting = true;

  const refresh = async (): Promise<void> => {
    if (!accepting) return;
    const request = ++listRequest;
    const current = listState.getState();
    listState.setState({
      ...current,
      phase: current.phase === 'idle' ? 'loading' : 'refreshing',
      error: null,
    }, true);
    try {
      const runs = await client.list();
      if (!accepting || request !== listRequest) return;
      listState.setState({
        phase: 'ready',
        runs,
        error: null,
        revision: current.revision + 1,
      }, true);
    } catch (error) {
      if (!accepting || request !== listRequest) return;
      listState.setState({
        phase: 'failed',
        runs: current.runs,
        error: error instanceof Error ? error.message : String(error),
        revision: current.revision,
      }, true);
    }
  };

  const clearPreview = (agentId?: string): void => {
    const current = previewState.getState();
    if (agentId && current.agentId !== agentId) return;
    previewRequest += 1;
    previewState.setState(INITIAL_PREVIEW, true);
  };

  return {
    listState,
    previewState,
    refresh,
    async loadPreview(agentId) {
      if (!accepting) return null;
      const request = ++previewRequest;
      previewState.setState({ phase: 'loading', agentId, state: null, error: null }, true);
      try {
        const snapshot = await client.state(agentId);
        if (!accepting || request !== previewRequest) return snapshot;
        if (!snapshot) {
          previewState.setState({
            phase: 'failed',
            agentId,
            state: null,
            error: 'Agent run state is unavailable',
          }, true);
          return null;
        }
        previewState.setState({
          phase: 'ready',
          agentId,
          state: snapshot,
          error: null,
        }, true);
        return snapshot;
      } catch (error) {
        if (accepting && request === previewRequest) {
          previewState.setState({
            phase: 'failed',
            agentId,
            state: null,
            error: error instanceof Error ? error.message : String(error),
          }, true);
        }
        return null;
      }
    },
    clearPreview,
    async delete(agentId) {
      if (!accepting) throw new Error('AgentRunRepository is closed');
      await client.delete(agentId);
      clearPreview(agentId);
      await refresh();
    },
    close() {
      if (!accepting) return;
      accepting = false;
      listRequest += 1;
      previewRequest += 1;
      listState.setState(INITIAL_LIST, true);
      previewState.setState(INITIAL_PREVIEW, true);
    },
  };
}
