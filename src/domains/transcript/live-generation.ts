import type { AgentLiveContentDelta } from '@shared/electron-contracts/agents';
import type { TranscriptNode } from './types';
import type { LiveGeneration, LivePart } from './types';

const MAX_LIVE_MARKDOWN_CHARS = 2 * 1024 * 1024;
const NONE: LiveGeneration = Object.freeze({ phase: 'none' });

export function emptyLiveGeneration(): LiveGeneration {
  return NONE;
}

export function applyLiveDelta(
  current: LiveGeneration,
  event: AgentLiveContentDelta,
  activeRequestId: string | undefined,
): LiveGeneration {
  if (activeRequestId !== event.requestId) return current;
  if (
    current.phase === 'closed'
    && current.requestId === event.requestId
    && (current.runId === undefined || current.runId === event.runId)
  ) {
    return current;
  }
  if (current.phase === 'suppressed' && current.requestId === event.requestId) return current;

  if (
    current.phase === 'none'
    || current.phase === 'closed'
    || current.requestId !== event.requestId
  ) {
    return start(event);
  }
  if (current.phase === 'awaiting-commit') return current;
  if (current.phase === 'suppressed') return current;
  if (current.runId !== event.runId) {
    return {
      phase: 'suppressed',
      requestId: event.requestId,
      runId: current.runId,
      reason: 'run-conflict',
    };
  }
  if (event.sequence <= current.lastSequence) return current;
  if (event.sequence !== current.lastSequence + 1) {
    return {
      phase: 'suppressed',
      requestId: event.requestId,
      runId: event.runId,
      reason: 'sequence-gap',
    };
  }
  if (event.attempt > current.attempt) {
    return replaceAttempt(event);
  }
  const length = current.parts.reduce((sum, part) => sum + part.markdown.length, 0);
  if (length + event.delta.length > MAX_LIVE_MARKDOWN_CHARS) {
    return {
      phase: 'suppressed',
      requestId: event.requestId,
      runId: event.runId,
      reason: 'memory-limit',
    };
  }
  const parts = current.parts.slice();
  const tail = parts.at(-1);
  if (tail?.kind === event.kind) {
    parts[parts.length - 1] = { ...tail, markdown: tail.markdown + event.delta };
  } else {
    parts.push({ kind: event.kind, markdown: event.delta });
  }
  return {
    phase: 'streaming',
    requestId: event.requestId,
    runId: event.runId,
    attempt: current.attempt,
    lastSequence: event.sequence,
    parts,
  };
}

export function finishLiveGeneration(
  current: LiveGeneration,
  requestId: string,
  outcome: 'success' | 'failed' | 'cancelled',
): LiveGeneration {
  if (current.phase === 'closed' && current.requestId === requestId) return current;
  if (current.phase === 'none' || current.requestId !== requestId) {
    return outcome === 'success'
      ? current
      : { phase: 'closed', requestId };
  }
  if (outcome === 'success' && current.phase === 'streaming') {
    return {
      phase: 'awaiting-commit',
      requestId: current.requestId,
      runId: current.runId,
      attempt: current.attempt,
      parts: current.parts,
    };
  }
  if (outcome === 'success' && current.phase === 'awaiting-commit') return current;
  return {
    phase: 'closed',
    requestId,
    ...('runId' in current && current.runId ? { runId: current.runId } : {}),
  };
}

export function commitLiveGeneration(
  current: LiveGeneration,
  requestId: string | undefined,
): LiveGeneration {
  if (!requestId || current.phase === 'none' || current.requestId !== requestId) return current;
  return {
    phase: 'closed',
    requestId: current.requestId,
    ...('runId' in current && current.runId ? { runId: current.runId } : {}),
  };
}

export function projectLiveNodes(
  agentId: string,
  generation: LiveGeneration,
): readonly TranscriptNode[] {
  if (generation.phase !== 'streaming' && generation.phase !== 'awaiting-commit') return [];
  const tailIndex = generation.parts.length - 1;
  return generation.parts.map((part, index) => liveNode(
    agentId,
    generation.requestId,
    part,
    index,
    generation.phase === 'streaming' && index === tailIndex,
  ));
}

function start(event: AgentLiveContentDelta): LiveGeneration {
  if (event.sequence !== 1) {
    return {
      phase: 'suppressed',
      requestId: event.requestId,
      runId: event.runId,
      reason: 'missing-prefix',
    };
  }
  if (event.delta.length > MAX_LIVE_MARKDOWN_CHARS) {
    return {
      phase: 'suppressed',
      requestId: event.requestId,
      runId: event.runId,
      reason: 'memory-limit',
    };
  }
  return {
    phase: 'streaming',
    requestId: event.requestId,
    runId: event.runId,
    attempt: event.attempt,
    lastSequence: 1,
    parts: [{ kind: event.kind, markdown: event.delta }],
  };
}

function replaceAttempt(event: AgentLiveContentDelta): LiveGeneration {
  if (event.delta.length > MAX_LIVE_MARKDOWN_CHARS) {
    return {
      phase: 'suppressed',
      requestId: event.requestId,
      runId: event.runId,
      reason: 'memory-limit',
    };
  }
  return {
    phase: 'streaming',
    requestId: event.requestId,
    runId: event.runId,
    attempt: event.attempt,
    lastSequence: event.sequence,
    parts: [{ kind: event.kind, markdown: event.delta }],
  };
}

function liveNode(
  agentId: string,
  requestId: string,
  part: LivePart,
  index: number,
  live: boolean,
): TranscriptNode {
  return {
    kind: part.kind === 'think' ? 'think' : 'assistant',
    id: `live:${agentId}:${requestId}:${index}`,
    ts: 0,
    sourceIndex: -1,
    titleKey: part.kind === 'think'
      ? 'transcript.title.thinking'
      : 'transcript.title.assistantResponse',
    markdown: part.markdown,
    live,
    tone: live ? 'live' : part.kind === 'think' ? 'muted' : 'neutral',
    interaction: 'none',
    defaultExpanded: true,
    summaryDuplicatesDetail: false,
  };
}
