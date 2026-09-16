import { useMemo, useSyncExternalStore } from 'react';
import type { TranscriptSession } from '@/domains/transcript/transcript-session';
import type { TranscriptStore } from '@/domains/transcript/transcript-store';
import type { TranscriptNode } from '@/domains/transcript/nodes';
import { useRendererRuntime } from '@/renderer-runtime/hooks';
import { collectFileChanges, EMPTY_FILE_CHANGES, type SessionFileChanges } from './fileChanges';

export interface FileChangesView extends SessionFileChanges {
  readonly loading: boolean;
  readonly error: string | null;
}

const EMPTY_VIEW: FileChangesView = { ...EMPTY_FILE_CHANGES, loading: true, error: null };

/** Reads retained conversations without widening any chat window or requiring a worker tab. */
export function createFileChangesResource(transcript: TranscriptStore, agentId: string, includeWorkers: boolean) {
  const sessions = new Map<string, TranscriptSession>();
  const disposers = new Map<string, () => void>();
  const listeners = new Set<() => void>();
  const conversations = new Map<string, readonly TranscriptNode[]>();
  let snapshot = EMPTY_VIEW;

  const watch = (id: string) => {
    if (sessions.has(id)) return;
    const session = transcript.history(id);
    sessions.set(id, session);
    disposers.set(id, session.state.subscribe(refresh));
    void session.start().then(refresh);
  };

  function refresh() {
    if (listeners.size === 0) return;
    const main = sessions.get(agentId)?.state.getState();
    if (includeWorkers) {
      for (const node of main?.projection.nodes ?? []) {
        if (node.kind === 'worker' && node.workerId) watch(node.workerId);
      }
    }
    let loading = false;
    let error: string | null = null;
    for (const [id, session] of sessions) {
      const state = session.state.getState();
      // Wait for real user-message boundaries; keep the last complete history during retries.
      if (state.projection.range.from === 0 && (state.phase === 'ready' || state.phase === 'failed')) {
        conversations.set(id, state.projection.nodes);
      }
      if (state.phase === 'idle' || state.phase === 'loading' || state.hasEarlier) loading = true;
      error ??= state.error;
    }
    snapshot = { ...collectFileChanges(agentId, conversations, includeWorkers), loading, error };
    for (const listener of listeners) listener();
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        watch(agentId);
        refresh();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        for (const dispose of disposers.values()) dispose();
        disposers.clear();
        sessions.clear();
      };
    },
    retry() {
      for (const session of sessions.values()) void session.start().then(refresh);
    },
  };
}

export function useFileChanges(agentId: string, includeWorkers: boolean) {
  const runtime = useRendererRuntime();
  const resource = useMemo(
    () => createFileChangesResource(runtime.transcript, agentId, includeWorkers),
    [runtime, agentId, includeWorkers],
  );
  const view = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot);
  return { ...view, retry: resource.retry };
}
