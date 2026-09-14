import { createStore, type StoreApi } from 'zustand/vanilla';
import { mergeMessageState, type AgentRunMessageState } from '@shared/agent-run-messages';
import type { ConversationAppendEvent } from '@shared/types/agent-control';

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
  applyConversation(event: ConversationAppendEvent): void;
  markRead(agentId: string, throughIndex: number): Promise<void>;
  rename(agentId: string, name: string): Promise<void>;
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

export function createAgentRunRepository(client: AgentRunClient, onDeleted?: (agentId: string) => void): AgentRunRepository {
  const listState = createStore<AgentRunListSnapshot>(() => INITIAL_LIST);
  const previewState = createStore<AgentRunPreviewSnapshot>(() => INITIAL_PREVIEW);
  let listRequest = 0;
  let previewRequest = 0;
  let mutationRequest = 0;
  let renameRevision = 0;
  const renameRequests = new Map<string, number>();
  const renamedTitles = new Map<string, { readonly name: string; readonly revision: number }>();
  let accepting = true;

  const refresh = async (): Promise<void> => {
    if (!accepting) return;
    const request = ++listRequest;
    const titleRevision = renameRevision;
    const current = listState.getState();
    listState.setState({
      ...current,
      phase: current.phase === 'idle' ? 'loading' : 'refreshing',
      error: null,
    }, true);
    try {
      const runs = await client.list();
      if (!accepting || request !== listRequest) return;
      const latest = listState.getState();
      listState.setState({
        phase: 'ready',
        runs: runs.map((run) => {
          const previous = latest.runs.find((item) => item.agentId === run.agentId);
          const renamed = renamedTitles.get(run.agentId);
          return {
            ...run,
            ...(renamed && renamed.revision > titleRevision
              ? { runConfig: { ...run.runConfig, name: renamed.name } }
              : {}),
            messages: mergeMessageState(previous?.messages, run.messages),
          };
        }),
        error: null,
        revision: latest.revision + 1,
      }, true);
    } catch (error) {
      if (!accepting || request !== listRequest) return;
      listState.setState({
        phase: 'failed',
        runs: listState.getState().runs,
        error: error instanceof Error ? error.message : String(error),
        revision: current.revision,
      }, true);
    }
  };

  const applyMessages = (agentId: string, messages: AgentRunMessageState): void => {
    if (!accepting) return;
    const current = listState.getState();
    if (!current.runs.some((run) => run.agentId === agentId)) {
      void refresh();
      return;
    }
    listState.setState({
      runs: current.runs.map((run) => run.agentId === agentId
        ? { ...run, messages: mergeMessageState(run.messages, messages) } : run),
    });
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
    applyConversation(event) {
      if (event.messages) applyMessages(event.agentId, event.messages);
    },
    async markRead(agentId, throughIndex) {
      if (!accepting) return;
      applyMessages(agentId, await client.markRead(agentId, throughIndex));
    },
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
        const run = listState.getState().runs.find((item) => item.agentId === agentId);
        const currentSnapshot = run
          ? { ...snapshot, runConfig: { ...snapshot.runConfig, name: run.runConfig.name } }
          : snapshot;
        previewState.setState({
          phase: 'ready',
          agentId,
          state: currentSnapshot,
          error: null,
        }, true);
        return currentSnapshot;
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
    async rename(agentId, name) {
      if (!accepting) throw new Error('AgentRunRepository is closed');
      const request = ++mutationRequest;
      renameRequests.set(agentId, request);
      const renamed = await client.rename(agentId, name);
      if (!accepting || renameRequests.get(agentId) !== request) return;

      renameRequests.delete(agentId);
      renamedTitles.set(agentId, { name: renamed.runConfig.name, revision: ++renameRevision });
      const current = listState.getState();
      const previous = current.runs.find((run) => run.agentId === agentId);
      const canonical = {
        ...renamed,
        messages: mergeMessageState(previous?.messages, renamed.messages),
      };
      listState.setState({
        ...current,
        phase: current.phase === 'refreshing' ? 'ready' : current.phase,
        runs: current.runs.map((run) => run.agentId === agentId ? canonical : run),
        revision: current.revision + 1,
      }, true);

      const preview = previewState.getState();
      if (preview.phase === 'ready' && preview.agentId === agentId) {
        previewState.setState({
          ...preview,
          state: {
            ...preview.state,
            runConfig: { ...preview.state.runConfig, name: renamed.runConfig.name },
          },
        }, true);
      }
    },
    async delete(agentId) {
      if (!accepting) throw new Error('AgentRunRepository is closed');
      await client.delete(agentId);
      renamedTitles.delete(agentId);
      onDeleted?.(agentId);
      clearPreview(agentId);
      await refresh();
    },
    close() {
      if (!accepting) return;
      accepting = false;
      listRequest += 1;
      previewRequest += 1;
      renameRequests.clear();
      renamedTitles.clear();
      listState.setState(INITIAL_LIST, true);
      previewState.setState(INITIAL_PREVIEW, true);
    },
  };
}
