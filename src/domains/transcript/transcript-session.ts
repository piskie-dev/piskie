import { createStore, type StoreApi } from 'zustand/vanilla';
import type {
  AgentLiveContentDelta,
  ConversationPage,
  ConversationPageRequest,
} from '@shared/electron-contracts/agents';
import type { ConversationAppendEvent } from '@shared/types';
import type { AIRequestState } from '@shared/types';
import {
  applyLiveDelta,
  commitLiveGeneration,
  emptyLiveGeneration,
  finishLiveGeneration,
} from './live-generation';
import { TranscriptProjector } from './projector';
import type {
  IndexedConversationEntry,
  LiveGeneration,
  TranscriptSessionSnapshot,
} from './types';

const PAGE_SIZE = 400;
const WARMUP_BUDGET = 400;

export interface ConversationPageSource {
  conversation(agentId: string, page: ConversationPageRequest): Promise<ConversationPage>;
}

export interface TranscriptSession {
  readonly agentId: string;
  readonly state: StoreApi<TranscriptSessionSnapshot>;
  start(): Promise<void>;
  append(event: ConversationAppendEvent): void;
  applyLive(event: AgentLiveContentDelta, activeRequestId: string | undefined): void;
  setRequestState(request: AIRequestState | undefined): void;
  setPendingCallId(callId: string | undefined): void;
  loadEarlier(): Promise<void>;
  close(): void;
}

