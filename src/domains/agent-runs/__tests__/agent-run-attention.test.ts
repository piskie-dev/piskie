import { describe, expect, it, vi } from 'vitest';
import type { AgentRunMessageState } from '@shared/agent-run-messages';
import type { AgentControlSnapshot, AgentRunClient, AgentRunSnapshot } from '@shared/electron-contracts/agent-runs';
import type { AIQuestion, ImageNodePublicState, PendingToolCall } from '@shared/types';
import type { ConversationAppendEvent } from '@shared/types/agent-control';
import { createAgentRunRepository } from '../agent-run-repository';

const MAIN = 'sample-main';
const WORKER = 'sample-worker';
const REQUEST = 'sample-request';
const baseMessages: AgentRunMessageState = {
  latestMessage: { index: 0, timestamp: 1000 }, latestAssistantIndex: -1, readThroughIndex: 0,
};
const run = (messages = baseMessages): AgentRunSnapshot => ({
  agentId: MAIN, agentSpec: 'director', modeId: 'normal', approvalMode: 'confirm',
  runConfig: { name: 'Example conversation', description: '', promptTemplate: '' },
  createdAt: '2025-01-01T00:00:00Z', lastActiveAt: '2025-01-01T00:00:00Z',
  currentModel: 'example/model', childAgents: [], messages,
});
const control = (overrides: Partial<AgentControlSnapshot> = {}): AgentControlSnapshot => ({
  agentId: MAIN, phase: 'waiting', children: [], conversationLength: 2,
  aiRequestState: { requestId: REQUEST, phase: 'finished', outcome: 'success', attempt: 0, maxAttempts: 1 },
  ...overrides,
} as AgentControlSnapshot);
const approval = (id: string, agentId = MAIN): PendingToolCall => ({
  id, agentId, mainAgentId: MAIN, toolName: 'example_tool', params: {},
  timestamp: new Date(1000), description: 'Example decision', category: 'local',
});
const question = (id: string, text = 'Example question'): AIQuestion => ({
  id, agentId: MAIN, questions: [{ question: text, multiSelect: false }], timestamp: new Date(1000),
});
const image = (status: ImageNodePublicState['status'], version = 1): ImageNodePublicState => ({
  id: 'sample-image-node', status, target: { providerId: 'example', modelId: 'image' }, createdAt: 1000,
  images: [{ id: 'sample-image', prompt: 'Example image', outputPath: '/sample/output.png', version, status: 'completed' }],
});
const reply = (withTools = false): ConversationAppendEvent => ({
  agentId: MAIN, requestId: REQUEST, index: 1,
  entry: {
    t: 'msg', role: 'assistant', id: 'sample-response', ts: 2000,
    content: [
      { type: 'thinking', thinking: 'Example reasoning' },
      { type: 'text', text: withTools ? 'Example progress' : 'Example final answer' },
      ...(withTools ? [{ type: 'tool_use' as const, id: 'sample-tool-call', name: 'task', input: {} }] : []),
    ],
  },
  messages: { latestMessage: { index: 1, timestamp: 2000 }, latestAssistantIndex: withTools ? -1 : 1, readThroughIndex: 0 },
});

function harness(overrides: Partial<AgentRunClient> = {}) {
  const client = {
    list: vi.fn(async () => [run()]),
    markRead: vi.fn(async (_agentId: string, throughIndex: number) => ({ ...baseMessages, readThroughIndex: throughIndex })),
    ...overrides,
  } as unknown as AgentRunClient;
  const repository = createAgentRunRepository(client);
  return {
    repository, client,
    sync: (state: AgentControlSnapshot | null) => repository.syncControl(state ? { [MAIN]: state } : {}),
    unread: () => repository.listState.getState().attentionByAgentId[MAIN]?.unread ?? false,
  };
}

