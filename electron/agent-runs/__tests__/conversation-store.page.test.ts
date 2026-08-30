import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { ConversationStore } from '../conversation-store.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeStore(): ConversationStore {
  const root = mkdtempSync(join(tmpdir(), 'piskie-conversation-page-'));
  roots.push(root);
  return new ConversationStore(root);
}

function appendMessages(store: ConversationStore, count: number): void {
  for (let index = 0; index < count; index += 1) {
    store.append('main', 'main', {
      t: 'msg',
      id: `message-${index}`,
      ts: index,
      role: 'user',
      subtype: 'user_input',
      content: `message ${index}`,
    });
  }
}

describe('ConversationStore readPage', () => {
  it('reads bounded tail, forward and backward ranges with absolute offsets', () => {
    const store = makeStore();
    appendMessages(store, 10);

    expect(store.readPage('main', 'main', { direction: 'tail', limit: 3 }))
      .toMatchObject({ from: 7, total: 10, entries: [{ id: 'message-7' }, { id: 'message-8' }, { id: 'message-9' }] });
    expect(store.readPage('main', 'main', { direction: 'forward', from: 3, limit: 2 }))
      .toMatchObject({ from: 3, total: 10, entries: [{ id: 'message-3' }, { id: 'message-4' }] });
    expect(store.readPage('main', 'main', { direction: 'backward', before: 6, limit: 4 }))
      .toMatchObject({ from: 2, total: 10, entries: [
        { id: 'message-2' },
        { id: 'message-3' },
        { id: 'message-4' },
        { id: 'message-5' },
      ] });
  });

  it('extends the in-memory line index when a canonical entry is appended', () => {
    const store = makeStore();
    appendMessages(store, 2);
    expect(store.readPage('main', 'main', { direction: 'tail', limit: 1 }))
      .toMatchObject({ from: 1, total: 2, entries: [{ id: 'message-1' }] });

    appendMessages(store, 1);
    expect(store.readPage('main', 'main', { direction: 'tail', limit: 2 }))
      .toMatchObject({ from: 1, total: 3, entries: [{ id: 'message-1' }, { id: 'message-0' }] });
  });
});
