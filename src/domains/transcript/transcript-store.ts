import type { AgentLiveContentDelta } from '@shared/electron-contracts/agents';
import type { AgentControlTarget } from '../agent-control/agent-control-store';
import type { ConversationAppendEvent } from '@shared/types';
import type { AIRequestState } from '@shared/types';
import {
  createTranscriptSession,
  type ConversationPageSource,
  type TranscriptSession,
} from './transcript-session';

interface TargetControl {
  readonly request?: AIRequestState;
  readonly pendingCallId?: string;
}

export interface TranscriptStore {
  session(agentId: string): TranscriptSession;
  applyConversation(event: ConversationAppendEvent): void;
  enqueueLive(event: AgentLiveContentDelta): void;
  syncControl(targets: Readonly<Record<string, AgentControlTarget>>): void;
  close(): void;
}

export function createTranscriptStore(source: ConversationPageSource): TranscriptStore {
  const sessions = new Map<string, TranscriptSession>();
  const controls = new Map<string, TargetControl>();
  let liveQueue: AgentLiveContentDelta[] = [];
  let cancelFlush: (() => void) | null = null;
  let closed = false;

  const getSession = (agentId: string): TranscriptSession => {
    const existing = sessions.get(agentId);
    if (existing) return existing;
    const created = createTranscriptSession(agentId, source);
    const control = controls.get(agentId);
    created.setRequestState(control?.request);
    created.setPendingCallId(control?.pendingCallId);
    sessions.set(agentId, created);
    return created;
  };

  const flushLive = () => {
    cancelFlush = null;
    const batch = liveQueue;
    liveQueue = [];
    for (const event of batch) {
      const control = controls.get(event.agentId);
      const request = control?.request;
      const activeRequestId = request && request.phase !== 'finished'
        ? request.requestId
        : undefined;
      sessions.get(event.agentId)?.applyLive(event, activeRequestId);
    }
  };

  return {
    session(agentId) {
      if (closed) throw new Error('TranscriptStore is closed');
      return getSession(agentId);
    },
    applyConversation(event) {
      if (closed) return;
      sessions.get(event.agentId)?.append(event);
    },
    enqueueLive(event) {
      if (closed) return;
      liveQueue.push(event);
      if (cancelFlush) return;
      cancelFlush = scheduleFrame(flushLive);
    },
    syncControl(targets) {
      if (closed) return;
      const nextIds = new Set(Object.keys(targets));
      for (const id of controls.keys()) {
        if (nextIds.has(id)) continue;
        controls.delete(id);
        sessions.get(id)?.setRequestState(undefined);
        sessions.get(id)?.setPendingCallId(undefined);
      }
      for (const [id, target] of Object.entries(targets)) {
        const state = target.state;
        const next: TargetControl = {
          ...(state.aiRequestState ? { request: state.aiRequestState } : {}),
          ...(state.pendingToolCall ? { pendingCallId: state.pendingToolCall.id } : {}),
        };
        const previous = controls.get(id);
        if (
          previous?.request === next.request
          && previous?.pendingCallId === next.pendingCallId
        ) continue;
        controls.set(id, next);
        const session = sessions.get(id);
        session?.setRequestState(next.request);
        session?.setPendingCallId(next.pendingCallId);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      cancelFlush?.();
      cancelFlush = null;
      liveQueue = [];
      for (const session of sessions.values()) session.close();
      sessions.clear();
      controls.clear();
    },
  };
}

function scheduleFrame(callback: () => void): () => void {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(callback, 16);
  return () => clearTimeout(id);
}
