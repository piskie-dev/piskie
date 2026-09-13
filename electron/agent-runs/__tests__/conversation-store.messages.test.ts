import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConversationStore } from '../conversation-store.js';
import { hasUnreadMessages } from '../../../shared/agent-run-messages.js';
import type { AgentRunHeader, ConversationWriteEntry } from '../../../shared/types/agent-control.js';

const roots: string[] = [];
const MAIN = 'sample-main';
const header: AgentRunHeader = {
  agentId: MAIN, agentSpec: 'director', modeId: 'normal',
  runConfig: { name: 'Example conversation', description: '', promptTemplate: '' },
  createdAt: '2025-01-01T00:00:00Z', lastActiveAt: '2025-01-01T00:00:00Z',
  currentModel: 'example/model', approvalMode: 'auto', childAgents: [],
};
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'message-state-'));
  roots.push(root);
  const store = new ConversationStore(root);
  store.writeHeader(MAIN, header);
  return { root, store };
}
function assistant(ts: number): ConversationWriteEntry {
  return { t: 'msg', role: 'assistant', id: `reply-${ts}`, ts, content: 'Example reply' };
}
function user(ts: number): ConversationWriteEntry {
  return { t: 'msg', role: 'user', subtype: 'user_input', id: `input-${ts}`, ts, content: 'Example input' };
}
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

describe('main conversation message state', () => {
  it('bases existing history on read positions and persists subsequent unread across restarts', () => {
    const { root, store } = setup();
    store.append(MAIN, MAIN, user(1000));
    store.append(MAIN, MAIN, assistant(2000));
    // A pre-feature conversation contains JSONL and a header, without a read position.
    fs.unlinkSync(path.join(store.paths.mainDir(MAIN), 'read-state.json'));
    const enabled = new ConversationStore(root);
    expect(enabled.readMessageState(MAIN)).toEqual({
      latestMessage: { index: 1, timestamp: 2000 }, latestAssistantIndex: 1, readThroughIndex: 1,
    });
    enabled.append(MAIN, MAIN, assistant(3000));
    const restarted = new ConversationStore(root);
    expect(hasUnreadMessages(restarted.readMessageState(MAIN))).toBe(true);
    restarted.markRead(MAIN, 2);
    expect(new ConversationStore(root).readMessageState(MAIN).readThroughIndex).toBe(2);
    expect(hasUnreadMessages(new ConversationStore(root).readMessageState(MAIN))).toBe(false);
  });

  it('initializes the baseline before a new append even when the list has not been opened', () => {
    const { root, store } = setup();
    store.append(MAIN, MAIN, assistant(1000));
    fs.unlinkSync(path.join(store.paths.mainDir(MAIN), 'read-state.json'));
    const enabled = new ConversationStore(root);
    enabled.append(MAIN, MAIN, assistant(2000));
    expect(enabled.readMessageState(MAIN).readThroughIndex).toBe(0);
    expect(hasUnreadMessages(enabled.readMessageState(MAIN))).toBe(true);
  });

  it('counts user input and assistant text including progress, filtering tool, system and worker messages', () => {
    const { store } = setup();
    const observed: Array<{ agentId: string }> = [];
    store.subscribeAppends((event) => { if (event.messages) observed.push(event); });
    store.append(MAIN, MAIN, user(1000));
    expect(hasUnreadMessages(store.readMessageState(MAIN))).toBe(false);
    store.append(MAIN, MAIN, {
      t: 'msg', role: 'assistant', id: 'progress', ts: 2000,
      content: [{ type: 'text', text: 'Example progress' }, { type: 'tool_use', id: 'call', name: 'read', input: {} }],
    });
    const expected = store.readMessageState(MAIN);
    const internal: ConversationWriteEntry[] = [
      { t: 'msg', role: 'user', subtype: 'subagent_notification', id: 'report', ts: 3000, content: 'Example report' },
      { t: 'msg', role: 'user', subtype: 'system_event', id: 'restored', ts: 4000, content: 'Example restore event' },
      { t: 'msg', role: 'assistant', id: 'internal', ts: 5000, content: [{ type: 'tool_use', id: 'call', name: 'read', input: {} }] },
      { t: 'msg', role: 'assistant', id: 'thought', ts: 6000, content: [{ type: 'thinking', thinking: 'Example thought' }] },
      { t: 'tool', ts: 7000, toolUseId: 'call', result: [{ type: 'text', text: 'Example result' }], ok: true },
      { t: 'marker', ts: 8000, key: 'example', value: true },
    ];
    internal.forEach((entry) => store.append(MAIN, MAIN, entry));
    store.append(MAIN, 'sample-worker', assistant(9000));
    store.append(MAIN, 'sample-worker', user(10000));
    expect(store.readMessageState(MAIN)).toEqual(expected);
    expect(observed.map((event) => event.agentId)).toEqual([MAIN, MAIN]);
    expect(hasUnreadMessages(expected)).toBe(true);
    store.append(MAIN, MAIN, user(11000));
    expect(store.readMessageState(MAIN).latestMessage?.timestamp).toBe(11000);
    expect(hasUnreadMessages(store.readMessageState(MAIN))).toBe(true);
  });

  it('keeps message time independent of opening, renaming and restoring metadata', () => {
    const { store } = setup();
    store.append(MAIN, MAIN, assistant(1000));
    const expected = store.readMessageState(MAIN);
    store.read(MAIN, MAIN);
    store.writeHeader(MAIN, { ...header, runConfig: { ...header.runConfig, name: 'Renamed example' }, lastActiveAt: '2025-02-01T00:00:00Z' });
    expect(store.readMessageState(MAIN)).toEqual(expected);
  });

  it('does not let an old visible-message receipt clear a later reply or move the cursor backwards', () => {
    const { store } = setup();
    store.append(MAIN, MAIN, assistant(1000));
    store.append(MAIN, MAIN, assistant(2000));
    expect(hasUnreadMessages(store.markRead(MAIN, 0))).toBe(true);
    store.markRead(MAIN, 1);
    expect(store.markRead(MAIN, 0).readThroughIndex).toBe(1);
    store.append(MAIN, MAIN, user(3000));
    expect(hasUnreadMessages(store.readMessageState(MAIN))).toBe(false);
  });
});
