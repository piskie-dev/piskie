import { createStore, type StoreApi } from 'zustand/vanilla';
import { isTextOnlyAssistantMessage, mergeMessageState, type AgentRunMessageState } from '@shared/agent-run-messages';
import { hasSettledResponse, pendingActionIds, type AgentRunAttention } from './agent-run-attention';
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
  readonly attentionByAgentId: Readonly<Record<string, AgentRunAttention>>;
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
  syncControl(states: Readonly<Record<string, AgentControlSnapshot>>): void;
  markRead(agentId: string, throughIndex: number): Promise<void>;
  rename(agentId: string, name: string): Promise<void>;
  applyModel(agentId: string, currentModel: string): Promise<void>;
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
  attentionByAgentId: Object.freeze({}),
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
  let modelRevision = 0;
  const confirmedModels = new Map<string, { readonly model: string; readonly revision: number }>();
  let accepting = true;
  let controlStates: Readonly<Record<string, AgentControlSnapshot>> = {};
  // Append observations may arrive before the first list contains their run.
  const messagesByAgentId = new Map<string, AgentRunMessageState>();
  const readableAssistantIndexes = new Map<string, number>();
  const responses = new Map<string, { index: number; requestId: string }>();
  const settledRequests = new Map<string, string>();
  const seenActions = new Map<string, Set<string>>();
  const readRequests = new Map<string, Promise<void>>();

  const rememberMessages = (agentId: string, incoming: AgentRunMessageState): AgentRunMessageState => {
    const current = messagesByAgentId.get(agentId)
      ?? listState.getState().runs.find((run) => run.agentId === agentId)?.messages;
    const messages = mergeMessageState(current, incoming);
    messagesByAgentId.set(agentId, messages);
    return messages;
  };

  const projectAttention = (): AgentRunListSnapshot['attentionByAgentId'] => {
    const previous = listState.getState().attentionByAgentId;
    const next: Record<string, AgentRunAttention> = {};
    const agentIds = new Set([...messagesByAgentId.keys(), ...Object.keys(controlStates)]);
    for (const agentId of agentIds) {
      const messages = messagesByAgentId.get(agentId);
      const control = controlStates[agentId];
      const response = responses.get(agentId);
      let readableIndex = readableAssistantIndexes.get(agentId) ?? -1;
      if (messages && messages.latestAssistantIndex > readableIndex) {
        const observedResponse = response?.index === messages.latestAssistantIndex;
        const readable = observedResponse
          ? settledRequests.get(agentId) === response.requestId
          : !control?.aiRequestState || hasSettledResponse(control);
        if (readable) {
          readableIndex = messages.latestAssistantIndex;
          readableAssistantIndexes.set(agentId, readableIndex);
        }
      }
      const unreadActionIds = control
        ? pendingActionIds(control).filter((id) => !seenActions.get(agentId)?.has(id)) : [];
      const unread = unreadActionIds.length > 0
        || (!!messages && readableIndex > messages.readThroughIndex);
      const old = previous[agentId];
      next[agentId] = old?.unread === unread
        && old.unreadActionIds.length === unreadActionIds.length
        && old.unreadActionIds.every((id, index) => id === unreadActionIds[index])
        ? old : { unread, unreadActionIds };
    }
    return next;
  };

  const withConfirmedModel = <T extends { agentId: string; currentModel: string }>(snapshot: T, readRevision: number): T => {
    const confirmed = confirmedModels.get(snapshot.agentId);
    return confirmed && confirmed.revision > readRevision
      ? { ...snapshot, currentModel: confirmed.model } : snapshot;
  };

  const refresh = async (): Promise<void> => {
    if (!accepting) return;
    const request = ++listRequest;
    const titleRevision = renameRevision;
    const readModelRevision = modelRevision;
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
      const mergedRuns = runs.map((run) => {
        const renamed = renamedTitles.get(run.agentId);
        return {
          ...withConfirmedModel(run, readModelRevision),
          ...(renamed && renamed.revision > titleRevision
            ? { runConfig: { ...run.runConfig, name: renamed.name } }
            : {}),
          messages: rememberMessages(run.agentId, run.messages),
        };
      });
      listState.setState({
        phase: 'ready',
        runs: mergedRuns,
        attentionByAgentId: projectAttention(),
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
        attentionByAgentId: listState.getState().attentionByAgentId,
      }, true);
    }
  };

  const applyMessages = (agentId: string, messages: AgentRunMessageState): void => {
    if (!accepting) return;
    const current = listState.getState();
    const merged = rememberMessages(agentId, messages);
    listState.setState({
      runs: current.runs.map((run) => run.agentId === agentId
        ? { ...run, messages: merged } : run),
      attentionByAgentId: projectAttention(),
    });
    if (!current.runs.some((run) => run.agentId === agentId)) void refresh();
  };

  const clearPreview = (agentId?: string): void => {
    const current = previewState.getState();
    if (agentId && current.agentId !== agentId) return;
    previewRequest += 1;
    previewState.setState(INITIAL_PREVIEW, true);
  };

  const loadPreview = async (agentId: string, keepReady = false): Promise<AgentControlSnapshot | null> => {
    if (!accepting) return null;
    const request = ++previewRequest;
    if (!keepReady) previewState.setState({ phase: 'loading', agentId, state: null, error: null }, true);
    try {
      const snapshot = await client.state(agentId);
      if (!accepting || request !== previewRequest) return snapshot;
      if (!snapshot) throw new Error('Agent run state is unavailable');
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
      if (!accepting || request !== previewRequest) return null;
      if (!keepReady || previewState.getState().phase !== 'ready') {
        previewState.setState({
          phase: 'failed',
          agentId,
          state: null,
          error: error instanceof Error ? error.message : String(error),
        }, true);
      }
      if (keepReady) throw error;
      return null;
    }
  };

  return {
    listState,
    previewState,
    refresh,
    applyConversation(event) {
      if (!accepting || !event.messages) return;
      if (event.requestId && isTextOnlyAssistantMessage(event.entry)) {
        responses.set(event.agentId, { index: event.index, requestId: event.requestId });
      }
      applyMessages(event.agentId, event.messages);
    },
    syncControl(states) {
      if (!accepting) return;
      // Seed existing positions before evaluating new live control observations.
      for (const run of listState.getState().runs) {
        if (!messagesByAgentId.has(run.agentId)) rememberMessages(run.agentId, run.messages);
      }
      controlStates = states;
      for (const [agentId, seen] of seenActions) {
        const state = states[agentId];
        const pending = new Set(state ? pendingActionIds(state) : []);
        for (const id of seen) if (!pending.has(id)) seen.delete(id);
      }
      for (const state of Object.values(states)) {
        if (hasSettledResponse(state)) settledRequests.set(state.agentId, state.aiRequestState!.requestId);
      }
      listState.setState({ attentionByAgentId: projectAttention() });
    },
    async markRead(agentId, throughIndex) {
      if (!accepting) return;
      const control = controlStates[agentId];
      if (control) {
        const seen = seenActions.get(agentId) ?? new Set<string>();
        for (const id of pendingActionIds(control)) seen.add(id);
        seenActions.set(agentId, seen);
        listState.setState({ attentionByAgentId: projectAttention() });
      }
      const messages = messagesByAgentId.get(agentId);
      if (throughIndex < 0 || (messages && throughIndex <= messages.readThroughIndex)) return;
      const key = JSON.stringify([agentId, throughIndex]);
      const pending = readRequests.get(key);
      if (pending) return pending;
      const request = client.markRead(agentId, throughIndex)
        .then((result) => applyMessages(agentId, result))
        .finally(() => { readRequests.delete(key); });
      readRequests.set(key, request);
      return request;
    },
    loadPreview,
    clearPreview,
    async applyModel(agentId, currentModel) {
      if (!accepting) return;
      confirmedModels.set(agentId, { model: currentModel, revision: ++modelRevision });
      const current = listState.getState();
      listState.setState({
        runs: current.runs.map((run) => run.agentId === agentId ? { ...run, currentModel } : run),
        revision: current.revision + 1,
      });
      const preview = previewState.getState();
      if (preview.agentId === agentId) {
        // Keep model and reasoning from one authoritative read; supersede any older preview.
        await loadPreview(agentId, true);
      }
    },
    async rename(agentId, name) {
      if (!accepting) throw new Error('AgentRunRepository is closed');
      const request = ++mutationRequest;
      const readModelRevision = modelRevision;
      renameRequests.set(agentId, request);
      const renamed = await client.rename(agentId, name);
      if (!accepting || renameRequests.get(agentId) !== request) return;

      renameRequests.delete(agentId);
      renamedTitles.set(agentId, { name: renamed.runConfig.name, revision: ++renameRevision });
      const current = listState.getState();
      const canonical = {
        ...withConfirmedModel(renamed, readModelRevision),
        messages: rememberMessages(agentId, renamed.messages),
      };
      listState.setState({
        ...current,
        phase: current.phase === 'refreshing' ? 'ready' : current.phase,
        runs: current.runs.map((run) => run.agentId === agentId ? canonical : run),
        attentionByAgentId: projectAttention(),
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
      confirmedModels.delete(agentId);
      messagesByAgentId.delete(agentId);
      readableAssistantIndexes.delete(agentId);
      responses.delete(agentId);
      settledRequests.delete(agentId);
      seenActions.delete(agentId);
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
      confirmedModels.clear();
      messagesByAgentId.clear();
      readableAssistantIndexes.clear();
      responses.clear();
      settledRequests.clear();
      seenActions.clear();
      readRequests.clear();
      controlStates = {};
      listState.setState(INITIAL_LIST, true);
      previewState.setState(INITIAL_PREVIEW, true);
    },
  };
}
