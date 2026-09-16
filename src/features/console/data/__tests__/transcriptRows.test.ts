import { describe, expect, it } from 'vitest';
import type { ConversationEntry, MsgEntry, PersistedMessageBlock, ToolEntry } from '@shared/types/agent-control';
import { TranscriptProjector } from '@/domains/transcript/projector';
import { projectLiveNodes } from '@/domains/transcript/live-generation';
import { buildTranscriptRows, type TranscriptProcessBoundaries } from '../transcriptRows';

const user = (id = 'sample-user', ts = 1000): MsgEntry => ({
  t: 'msg', role: 'user', subtype: 'user_input', id, ts, content: 'Inspect the sample.',
});
const assistant = (id: string, content: MsgEntry['content'], ts = 2000): MsgEntry => ({
  t: 'msg', role: 'assistant', id, ts, content,
});
const text = (value: string): PersistedMessageBlock => ({ type: 'text', text: value });
const tool = (id: string, name = 'shell', input = {}): PersistedMessageBlock => ({
  type: 'tool_use', id, name, input,
});
const result = (id: string): ToolEntry => ({
  t: 'tool', toolUseId: id, ts: 3000, ok: true, result: [{ type: 'text', text: 'Sample result' }],
});
function project(entries: readonly ConversationEntry[], settled = false) {
  const projector = new TranscriptProjector();
  projector.reset(0, entries);
  const { nodes, responses } = projector.snapshot();
  return buildTranscriptRows(nodes, responses, settled).rows;
}

function observe(entries: readonly ConversationEntry[]) {
  const projector = new TranscriptProjector();
  projector.reset(0, entries);
  let boundaries: TranscriptProcessBoundaries = new Map();
  return {
    append: (entry: ConversationEntry) => projector.apply(projector.snapshot().range.toExclusive, entry),
    rows: (settled = false) => {
      const snapshot = projector.snapshot();
      const next = buildTranscriptRows(snapshot.nodes, snapshot.responses, settled, boundaries);
      boundaries = next.boundaries;
      return next.rows;
    },
  };
}

