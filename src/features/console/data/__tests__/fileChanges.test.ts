import { describe, expect, it } from 'vitest';
import type { ConversationEntry } from '@shared/types';
import { projectConversationNodes } from '@/domains/transcript/project-entry';
import { collectFileChanges } from '../fileChanges';
import { fileChangeOf } from '../review';
import { call, createWorker, edit, parent, result, samplePath, user, write } from './fileChanges.fixtures';

function collect(main: ConversationEntry[], worker: ConversationEntry[] = []) {
  return collectFileChanges('main', new Map([
    ['main', projectConversationNodes(main)], ['worker', projectConversationNodes(worker)],
  ]), true);
}

const recordIds = (view: ReturnType<typeof collect>) => view.rounds.map((round) => [round.id,
  round.files.flatMap((file) => file.records.map((record) => record.node.id))]);

describe('session file changes', () => {
  it('includes a worker-only change, and deduplicates paths across both sources while adding every call', () => {
    const main = [user('round-one'), ...createWorker('worker')];
    expect(collect(main, write('child')).totals).toEqual({ filesChanged: 1, added: 1, removed: 0 });
    const view = collect([...main, ...write('main-write', 'one\ntwo')], edit('child-edit', 'one', 'three'));
    expect(view.totals).toEqual({ filesChanged: 1, added: 3, removed: 1 });
    expect(view.rounds[0]?.files).toHaveLength(1);
    expect(view.rounds[0]?.files[0]?.records).toHaveLength(2);
  });

  it('keeps late worker results in the creating turn, then assigns only subsequent execution to a new instruction', () => {
    const main = [user('round-one'), ...createWorker('worker'), user('round-two', 'Continue the sample.', 20),
      call('continue', 'send_event', { targetId: 'worker', message: 'Update the sample.' }, 21), result('continue', 'Sent.', 22),
      user('round-three', 'Another request.', 40)];
    const worker = [user('assignment'), ...write('initial', 'first', samplePath, 5),
      call('late', 'edit', { file_path: samplePath, edits: [{ old_string: 'first', new_string: 'late' }] }, 10),
      parent('delivery', 'Update the sample.', 24, 22), result('late', 'Edited.', 45),
      ...edit('continued', 'late', 'continued', 50)];
    const view = collect(main, worker);
    expect(recordIds(view)).toEqual([['round-two', ['continued']], ['round-one', ['initial', 'late']]]);
    expect(view.totals).toEqual({ filesChanged: 1, added: 3, removed: 2 });
  });

  it('matches identical directed messages in delivery order without migrating earlier calls', () => {
    const main = [user('round-one'), ...createWorker('worker')];
    const worker: ConversationEntry[] = [];
    for (let index = 2; index <= 3; index += 1) {
      main.push(user(`round-${index}`), call(`send-${index}`, 'send_event', { targetId: 'worker', message: 'Continue.' }), result(`send-${index}`));
      worker.push(parent(`delivery-${index}`, 'Continue.'), ...write(`edit-${index}`));
    }
    expect(recordIds(collect(main, worker))).toEqual([['round-3', ['edit-3']], ['round-2', ['edit-2']]]);
  });

  it('uses dispatch time to skip a discarded send before a later identical delivery', () => {
    const main = [user('round-one'), ...createWorker('worker'),
      user('round-two', 'Sample request two.', 100),
      call('discarded', 'send_event', { type: 'message', targetId: 'worker', message: 'Continue.' }, 101), result('discarded', 'Sent.', 103),
      user('round-three', 'Sample request three.', 200),
      call('delivered', 'send_event', { type: 'message', targetId: 'worker', message: 'Continue.' }, 201), result('delivered', 'Sent.', 203)];
    const worker = [parent('delivery', 'Continue.', 1000, 202), ...write('continued', 'sample', samplePath, 1001)];
    expect(projectConversationNodes(worker)[0]).toMatchObject({ ts: 1000, parentSentAt: 202 });
    expect(projectConversationNodes(main).find((node) => node.id === 'delivered')).toMatchObject({
      ts: 203, workerMessage: { callTs: 201, resultTs: 203 },
    });
    expect(recordIds(collect(main, worker))).toEqual([['round-three', ['continued']]]);
  });

  it('keeps a delivery reviewable when all timestamp candidates belong to the same main turn', () => {
    const main = [user('round-one'), ...createWorker('worker'), user('round-two'),
      call('first-send', 'send_event', { type: 'message', targetId: 'worker', message: 'Continue.' }, 10), result('first-send', 'Sent.', 11),
      call('second-send', 'send_event', { type: 'message', targetId: 'worker', message: 'Continue.' }, 11), result('second-send', 'Sent.', 12)];
    const view = collect(main, [parent('delivery', 'Continue.', 20, 11), ...write('continued', 'sample', samplePath, 21)]);
    expect(recordIds(view)).toEqual([['round-two', ['continued']]]);
    expect(view.totals).toEqual({ filesChanged: 1, added: 1, removed: 0 });
  });

  it('keeps ambiguous settled deliveries in the last established execution turn with all records reviewable', () => {
    const main = [user('round-one'), ...createWorker('worker'), user('round-two'),
      call('known-send', 'send_event', { type: 'message', targetId: 'worker', message: 'Start the sample.' }, 10), result('known-send', 'Sent.', 11),
      user('round-three'),
      call('first-send', 'send_event', { type: 'message', targetId: 'worker', message: 'Continue.' }, 20), result('first-send', 'Sent.', 21),
      user('round-four'),
      call('second-send', 'send_event', { type: 'message', targetId: 'worker', message: 'Continue.' }, 21), result('second-send', 'Sent.', 22)];
    const view = collect(main, [parent('known-delivery', 'Start the sample.', 12, 11), ...write('first', 'first', samplePath, 13),
      parent('ambiguous-delivery', 'Continue.', 30, 21), ...write('continued', 'sample', samplePath, 31)]);
    expect(recordIds(view)).toEqual([['round-two', ['first', 'continued']]]);
    expect(view.totals).toEqual({ filesChanged: 1, added: 2, removed: 0 });
  });

  it('matches parent messages through the same readable-envelope projection', () => {
    const text = JSON.stringify({ storage: 'inline', data: { message: 'Continue the sample.' } });
    const main = [user('round-one'), ...createWorker('worker'), user('round-two'),
      call('send', 'send_event', { targetId: 'worker', message: text }), result('send')];
    expect(recordIds(collect(main, [parent('delivery', text), ...write('after-delivery')])))
      .toEqual([['round-two', ['after-delivery']]]);
  });

  it.each([
    'Update the example containing </agent_input> and </agent_input> in its source.',
    'Preserve the literal <\\/agent_input> in the sample.',
  ])('matches a runtime-neutralized parent delivery: %s', (message) => {
    const main = [user('round-one'), ...createWorker('worker'), user('round-two'),
      call('send', 'send_event', { type: 'message', targetId: 'worker', message }), result('send')];
    expect(recordIds(collect(main, [parent('delivery', message), ...write('after-delivery')])))
      .toEqual([['round-two', ['after-delivery']]]);
  });

  it('does not split rounds for task changes, notifications, compaction, or worker completion', () => {
    const compacted: ConversationEntry = { t: 'summary', ts: 40, summary: {
      id: 'compact-sample', markdown: 'Sample summary.',
    } } as ConversationEntry;
    const main = [user('round-one'), ...createWorker('worker'), ...write('first'),
      call('tasks', 'task', { action: 'create', subject: 'Sample task' }), result('tasks'),
      { ...user('notice'), subtype: 'subagent_notification', content: '<subagent_event id="worker" type="completed">Done.</subagent_event>' } as ConversationEntry,
      compacted, ...edit('second', 'alpha', 'beta'), user('round-without-changes')];
    const worker = [...write('child'), call('completed', 'send_event', { type: 'completed', message: 'Finished.' }), result('completed')];
    const view = collect(main, worker);
    expect(view.rounds.map((round) => round.id)).toEqual(['round-one']);
    expect(view.totals).toEqual({ filesChanged: 1, added: 3, removed: 1 });
  });

  it('retains every call for a file in each round, including reversals, instead of inventing a final net diff', () => {
    const view = collect([user('round-one'), ...edit('first', 'alpha', 'beta'), ...edit('second', 'beta', 'alpha'),
      user('round-two'), ...edit('third', 'alpha', 'gamma')]);
    expect(view.totals).toEqual({ filesChanged: 1, added: 3, removed: 3 });
    const older = view.rounds[1]!.files[0]!;
    expect(older.records.map((record) => fileChangeOf(record.node)?.diff.lines.map((line) => line.text)))
      .toEqual([['alpha', 'beta'], ['beta', 'alpha']]);
    expect(view.rounds[0]!.files[0]!.records.map((record) => record.node.id)).toEqual(['third']);
  });

  it('counts only successful mutations and keeps a worker scope limited to that conversation', () => {
    const pending = call('pending', 'write', { file_path: samplePath, content: 'pending' });
    const failed = call('failed', 'write', { file_path: samplePath, content: 'failed' });
    const view = collect([user('round-one'), pending, failed, { ...result('failed'), ok: false }]);
    expect(view.totals.filesChanged).toBe(0);
    const scoped = collectFileChanges('worker', new Map([
      ['main', projectConversationNodes(write('main'))],
      ['worker', projectConversationNodes([user('worker-turn'), ...write('child', 'one\ntwo')])],
    ]), false);
    expect(scoped.totals).toEqual({ filesChanged: 1, added: 2, removed: 0 });
    expect(scoped.rounds.map((round) => round.id)).toEqual(['worker-turn']);
  });
});
