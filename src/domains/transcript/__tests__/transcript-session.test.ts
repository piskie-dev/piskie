import { describe, expect, it, vi } from 'vitest';
import type {
  AgentLiveContentDelta,
  ConversationPage,
  ConversationPageRequest,
} from '@shared/electron-contracts/agents';
import type { ConversationAppendEvent, ConversationEntry, MsgEntry, ToolEntry } from '@shared/types';
import { createTranscriptSession, type ConversationPageSource } from '../transcript-session';

function message(id: string, text: string): MsgEntry {
  return { t: 'msg', id, ts: 1, role: 'user', subtype: 'user_input', content: text };
}

function call(id: string): MsgEntry {
  return {
    t: 'msg',
    id: `message-${id}`,
    ts: 2,
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'read', input: { path: '/tmp/a' } }],
  };
}

function result(id: string): ToolEntry {
  return { t: 'tool', ts: 3, toolUseId: id, ok: true, result: [{ type: 'text', text: 'body' }] };
}

function append(index: number, entry: ConversationEntry, requestId?: string): ConversationAppendEvent {
  return { agentId: 'agent-1', index, entry, ...(requestId ? { requestId } : {}) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function live(sequence: number, attempt: number, text: string): AgentLiveContentDelta {
  return {
    agentId: 'agent-1',
    requestId: 'request-1',
    runId: 'run-1',
    attempt,
    sequence,
    kind: 'text',
    delta: text,
  };
}

describe('TranscriptSession', () => {
  it('merges append events that race the initial page exactly once', async () => {
    const pending = deferred<ConversationPage>();
    const source: ConversationPageSource = { conversation: vi.fn(() => pending.promise) };
    const session = createTranscriptSession('agent-1', source);
    const started = session.start();
    session.append(append(2, message('u-3', 'three')));
    pending.resolve({ from: 0, entries: [message('u-1', 'one'), message('u-2', 'two')], total: 2 });
    await started;

    const snapshot = session.state.getState();
    expect(snapshot.projection.nodes.map((node) => node.id)).toEqual(['u-1', 'u-2', 'u-3']);
    expect(snapshot.total).toBe(3);
  });

  it('repairs an index gap with a forward page before applying buffered appends', async () => {
    const source: ConversationPageSource = {
      conversation: vi.fn(async (_agentId: string, page: ConversationPageRequest) => {
        if (page.direction === 'tail') return { from: 0, entries: [message('u-1', 'one')], total: 1 };
        if (page.direction === 'forward') return { from: 1, entries: [message('u-2', 'two')], total: 3 };
        throw new Error('unexpected page');
      }),
    };
    const session = createTranscriptSession('agent-1', source);
    await session.start();
    session.append(append(2, message('u-3', 'three')));
    await vi.waitFor(() => {
      expect(session.state.getState().projection.nodes.map((node) => node.id))
        .toEqual(['u-1', 'u-2', 'u-3']);
    });
  });

  it('warms up the lower page boundary to pair a visible tool result', async () => {
    const source: ConversationPageSource = {
      conversation: vi.fn(async (_agentId: string, page: ConversationPageRequest) => {
        if (page.direction === 'tail') return { from: 2, entries: [result('call-1')], total: 3 };
        if (page.direction === 'backward') return { from: 1, entries: [call('call-1')], total: 3 };
        throw new Error('unexpected page');
      }),
    };
    const session = createTranscriptSession('agent-1', source);
    await session.start();

    expect(session.state.getState().projection.nodes).toMatchObject([
      { id: 'call-1', kind: 'tool', state: { phase: 'ok' }, sourceIndex: 2 },
    ]);
  });

  it('publishes a newer attempt as a replacement live generation', () => {
    const source: ConversationPageSource = {
      conversation: vi.fn(async () => ({ from: 0, entries: [], total: 0 })),
    };
    const session = createTranscriptSession('agent-1', source);

    session.applyLive(live(1, 1, 'partial'), 'request-1');
    session.applyLive(live(2, 2, 'replacement'), 'request-1');

    expect(session.state.getState().live).toMatchObject({
      phase: 'streaming',
      attempt: 2,
      parts: [{ kind: 'text', markdown: 'replacement' }],
    });
  });
});