describe('user input boundaries', () => {
  it('folds previously observed unfinished work without inferring a final reply or duration', () => {
    const transcript = observe([
      user(), assistant('sample-preface', 'Inspecting.'),
      assistant('sample-work', [tool('sample-tool'), text('Continuing the inspection.')]), result('sample-tool'),
    ]);
    expect(transcript.rows().map((row) => row.kind)).toEqual(['node', 'node', 'node', 'node']);
    transcript.append(user('sample-next', 9000));
    transcript.append(assistant('sample-next-work', [text('Working on the new input.'), tool('sample-next-tool')], 10000));
    const rows = transcript.rows();
    expect(rows.map((row) => row.id)).toEqual([
      'sample-user', 'process:sample-user', 'sample-next', 'sample-next-work-text', 'sample-next-tool',
    ]);
    const process = rows[1]!;
    expect(process.kind).toBe('process');
    if (process.kind !== 'process') return;
    expect(process.durationMs).toBeUndefined();
    expect(process.rows.map((row) => row.id)).toEqual(['sample-preface', 'sample-tool', 'sample-work-text']);
    transcript.append({ ...result('sample-next-tool'), ts: 11000 });
    transcript.append(assistant('sample-final', 'Latest answer.', 12000));
    expect(transcript.rows(true).map((row) => row.id)).toEqual([
      'sample-user', 'process:sample-user', 'sample-next', 'process:sample-next', 'sample-final',
    ]);
  });

  it('also folds unfinished text when the latest response has a hidden tool', () => {
    const transcript = observe([
      user(), assistant('sample-work', [text('Work in progress.'), tool('sample-hidden', 'task')]), result('sample-hidden'),
    ]);
    transcript.rows(true);
    transcript.append(user('sample-next', 9000));
    const rows = transcript.rows();
    expect(rows.map((row) => row.id)).toEqual(['sample-user', 'process:sample-user', 'sample-next']);
    expect(rows[1]).toMatchObject({ kind: 'process', durationMs: undefined, rows: [{ id: 'sample-work-text' }] });
  });

  it.each([false, true])('retains a normal final reply across activity changes and new input (preceding work: %s)', (hasWork) => {
    const transcript = observe([
      user(), ...(hasWork ? [assistant('sample-work', 'Inspecting.')] : []),
      assistant('sample-final', 'Completed answer.', 8000),
    ]);
    const completed = transcript.rows(true);
    expect(transcript.rows()).toEqual(completed);
    transcript.append(user('sample-next', 9000));
    const rows = transcript.rows();
    expect(rows.slice(0, -1)).toEqual(completed);
    expect(rows.slice(-2).map((row) => row.id)).toEqual(['sample-final', 'sample-next']);
  });

  it.each(['shell', 'task'])('folds new unfinished content after a confirmed direct reply, including %s responses', (name) => {
    const transcript = observe([user(), assistant('sample-first-final', 'First reply.', 8000)]);
    transcript.rows(true);
    transcript.append(assistant('sample-resumed-work', [text('Reviewing the update.'), tool('sample-resumed-tool', name)], 10000));
    transcript.append({ ...result('sample-resumed-tool'), ts: 11000 });
    transcript.rows(true);
    transcript.append(user('sample-next', 15000));
    const rows = transcript.rows();
    expect(rows.map((row) => row.id)).toEqual(['sample-user', 'process:sample-user', 'sample-next']);
    const process = rows[1]!;
    expect(process.kind).toBe('process');
    if (process.kind !== 'process') return;
    expect(process.durationMs).toBeUndefined();
    expect(process.rows.slice(0, 2).map((row) => row.id)).toEqual(['sample-first-final', 'sample-resumed-work-text']);
  });

  it('preserves a confirmed final reply when only a notice arrived before the next user input', () => {
    const transcript = observe([
      user(), assistant('sample-work', 'Inspecting.'), assistant('sample-final', 'Completed answer.', 8000),
    ]);
    const completed = transcript.rows(true);
    transcript.append({
      t: 'msg', role: 'user', id: 'sample-notice', ts: 9000, subtype: 'subagent_notification',
      content: '<subagent_event id="sample-worker" type="message">Sample worker update.</subagent_event>',
    });
    transcript.rows();
    transcript.append(user('sample-next', 15000));
    expect(transcript.rows().slice(0, -2)).toEqual(completed);
  });

  it('retains the latest final reply when the resumed work normally completes before the next input', () => {
    const transcript = observe([user(), assistant('sample-first-final', 'First reply.', 8000)]);
    transcript.rows(true);
    transcript.append(assistant('sample-resumed-work', [tool('sample-resumed-tool')], 10000));
    transcript.append({ ...result('sample-resumed-tool'), ts: 11000 });
    transcript.rows();
    transcript.append(assistant('sample-latest-final', 'Latest answer.', 12000));
    const completed = transcript.rows(true);
    expect(completed.map((row) => row.id)).toEqual(['sample-user', 'process:sample-user', 'sample-latest-final']);
    transcript.rows();
    transcript.append(user('sample-next', 15000));
    expect(transcript.rows().slice(0, -1)).toEqual(completed);
  });

  it('keeps existing parent-message segmentation without triggering the user-input fold', () => {
    const transcript = observe([user(), assistant('sample-work', [tool('sample-tool')]), result('sample-tool')]);
    transcript.rows();
    transcript.append({
      t: 'msg', role: 'user', id: 'sample-input', ts: 9000, subtype: 'system_event',
      content: '<agent_input source="parent:sample-agent">Sample parent update.</agent_input>',
    });
    expect(transcript.rows().map((row) => row.id)).toEqual(['sample-user', 'sample-tool', 'sample-input']);
  });

  it('does not retroactively fold an incomplete segment already followed by another user input on mount', () => {
    const transcript = observe([
      user(), assistant('sample-work', [tool('sample-tool')]), result('sample-tool'), user('sample-next', 9000),
    ]);
    const initial = transcript.rows();
    expect(initial.map((row) => row.id)).toEqual(['sample-user', 'sample-tool', 'sample-next']);
    expect(transcript.rows()).toEqual(initial);
  });
});

