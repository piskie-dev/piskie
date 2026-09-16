import { describe, expect, it, vi } from 'vitest';
import type { ConversationEntry } from '@shared/types';
import type { ConversationPage } from '@shared/electron-contracts/agents';
import { createTranscriptStore } from '@/domains/transcript/transcript-store';
import { createFileChangesResource } from '../useFileChanges';
import { call, createWorker, pageSource, parent, result, user, write } from './fileChanges.fixtures';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('file change history subscriptions', () => {
  it('loads stopped workers from history and observes unopened workers without resetting on completion', async () => {
    const entries = new Map<string, ConversationEntry[]>([
      ['main', [user('round-one'), ...createWorker('worker-old'), ...createWorker('worker-live')]],
      ['worker-old', write('old-change', 'old')], ['worker-live', []],
    ]);
    const source = pageSource(entries);
    const conversation = vi.spyOn(source, 'conversation');
    const store = createTranscriptStore(source);
    const resource = createFileChangesResource(store, 'main', true);
    const unsubscribe = resource.subscribe(vi.fn());
    await vi.waitFor(() => expect(resource.getSnapshot().loading).toBe(false));
    expect(resource.getSnapshot().totals.added).toBe(1);
    expect(conversation.mock.calls.map(([id]) => id)).toContain('worker-old');
    const live = write('live-change', 'one\ntwo');
    entries.set('worker-live', live);
    live.forEach((entry, index) => store.applyConversation({ agentId: 'worker-live', entry, index }));
    expect(resource.getSnapshot().totals).toEqual({ filesChanged: 1, added: 3, removed: 0 });
    store.syncControl({});
    expect(resource.getSnapshot().totals.added).toBe(3);
    unsubscribe();
    const remounted = resource.subscribe(vi.fn());
    await vi.waitFor(() => expect(resource.getSnapshot().loading).toBe(false));
    expect(resource.getSnapshot().totals.added).toBe(3);
    remounted();
    store.close();
  });

  it('fills history beyond the chat tail, resolving the real turn and worker creation without widening the chat window', async () => {
    const records: ConversationEntry[] = [user('old-turn'), ...createWorker('worker'), ...write('old-write')];
    for (let index = 0; index < 820; index += 1) records.push({ t: 'msg', role: 'assistant', id: `filler-${index}`, ts: 5, content: 'Sample progress.' });
    records.push(user('recent-turn'), ...write('recent-write'));
    const source = pageSource(new Map([['main', records], ['worker', write('child-write')]]));
    const store = createTranscriptStore(source);
    const chat = store.session('main');
    await chat.start();
    const range = chat.state.getState().projection.range;
    const resource = createFileChangesResource(store, 'main', true);
    const unsubscribe = resource.subscribe(vi.fn());
    await vi.waitFor(() => expect(resource.getSnapshot().loading).toBe(false));
    expect(resource.getSnapshot().totals.added).toBe(3);
    expect(resource.getSnapshot().rounds.map((round) => round.id)).toEqual(['recent-turn', 'old-turn']);
    expect(resource.getSnapshot().rounds[1]!.files[0]!.records).toHaveLength(2);
    expect(chat.state.getState().projection.range).toEqual(range);
    expect(chat.state.getState().hasEarlier).toBe(true);
    unsubscribe();
    store.close();
  });

  it('deduplicates a live append covered by hydration and preserves live records while an older page is pending', async () => {
    const tail = deferred<ConversationPage>();
    const earlier = deferred<ConversationPage>();
    const records: ConversationEntry[] = [user('first-turn'), ...write('old'), user('latest-turn'), ...write('recent')];
    const store = createTranscriptStore({ conversation: vi.fn(async (_id, page) => (
      page.direction === 'tail' ? tail.promise : earlier.promise
    )) });
    const resource = createFileChangesResource(store, 'main', false);
    const unsubscribe = resource.subscribe(vi.fn());
    records.slice(3).forEach((entry, index) => store.applyConversation({ agentId: 'main', index: index + 3, entry }));
    tail.resolve({ from: 3, entries: records.slice(3), total: records.length });
    await vi.waitFor(() => expect(store.history('main').state.getState().hasEarlier).toBe(true));
    const live = write('live');
    live.forEach((entry, index) => store.applyConversation({ agentId: 'main', index: records.length + index, entry }));
    earlier.resolve({ from: 0, entries: records.slice(0, 3), total: records.length + live.length });
    await vi.waitFor(() => expect(resource.getSnapshot().loading).toBe(false));
    expect(resource.getSnapshot().totals).toEqual({ filesChanged: 1, added: 3, removed: 0 });
    expect(resource.getSnapshot().rounds[0]!.files[0]!.records.map((record) => record.node.id)).toEqual(['recent', 'live']);
    unsubscribe();
    store.close();
  });

  it('keeps appends received during cross-page result warmup through full history loading and retry', async () => {
    const records: ConversationEntry[] = Array.from({ length: 1200 }, (_, index) => ({
      t: 'msg', role: 'assistant', id: `filler-${index}`, ts: index, content: 'Sample progress.',
    }));
    records[0] = user('old-turn');
    records[399] = call('old-write', 'write', { file_path: '/workspace/old.txt', content: 'old' }, 399);
    records[400] = result('old-write', 'Written.', 400);
    records[900] = user('latest-turn', 'Sample next request.', 900);
    const warmup = deferred<ConversationPage>();
    const source = pageSource(new Map([['main', records]]));
    let warmupPending = false;
    const store = createTranscriptStore({ conversation: async (id, page) => {
      if (page.direction === 'backward' && page.before === 400 && !warmupPending) {
        warmupPending = true;
        return warmup.promise;
      }
      return source.conversation(id, page);
    } });
    const resource = createFileChangesResource(store, 'main', false);
    const unsubscribe = resource.subscribe(vi.fn());
    await vi.waitFor(() => expect(warmupPending).toBe(true));
    const live = write('live-write', 'live', '/workspace/live.txt', 1200);
    live.forEach((entry, offset) => store.applyConversation({ agentId: 'main', index: 1200 + offset, entry }));
    records.push(...live);
    expect(store.history('main').state.getState().projection.range.toExclusive).toBe(1202);
    warmup.resolve({ from: 0, entries: records.slice(0, 400), total: records.length });
    await vi.waitFor(() => expect(resource.getSnapshot().loading).toBe(false));
    expect(resource.getSnapshot().totals).toEqual({ filesChanged: 2, added: 2, removed: 0 });
    expect(resource.getSnapshot().rounds.map((round) => [round.id, round.files[0]?.records[0]?.node.id]))
      .toEqual([['latest-turn', 'live-write'], ['old-turn', 'old-write']]);
    expect(store.history('main').state.getState()).toMatchObject({
      projection: { range: { from: 0, toExclusive: 1202 } }, total: 1202,
    });
    resource.retry();
    await vi.waitFor(() => expect(resource.getSnapshot().loading).toBe(false));
    expect(resource.getSnapshot().totals).toEqual({ filesChanged: 2, added: 2, removed: 0 });
    unsubscribe();
    store.close();
  });

  it('retains totals while repairing a failed live gap and reloading history', async () => {
    const records = new Map<string, ConversationEntry[]>([['main', [user('turn'), ...write('first')]]]);
    const source = pageSource(records);
    const forward = deferred<ConversationPage>();
    const tail = deferred<ConversationPage>();
    const query = vi.spyOn(source, 'conversation');
    const store = createTranscriptStore(source);
    const resource = createFileChangesResource(store, 'main', false);
    const unsubscribe = resource.subscribe(vi.fn());
    await vi.waitFor(() => expect(resource.getSnapshot().loading).toBe(false));
    query.mockRejectedValueOnce(new Error('Sample gap failure'));
    store.applyConversation({ agentId: 'main', index: 5, entry: user('later-turn') });
    await vi.waitFor(() => expect(resource.getSnapshot().error).toBe('Sample gap failure'));
    query.mockImplementation(async (_id, page) => page.direction === 'tail' ? tail.promise : forward.promise);
    resource.retry();
    expect(resource.getSnapshot().totals.added).toBe(1);
    tail.resolve({ from: 3, entries: [...write('second'), user('later-turn')], total: 6 });
    await vi.waitFor(() => expect(store.history('main').state.getState().hasEarlier).toBe(true));
    expect(resource.getSnapshot().totals.added).toBe(1);
    forward.resolve({ from: 0, entries: records.get('main')!, total: 6 });
    await vi.waitFor(() => expect(resource.getSnapshot().loading).toBe(false));
    expect(resource.getSnapshot().totals.added).toBe(2);
    unsubscribe();
    store.close();
  });

  it('publishes a worker delivery and its totals together when the parent send result arrives', async () => {
    const main = [user('round-one'), ...createWorker('worker'), user('round-two', 'Sample second request.', 10),
      call('send', 'send_event', { type: 'message', targetId: 'worker', message: 'Continue.' }, 11)];
    const records = new Map<string, ConversationEntry[]>([['main', main], ['worker', []]]);
    const store = createTranscriptStore(pageSource(records));
    const resource = createFileChangesResource(store, 'main', true);
    const unsubscribe = resource.subscribe(vi.fn());
    await vi.waitFor(() => expect(resource.getSnapshot().loading).toBe(false));
    const delivery = [parent('delivery', 'Continue.', 13, 12), ...write('continued', 'sample', '/workspace/continued.txt', 14)];
    records.set('worker', delivery);
    delivery.forEach((entry, index) => store.applyConversation({ agentId: 'worker', index, entry }));
    expect(resource.getSnapshot().totals).toEqual({ filesChanged: 0, added: 0, removed: 0 });
    expect(resource.getSnapshot().rounds).toEqual([]);
    const settled = result('send', 'Sent.', 12);
    main.push(settled);
    store.applyConversation({ agentId: 'main', index: main.length - 1, entry: settled });
    expect(resource.getSnapshot().totals).toEqual({ filesChanged: 1, added: 1, removed: 0 });
    expect(resource.getSnapshot().rounds).toMatchObject([
      { id: 'round-two', files: [{ records: [{ node: { id: 'continued' } }] }] },
    ]);
    unsubscribe();
    store.close();
  });

  it('can retry an incomplete history query', async () => {
    const records = [user('old-turn'), ...write('old'), user('new-turn'), ...write('recent')];
    let failed = true;
    const store = createTranscriptStore({ conversation: async (_id, page) => {
      if (page.direction === 'tail') return { from: 3, entries: records.slice(3), total: records.length };
      if (failed) throw new Error('Sample connection failure');
      return { from: 0, entries: records.slice(0, 3), total: records.length };
    } });
    const resource = createFileChangesResource(store, 'main', false);
    const unsubscribe = resource.subscribe(vi.fn());
    await vi.waitFor(() => expect(resource.getSnapshot().error).toBe('Sample connection failure'));
    failed = false;
    resource.retry();
    await vi.waitFor(() => expect(resource.getSnapshot().loading).toBe(false));
    expect(resource.getSnapshot().error).toBeNull();
    expect(resource.getSnapshot().totals.added).toBe(2);
    unsubscribe();
    store.close();
  });
});
