import { describe, expect, it } from 'vitest';
import type { ConversationEntry, MsgEntry, ToolEntry } from '@shared/types/agent-control';
import { projectConversationNodes } from '../project-entry';
import { TranscriptProjector } from '../projector';

function user(id: string, text: string): MsgEntry {
  return { t: 'msg', id, ts: 1, role: 'user', subtype: 'user_input', content: text };
}

function call(id: string, name = 'read'): MsgEntry {
  return {
    t: 'msg',
    id: `message-${id}`,
    ts: 2,
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'inspect' },
      { type: 'tool_use', id, name, input: { path: '/tmp/a' } },
    ],
  };
}

function result(id: string, text = 'file body'): ToolEntry {
  return { t: 'tool', ts: 3, toolUseId: id, ok: true, result: [{ type: 'text', text }] };
}

function comparable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(comparable);
  if (!value || typeof value !== 'object') return typeof value === 'function' ? '[detail]' : value;
  return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, comparable(item)]));
}

describe('TranscriptProjector', () => {
  it('matches reference replay while applying entries incrementally', () => {
    const entries: ConversationEntry[] = [user('u-1', 'hello'), call('call-1'), result('call-1')];
    const projector = new TranscriptProjector();
    projector.reset(0, []);
    entries.forEach((entry, index) => expect(projector.apply(index, entry)).toBe(true));

    expect(comparable(projector.snapshot().nodes)).toEqual(comparable(projectConversationNodes(entries)));
  });

  it('ignores duplicate indices and settles only the matching tool node', () => {
    const projector = new TranscriptProjector();
    projector.reset(0, [call('call-1'), call('call-2')]);
    expect(projector.apply(2, result('call-1'))).toBe(true);
    expect(projector.apply(2, result('call-1', 'duplicate'))).toBe(false);

    const tools = projector.snapshot().nodes.filter((node) => node.kind === 'tool');
    expect(tools).toMatchObject([
      { id: 'call-1', state: { phase: 'ok' } },
      { id: 'call-2', state: { phase: 'running' } },
    ]);
  });

  it('resolves a result that appears before its call and falls back when no call exists', () => {
    const projector = new TranscriptProjector();
    projector.reset(0, [result('call-1')]);
    expect(projector.snapshot().nodes[0]).toMatchObject({
      kind: 'notice',
      id: 'tool-result:call-1:0',
    });

    projector.apply(1, call('call-1'));
    expect(projector.snapshot().nodes.some((node) => node.id === 'tool-result:call-1:0')).toBe(false);
    expect(projector.snapshot().nodes.find((node) => node.id === 'call-1'))
      .toMatchObject({ kind: 'tool', state: { phase: 'ok' } });
  });

  it('reprojects only affected approvals', () => {
    const projector = new TranscriptProjector();
    projector.reset(0, [call('call-1'), call('call-2')]);
    expect(projector.setPendingCallId('call-2')).toBe(true);
    expect(projector.snapshot().nodes.find((node) => node.id === 'call-2'))
      .toMatchObject({ state: { phase: 'awaiting-approval' } });
    expect(projector.snapshot().nodes.find((node) => node.id === 'call-1'))
      .toMatchObject({ state: { phase: 'running' } });
  });
});