describe('transcript grouping', () => {
  it('groups calls across requests until the next text, keeping intervening content in order', () => {
    const rows = project([
      user(),
      assistant('sample-first', [text('Inspecting'), tool('call-one')]),
      result('call-one'),
      assistant('sample-second', [{ type: 'thinking', thinking: 'Check another input' }, tool('call-two')]),
      result('call-two'),
      assistant('sample-third', [text('Checking'), tool('call-three'), text('More context'), tool('call-four')]),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(['node', 'node', 'tools', 'node', 'node', 'node', 'node']);
    const intervals = rows.filter((row) => row.kind === 'tools');
    expect(intervals.map((row) => row.nodes.map((node) => node.kind))).toEqual([
      ['tool', 'think', 'tool'],
    ]);
    expect(intervals.map((row) => row.latest.id)).toEqual(['call-two']);
    expect(rows.slice(3).map((row) => row.kind === 'node' && row.node.kind))
      .toEqual(['assistant', 'tool', 'assistant', 'tool']);
  });

  it('splits tool groups at an inline worker without changing node order', () => {
    const rows = project([
      user(), assistant('sample-response', [
        text('Inspecting.'), tool('call-one'), tool('call-two'),
        tool('sample-worker-call', 'subagent', { subject: 'Sample work', type: 'local-worker' }),
        tool('call-three'), tool('call-four'), text('More context'),
      ]),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(['node', 'node', 'tools', 'node', 'tools', 'node']);
    expect(rows[2]).toMatchObject({ id: 'tools:call-one', nodes: [{ id: 'call-one' }, { id: 'call-two' }] });
    expect(rows[3]).toMatchObject({ kind: 'node', node: { kind: 'worker', id: 'sample-worker-call' } });
    expect(rows[4]).toMatchObject({ id: 'tools:call-three', nodes: [{ id: 'call-three' }, { id: 'call-four' }] });
  });

  it('keeps multiple worker cards and single calls at their original positions', () => {
    const rows = project([
      user(), assistant('sample-response', [
        tool('call-one'),
        tool('sample-worker-one', 'subagent', { subject: 'First sample', type: 'local-worker' }),
        tool('sample-worker-two', 'subagent', { subject: 'Second sample', type: 'local-worker' }),
        tool('call-two'),
        tool('sample-worker-three', 'subagent', { subject: 'Third sample', type: 'local-worker' }),
        tool('call-three'),
      ]),
    ]);
    expect(rows.map((row) => row.kind === 'node' && [row.node.id, row.node.kind])).toEqual([
      ['sample-user', 'user'], ['call-one', 'tool'], ['sample-worker-one', 'worker'],
      ['sample-worker-two', 'worker'], ['call-two', 'tool'], ['sample-worker-three', 'worker'], ['call-three', 'tool'],
    ]);
  });

  it('still groups a plan with adjacent tools', () => {
    const rows = project([
      user(), assistant('sample-response', [
        tool('call-one'), tool('sample-plan', 'plan', {
          action: 'create', taskSummary: 'Sample plan', planDocument: 'Review the sample.',
        }),
      ]),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(['node', 'tools']);
    expect(rows[1]).toMatchObject({ nodes: [{ kind: 'tool' }, { kind: 'plan' }] });
  });

  it.each([
    ['shell', {}, 'tool'],
    ['plan', { action: 'create', taskSummary: 'Sample plan', planDocument: 'Review the sample.' }, 'plan'],
    ['subagent', { subject: 'Sample work', type: 'local-worker' }, 'worker'],
  ])('renders a single %s call directly, including adjacent thinking', (name, input, kind) => {
    const rows = project([
      user(), assistant('sample-single', [
        { type: 'thinking', thinking: 'Before the call' }, tool('sample-call', name, input),
        { type: 'thinking', thinking: 'After the call' },
      ]),
    ]);
    expect(rows.map((row) => row.kind === 'node' && row.node.kind)).toEqual(['user', 'think', kind, 'think']);
  });

  it.each([
    ['plan', { action: 'create', taskSummary: 'Sample plan', planDocument: 'Review the sample.' }],
    ['subagent', { subject: 'Sample work', type: 'local-worker' }],
    ['task', { action: 'update' }],
  ])('does not mistake a response containing %s for a final reply', (name, input) => {
    const rows = project([
      user(), assistant('sample-preface', 'Inspecting the sample.'),
      assistant('sample-response', [tool('sample-call', name, input), text('Following the call')]),
      result('sample-call'),
    ], true);
    expect(rows.some((row) => row.kind === 'process')).toBe(false);
  });

  it('also sees a later assistant response whose only tool is suppressed', () => {
    const rows = project([
      user(), assistant('sample-preface', 'Inspecting.'), assistant('sample-answer', 'Some text'),
      assistant('sample-hidden', [tool('sample-call', 'task')]), result('sample-call'),
    ], true);
    expect(rows.some((row) => row.kind === 'process')).toBe(false);
  });

  it('folds all preceding work and leaves every final text block outside the process', () => {
    const rows = project([
      user(), assistant('sample-preface', 'Inspecting.'),
      assistant('sample-work', [tool('sample-call')]), result('sample-call'),
      assistant('sample-final', [
        { type: 'thinking', thinking: 'Conclude the review' }, text('Final paragraph'), text('More final content'),
      ], 78000),
    ], true);
    expect(rows.map((row) => row.kind)).toEqual(['node', 'process', 'node', 'node']);
    expect(rows[1]).toMatchObject({ kind: 'process', durationMs: 77000 });
    if (rows[1]?.kind === 'process') {
      expect(rows[1].rows.map((row) => row.kind === 'node' ? row.node.kind : row.kind))
        .toEqual(['assistant', 'tool', 'think']);
    }
  });

  it('keeps active work open and does not add an empty process to a direct answer', () => {
    const entries = [user(), assistant('sample-preface', 'Inspecting.'), assistant('sample-final', 'Final reply')];
    expect(project(entries, false).every((row) => row.kind !== 'process')).toBe(true);
    expect(project([user(), assistant('sample-final', 'Final reply')], true).map((row) => row.kind))
      .toEqual(['node', 'node']);
  });

  it('folds earlier exchanges independently of current activity and uses available history timestamps', () => {
    const entries = [
      user('sample-earlier', 0), assistant('sample-preface', 'Inspecting.'), assistant('sample-final', 'First answer'),
      user('sample-new', 5000), assistant('sample-current', 'Working on the new input.'),
    ];
    const rows = project(entries);
    expect(rows.filter((row) => row.kind === 'process')).toMatchObject([{ durationMs: undefined }]);
    expect(rows.at(-1)).toMatchObject({ kind: 'node', node: { markdown: 'Working on the new input.' } });
  });

  it.each([true, false])('offers a generic process for a partial history page (warmup: %s)', (withWarmup) => {
    const projector = new TranscriptProjector();
    projector.reset(5, [result('sample-call')], withWarmup
      ? [{ index: 2, entry: assistant('sample-work', [text('Inspecting'), tool('sample-call')]) }]
      : []);
    const { nodes, responses } = projector.snapshot();
    expect(responses).toEqual([]);
    const { rows } = buildTranscriptRows(nodes, responses, true);
    expect(rows.map((row) => row.kind)).toEqual(['process']);
    expect(rows[0]).toMatchObject({ kind: 'process' });
    if (rows[0]?.kind === 'process') {
      expect(rows[0].durationMs).toBeUndefined();
      expect(rows[0].rows.flatMap((row) => row.kind === 'node' ? [row.node] : row.nodes)).toEqual(nodes);
    }
    expect(buildTranscriptRows(nodes, responses, false).rows.some((row) => row.kind === 'process')).toBe(false);
    const awaitingCommit = projectLiveNodes('sample-agent', {
      phase: 'awaiting-commit', requestId: 'sample-request', runId: 'sample-run', attempt: 1,
      parts: [{ kind: 'text', markdown: 'A response still awaiting its complete record.' }],
    });
    expect(buildTranscriptRows([...nodes, ...awaitingCommit], responses, true).rows
      .some((row) => row.kind === 'process')).toBe(false);
  });

  it('associates final text by message identity when earlier tool calls are warmed up for pagination', () => {
    const projector = new TranscriptProjector();
    projector.reset(5, [
      result('sample-call'), assistant('sample-final', 'Final answer', 8000),
    ], [{ index: 2, entry: assistant('sample-work', [text('Inspecting'), tool('sample-call')]) }]);
    const snapshot = projector.snapshot();
    const { rows } = buildTranscriptRows(snapshot.nodes, snapshot.responses, true);
    expect(rows.map((row) => row.kind)).toEqual(['process', 'node']);
    expect(rows.at(-1)).toMatchObject({ kind: 'node', node: { markdown: 'Final answer' } });
    expect(rows[0]).toMatchObject({ durationMs: undefined });
  });
});
