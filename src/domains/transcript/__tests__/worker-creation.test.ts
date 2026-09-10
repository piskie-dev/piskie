import { describe, expect, it } from 'vitest';
import type { MsgEntry, ToolEntry } from '@shared/types/agent-control';
import { projectConversationNodes } from '../project-entry';
import { TranscriptProjector } from '../projector';

function call(id: string): MsgEntry {
  return {
    t: 'msg', id: `message-${id}`, ts: 1, role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'subagent', input: {
      type: 'explore', subject: 'Inspect the sample', prompt: 'Check the sample result.',
    } }],
  };
}

function result(id: string, workerId: string): ToolEntry {
  return {
    t: 'tool', toolUseId: id, ts: 2, ok: true,
    result: [{ type: 'text', text: `Worker 已按要求创建: Inspect the sample\nsubagentId: ${workerId}\n执行流水: /tmp/example/trace.jsonl` }],
  };
}

describe('worker creation projection', () => {
  it('pairs returned IDs by toolUseId and updates the original rows as results arrive', () => {
    const projector = new TranscriptProjector();
    const calls = [call('call-alpha'), call('call-beta')];
    projector.reset(0, calls);
    expect(projector.snapshot().nodes).toMatchObject([
      { id: 'call-alpha', workerId: '', creating: true },
      { id: 'call-beta', workerId: '', creating: true },
    ]);
    const beta = result('call-beta', 'worker-beta');
    projector.apply(2, beta);
    expect(projector.snapshot().nodes).toMatchObject([
      { id: 'call-alpha', workerId: '', creating: true },
      { id: 'call-beta', workerId: 'worker-beta', creating: false },
    ]);
    const alpha = result('call-alpha', 'worker-alpha');
    projector.apply(3, alpha);
    expect(projector.snapshot().nodes).toEqual(projectConversationNodes([...calls, beta, alpha]));
    expect(projector.snapshot().nodes).toMatchObject([
      { id: 'call-alpha', workerId: 'worker-alpha', creating: false },
      { id: 'call-beta', workerId: 'worker-beta', creating: false },
    ]);
  });

  it('keeps a historical success without an ID distinct from an unfinished call', () => {
    const legacy: ToolEntry = {
      t: 'tool', toolUseId: 'call-alpha', ts: 2, ok: true,
      result: [{ type: 'text', text: 'Worker created: Inspect the sample' }],
    };
    expect(projectConversationNodes([call('call-alpha'), legacy])).toMatchObject([
      { kind: 'worker', workerId: '', creating: false },
    ]);
  });

  it('does not mark an approval wait as executing', () => {
    expect(projectConversationNodes([call('call-alpha')], { pendingCallId: 'call-alpha' }))
      .toMatchObject([{ kind: 'worker', creating: false }]);
  });

  it.each([
    { ok: false, text: 'Sample creation failed.', phase: 'failed' },
    { ok: true, text: 'Tool call denied by user.', phase: 'cancelled' },
  ])('preserves degraded $phase tool rows', ({ ok, text, phase }) => {
    const entry: ToolEntry = {
      t: 'tool', toolUseId: 'call-alpha', ts: 2, ok,
      result: [{ type: 'text', text }],
    };
    expect(projectConversationNodes([call('call-alpha'), entry]))
      .toMatchObject([{ kind: 'tool', state: { phase } }]);
  });
});
