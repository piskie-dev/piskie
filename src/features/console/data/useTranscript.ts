import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import { useRendererRuntime } from '../../../renderer-runtime/hooks';
import { projectLiveNodes } from '../../../domains/transcript/live-generation';
import type { TranscriptSession } from '../../../domains/transcript/transcript-session';
import type { TranscriptSessionSnapshot } from '../../../domains/transcript/types';
import type { TranscriptNode } from '@/domains/transcript/nodes';

export interface TranscriptView {
  readonly nodes: readonly TranscriptNode[];
  readonly hasEarlier: boolean;
  readonly entryCount: number;
  readonly loaded: boolean;
  readonly loadEarlier: () => void;
}

export interface UseTranscriptOptions {
  readonly active?: boolean;
}

const EMPTY_SNAPSHOT: TranscriptSessionSnapshot = Object.freeze({
  phase: 'idle',
  projection: Object.freeze({
    range: Object.freeze({ from: 0, toExclusive: 0 }),
    nodes: Object.freeze([]),
    nodeIdsByEntry: new Map(),
    toolNodeByCallId: new Map(),
  }),
  live: Object.freeze({ phase: 'none' }),
  total: 0,
  hasEarlier: false,
  error: null,
});

function noopSubscribe(): () => void {
  return () => {};
}

export function useTranscript(
  agentId: string | null | undefined,
  options: UseTranscriptOptions = {},
): TranscriptView {
  const runtime = useRendererRuntime();
  const active = options.active ?? true;
  const session = useMemo<TranscriptSession | null>(
    () => agentId ? runtime.transcript.session(agentId) : null,
    [agentId, runtime],
  );
  const subscribe = useMemo(
    () => active && session ? session.state.subscribe : noopSubscribe,
    [active, session],
  );
  const getSnapshot = useCallback(
    () => session?.state.getState() ?? EMPTY_SNAPSHOT,
    [session],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!active || !session) return;
    void session.start();
  }, [active, session]);

  const nodes = useMemo(
    () => [
      ...snapshot.projection.nodes,
      ...(agentId ? projectLiveNodes(agentId, snapshot.live) : []),
    ],
    [agentId, snapshot.live, snapshot.projection.nodes],
  );
  const loadEarlier = useCallback(() => {
    if (active && session) void session.loadEarlier();
  }, [active, session]);

  return useMemo(() => ({
    nodes,
    hasEarlier: snapshot.hasEarlier,
    entryCount: snapshot.total,
    loaded: snapshot.phase === 'ready',
    loadEarlier,
  }), [loadEarlier, nodes, snapshot.hasEarlier, snapshot.phase, snapshot.total]);
}