describe('session attention', () => {
  it.each(['state-first', 'conversation-first'])('waits for the complete text-only response and normal settling (%s)', async (order) => {
    const h = harness();
    await h.repository.refresh();
    h.sync(control({ phase: 'thinking', activeStartedAt: 1000 }));
    expect(h.unread()).toBe(false);
    if (order === 'state-first') h.sync(control());
    h.repository.applyConversation(reply());
    if (order === 'conversation-first') {
      expect(h.unread()).toBe(false);
      // A finished AI request is still part of the active process until it settles.
      h.sync(control({ activeStartedAt: 1000 }));
      expect(h.unread()).toBe(false);
      h.sync(control());
    }
    expect(h.unread()).toBe(true);
    await h.repository.markRead(MAIN, 1);
    expect(h.unread()).toBe(false);
    h.sync(control());
    expect(h.unread()).toBe(false);
  });

  it('keeps text plus hidden tools as progress, including after a successful request and a list refresh', async () => {
    const event = reply(true);
    const h = harness({ list: vi.fn(async () => [run(event.messages!)]) });
    h.sync(control());
    await h.repository.refresh();
    h.repository.applyConversation(event);
    expect(h.unread()).toBe(false);
    expect(h.repository.listState.getState().runs[0]!.messages.latestMessage).toEqual({ index: 1, timestamp: 2000 });
    await h.repository.refresh();
    expect(h.unread()).toBe(false);
  });

  it.each(['cancelled', 'failed'] as const)('does not notify about a canonical reply from a %s process', async (outcome) => {
    const h = harness();
    await h.repository.refresh();
    h.sync(control({ phase: 'thinking', activeStartedAt: 1000 }));
    h.repository.applyConversation(reply());
    h.sync(control({
      interrupted: outcome === 'cancelled',
      aiRequestState: { requestId: REQUEST, phase: 'finished', outcome, attempt: 0, maxAttempts: 1 },
    }));
    expect(h.unread()).toBe(false);
    h.client.list = vi.fn(async () => [run(reply().messages!)]);
    await h.repository.refresh();
    h.sync(null);
    expect(h.unread()).toBe(false);
  });

  it('does not mistake waiting with a pending question for a completed response', async () => {
    const h = harness();
    await h.repository.refresh();
    h.sync(control({ pendingQuestion: question('sample-question') }));
    h.repository.applyConversation(reply(true));
    expect(h.unread()).toBe(true);
    await h.repository.markRead(MAIN, 1);
    expect(h.unread()).toBe(false);
    h.sync(control({ pendingQuestion: question('sample-question') }));
    expect(h.unread()).toBe(false);
  });

  it.each(['question', 'approval', 'plan'] as const)('notifies once for each pending %s and clears when resolved or cancelled', async (kind) => {
    const h = harness();
    await h.repository.refresh();
    const pending = (id: string) => control(kind === 'question'
      ? { pendingQuestion: question(id) }
      : { pendingToolCall: { ...approval(id), ...(kind === 'plan' ? { modeInvariant: true, autoApproveAt: 5000 } : {}) } });
    h.sync(pending('first-decision'));
    expect(h.unread()).toBe(true);
    await h.repository.markRead(MAIN, 0);
    h.sync(pending('first-decision'));
    await h.repository.refresh();
    expect(h.unread()).toBe(false);
    expect(h.client.markRead).not.toHaveBeenCalled();
    h.sync(pending('next-decision'));
    expect(h.unread()).toBe(true);
    h.sync(control());
    expect(h.unread()).toBe(false);
    h.sync(pending('cancelled-decision'));
    expect(h.unread()).toBe(true);
    h.sync(null);
    expect(h.unread()).toBe(false);
  });

  it('recognizes successive MCP questions for the same tool call without using snapshot timestamps', async () => {
    const h = harness();
    h.sync(control({ pendingQuestion: question('sample-continuation') }));
    await h.repository.markRead(MAIN, -1);
    h.sync(control({ pendingQuestion: { ...question('sample-continuation'), timestamp: new Date(2000) } }));
    expect(h.unread()).toBe(false);
    h.sync(control({ pendingQuestion: question('sample-continuation', 'Another example question') }));
    expect(h.unread()).toBe(true);
    await h.repository.markRead(MAIN, -1);
    h.sync(control());
    h.sync(control({ pendingQuestion: question('sample-continuation', 'Another example question') }));
    expect(h.unread()).toBe(true);
  });

  it.each(['approval', 'image'] as const)('maps worker %s to its main session without a worker sidebar row', async (kind) => {
    const h = harness();
    const child = {
      id: WORKER, phase: 'executing',
      ...(kind === 'approval' ? { pendingToolCall: approval('worker-decision', WORKER) } : { imageNodes: [image('pending_approval')] }),
    } as AgentControlSnapshot['children'][number];
    h.sync(control({ children: [child] }));
    expect(h.unread()).toBe(true);
    expect(h.repository.listState.getState().attentionByAgentId[WORKER]).toBeUndefined();
    await h.repository.markRead(MAIN, -1);
    h.sync(control({ children: [{ ...child }] }));
    expect(h.unread()).toBe(false);
    h.sync(control({ children: [] }));
    expect(h.unread()).toBe(false);
  });

  it('notifies for image preview and new candidates, but not generation, edit entry, or settlement', async () => {
    const h = harness();
    const syncImage = (status: ImageNodePublicState['status'], version = 1) => h.sync(control({ imageNodes: [image(status, version)] }));
    syncImage('generating');
    expect(h.unread()).toBe(false);
    syncImage('preview');
    expect(h.unread()).toBe(true);
    await h.repository.markRead(MAIN, -1);
    syncImage('preview');
    syncImage('pending_approval');
    expect(h.unread()).toBe(false);
    syncImage('regenerating');
    expect(h.unread()).toBe(false);
    syncImage('pending_approval', 2);
    expect(h.unread()).toBe(true);
    syncImage('committing', 2);
    expect(h.unread()).toBe(false);
    syncImage('approved', 2);
    expect(h.unread()).toBe(false);
    syncImage('cancelled', 2);
    expect(h.unread()).toBe(false);
  });

  it('keeps a new pending action when old read and list replies arrive after it', async () => {
    let finishRead!: (messages: AgentRunMessageState) => void;
    let finishList!: (runs: AgentRunSnapshot[]) => void;
    const h = harness({ markRead: () => new Promise((resolve) => { finishRead = resolve; }) });
    await h.repository.refresh();
    h.sync(control({ pendingQuestion: question('first-question') }));
    h.repository.applyConversation(reply(true));
    const reading = h.repository.markRead(MAIN, 1);
    h.client.list = vi.fn(() => new Promise<AgentRunSnapshot[]>((resolve) => { finishList = resolve; }));
    const listing = h.repository.refresh();
    h.sync(control({ pendingToolCall: approval('new-approval') }));
    finishRead({ ...reply(true).messages!, readThroughIndex: 1 });
    finishList([run()]);
    await Promise.all([reading, listing]);
    expect(h.unread()).toBe(true);
    await h.repository.markRead(MAIN, 1);
    expect(h.unread()).toBe(false);
    h.sync(control({ pendingToolCall: approval('new-approval') }));
    expect(h.unread()).toBe(false);
  });

  it('reads newly seen actions immediately while sharing an in-flight message receipt for the same index', async () => {
    let finishRead!: (messages: AgentRunMessageState) => void;
    const markRead = vi.fn(() => new Promise<AgentRunMessageState>((resolve) => { finishRead = resolve; }));
    const h = harness({ markRead });
    await h.repository.refresh();
    h.repository.applyConversation(reply(true));
    h.sync(control({ pendingQuestion: question('first-question') }));
    const first = h.repository.markRead(MAIN, 1);
    h.sync(control({ pendingQuestion: question('second-question') }));
    expect(h.unread()).toBe(true);
    const second = h.repository.markRead(MAIN, 1);
    expect(h.unread()).toBe(false);
    expect(markRead).toHaveBeenCalledTimes(1);
    h.sync(control({ pendingQuestion: question('third-question') }));
    finishRead({ ...reply(true).messages!, readThroughIndex: 1 });
    await Promise.all([first, second]);
    expect(h.unread()).toBe(true);
  });

  it('preserves append and pending observations that arrive before the first list response', async () => {
    let finishList!: (runs: AgentRunSnapshot[]) => void;
    const pendingList = new Promise<AgentRunSnapshot[]>((resolve) => { finishList = resolve; });
    const h = harness({ list: () => pendingList });
    const listing = h.repository.refresh();
    h.sync(control({ pendingQuestion: question('sample-question') }));
    h.repository.applyConversation(reply(true));
    finishList([run()]);
    await listing;
    await vi.waitFor(() => expect(h.repository.listState.getState().phase).toBe('ready'));
    expect(h.repository.listState.getState().runs[0]!.messages).toEqual(reply(true).messages);
    expect(h.unread()).toBe(true);
    h.sync(control());
    expect(h.unread()).toBe(false);
  });
});