export function createTranscriptSession(
  agentId: string,
  source: ConversationPageSource,
): TranscriptSession {
  const projector = new TranscriptProjector();
  const initial: TranscriptSessionSnapshot = {
    phase: 'idle',
    projection: projector.snapshot(),
    live: emptyLiveGeneration(),
    total: 0,
    hasEarlier: false,
    error: null,
  };
  const state = createStore<TranscriptSessionSnapshot>(() => initial);
  const appendBuffer = new Map<number, ConversationAppendEvent>();
  let live: LiveGeneration = initial.live;
  let request: AIRequestState | undefined;
  let started = false;
  let closed = false;
  let generation = 0;
  let hydratePromise: Promise<void> | null = null;
  let repairPromise: Promise<void> | null = null;
  let earlierPromise: Promise<void> | null = null;
  let total = 0;

  const publish = (phase?: 'idle' | 'loading' | 'ready') => {
    const currentPhase = state.getState().phase;
    const nextPhase = phase ?? (currentPhase === 'failed' ? 'ready' : currentPhase);
    state.setState({
      phase: nextPhase,
      projection: projector.snapshot(),
      live,
      total,
      hasEarlier: projector.snapshot().range.from > 0,
      error: null,
    }, true);
  };

  const fail = (error: unknown) => {
    state.setState({
      phase: 'failed',
      projection: projector.snapshot(),
      live,
      total,
      hasEarlier: projector.snapshot().range.from > 0,
      error: error instanceof Error ? error.message : String(error),
    }, true);
  };

  const settleCanonical = (event: ConversationAppendEvent) => {
    if (event.entry.t !== 'msg' || event.entry.role !== 'assistant') return;
    const next = commitLiveGeneration(live, event.requestId);
    if (next !== live) live = next;
  };

  const drain = () => {
    let expected = projector.snapshot().range.toExclusive;
    let changed = false;
    for (;;) {
      const event = appendBuffer.get(expected);
      if (!event) break;
      appendBuffer.delete(expected);
      if (projector.apply(expected, event.entry)) {
        settleCanonical(event);
        changed = true;
      }
      expected += 1;
    }
    if (changed) publish('ready');
    if (appendBuffer.size > 0) void repairGap();
  };

  const repairGap = async (): Promise<void> => {
    if (closed || state.getState().phase !== 'ready' || repairPromise) return repairPromise ?? undefined;
    const expected = projector.snapshot().range.toExclusive;
    const nextBuffered = Math.min(...appendBuffer.keys());
    if (!Number.isFinite(nextBuffered) || nextBuffered <= expected) return;

    const epoch = generation;
    let progressed = false;
    repairPromise = (async () => {
      try {
        const page = await source.conversation(agentId, {
          direction: 'forward',
          from: expected,
          limit: Math.min(500, Math.max(PAGE_SIZE, nextBuffered - expected)),
        });
        if (closed || epoch !== generation) return;
        total = Math.max(total, page.total);
        progressed = page.entries.length > 0;
        page.entries.forEach((entry, offset) => {
          const index = page.from + offset;
          if (!appendBuffer.has(index)) {
            appendBuffer.set(index, { agentId, index, entry });
          }
        });
        drain();
      } catch (error) {
        if (!closed && epoch === generation) fail(error);
      } finally {
        repairPromise = null;
        if (progressed && !closed && appendBuffer.size > 0) void repairGap();
      }
    })();
    return repairPromise;
  };

  const loadWarmup = async (
    from: number,
    visible: readonly IndexedConversationEntry[],
    epoch: number,
  ): Promise<readonly IndexedConversationEntry[]> => {
    const unresolved = unresolvedResultIds(visible);
    if (unresolved.size === 0 || from === 0) return [];

    const warmup = new Map<number, IndexedConversationEntry>();
    let before = from;
    let remaining = WARMUP_BUDGET;
    while (!closed && epoch === generation && unresolved.size > 0 && before > 0 && remaining > 0) {
      const limit = Math.min(PAGE_SIZE, remaining, before);
      const page = await source.conversation(agentId, { direction: 'backward', before, limit });
      if (closed || epoch !== generation || page.entries.length === 0) break;
      page.entries.forEach((entry, offset) => {
        const indexed = { index: page.from + offset, entry };
        warmup.set(indexed.index, indexed);
        for (const callId of toolCallIds(entry)) unresolved.delete(callId);
      });
      remaining -= page.entries.length;
      if (page.from >= before) break;
      before = page.from;
    }
    return [...warmup.values()].sort((left, right) => left.index - right.index);
  };

  const hydrate = async () => {
    const epoch = ++generation;
    state.setState({ ...state.getState(), phase: 'loading', error: null }, true);
    try {
      const page = await source.conversation(agentId, { direction: 'tail', limit: PAGE_SIZE });
      if (closed || epoch !== generation) return;
      const visible = page.entries.map((entry, offset) => ({ index: page.from + offset, entry }));
      const warmup = await loadWarmup(page.from, visible, epoch);
      if (closed || epoch !== generation) return;

      projector.reset(page.from, page.entries, warmup);
      total = Math.max(page.total, ...[...appendBuffer.keys()].map((index) => index + 1), 0);

      const coveredTo = page.from + page.entries.length;
      for (const [index, event] of appendBuffer) {
        if (index < coveredTo) {
          settleCanonical(event);
          appendBuffer.delete(index);
        }
      }
      publish('ready');
      drain();
    } catch (error) {
      if (!closed && epoch === generation) fail(error);
    }
  };

  const session: TranscriptSession = {
    agentId,
    state,
    start() {
      if (closed) return Promise.resolve();
      if (hydratePromise) return hydratePromise;
      if (started && state.getState().phase === 'ready') return Promise.resolve();
      started = true;
      hydratePromise = hydrate().finally(() => {
        hydratePromise = null;
      });
      return hydratePromise;
    },
    append(event) {
      if (closed || event.agentId !== agentId) return;
      const range = projector.snapshot().range;
      if (state.getState().phase === 'ready' && event.index < range.toExclusive) {
        settleCanonical(event);
        publish('ready');
        return;
      }
      if (!appendBuffer.has(event.index)) appendBuffer.set(event.index, event);
      total = Math.max(total, event.index + 1);
      if (state.getState().phase === 'ready') drain();
    },
    applyLive(event, activeRequestId) {
      if (closed || event.agentId !== agentId) return;
      const next = applyLiveDelta(live, event, activeRequestId);
      if (next === live) return;
      live = next;
      publish();
    },
    setRequestState(nextRequest) {
      if (closed) return;
      request = nextRequest;
      if (!request) {
        if (live.phase === 'none' || live.phase === 'closed') return;
        const next = finishLiveGeneration(live, live.requestId, 'cancelled');
        if (next !== live) {
          live = next;
          publish();
        }
        return;
      }
      if (request.phase !== 'finished') return;
      const next = finishLiveGeneration(
        live,
        request.requestId,
        request.outcome ?? 'failed',
      );
      if (next === live) return;
      live = next;
      publish();
    },
    setPendingCallId(callId) {
      if (closed || !projector.setPendingCallId(callId)) return;
      publish();
    },
    loadEarlier() {
      if (closed || earlierPromise) return earlierPromise ?? Promise.resolve();
      const before = projector.snapshot().range.from;
      if (state.getState().phase !== 'ready' || before === 0) return Promise.resolve();
      const epoch = generation;
      earlierPromise = (async () => {
        try {
          const page = await source.conversation(agentId, {
            direction: 'backward',
            before,
            limit: PAGE_SIZE,
          });
          if (closed || epoch !== generation || page.entries.length === 0) return;
          const current = projector.visibleEntries();
          const visible = [
            ...page.entries.map((entry, offset) => ({ index: page.from + offset, entry })),
            ...current,
          ];
          const warmup = await loadWarmup(page.from, visible, epoch);
          if (closed || epoch !== generation) return;
          projector.reset(
            page.from,
            visible.map((item) => item.entry),
            warmup,
          );
          total = Math.max(total, page.total);
          publish('ready');
        } catch (error) {
          if (!closed && epoch === generation) fail(error);
        } finally {
          earlierPromise = null;
        }
      })();
      return earlierPromise;
    },
    close() {
      if (closed) return;
      closed = true;
      generation += 1;
      appendBuffer.clear();
      projector.reset(0, []);
      live = emptyLiveGeneration();
      total = 0;
      state.setState(initial, true);
    },
  };
  return session;
}

function unresolvedResultIds(entries: readonly IndexedConversationEntry[]): Set<string> {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const { entry } of entries) {
    for (const callId of toolCallIds(entry)) calls.add(callId);
    if (entry.t === 'tool') results.add(entry.toolUseId);
  }
  for (const callId of calls) results.delete(callId);
  return results;
}

function toolCallIds(entry: IndexedConversationEntry['entry']): readonly string[] {
  if (entry.t !== 'msg' || entry.role !== 'assistant' || !Array.isArray(entry.content)) return [];
  return entry.content.flatMap((block) => (
    block.type === 'tool_use' && block.id ? [block.id] : []
  ));
}
