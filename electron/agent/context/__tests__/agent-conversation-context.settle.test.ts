/**
 * 统一工具结算原语 + 请求规范化：
 * - Settler 三态（同步/幂等/不压缩）：后到结算返回 already_settled，反向孤儿和重复
 *   call ID 返回 unresolvable，重复 result 保留第一条
 * - normalizeToolMessagesForRequest 纯投影：并行结果按 call 顺序归位并置于普通内容前，
 *   transcript 不被修改；未配对 tool_use（pending ask）保留、missing result 不合成
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getAppPath: () => '/tmp' },
}));
vi.mock('../../../agent-runs/compaction-archive.js', () => ({
  compactionArchive: { saveCompaction: vi.fn(), loadCompactions: vi.fn(() => []) },
}));

import { AgentConversationContext } from '../agent-conversation-context.js';
import { ContextSettlementConversation, Settler } from '../../conversation/settler.js';
import { deriveIdlePermits } from '../../idle-permit.js';
import { fakeAgentInference } from '../../../testing/fake-agent-inference.js';
import type { Message, ContentBlock } from '../../../../shared/types/index.js';
import type { ConversationEntry } from '../../../../shared/types/agent-control.js';

const tu = (id: string, name = 'ask_user', input: unknown = { questions: [{ question: 'Q?' }] }): ContentBlock =>
  ({ type: 'tool_use', id, name, input } as ContentBlock);
const tr = (id: string, content: unknown = 'ok'): ContentBlock =>
  ({ type: 'tool_result', tool_use_id: id, content } as unknown as ContentBlock);
const text = (t: string): ContentBlock => ({ type: 'text', text: t } as ContentBlock);
const REQUEST_SHAPE = {
  systemPrompt: 'test system prompt',
  tools: [],
  model: { providerId: 'p', modelId: 'm' },
  promptCacheKey: 'agent-t',
};

function makeManager(): AgentConversationContext {
  return new AgentConversationContext({
    inference: fakeAgentInference(),
    target: { providerId: 'p', modelId: 'm' },
    mainAgentId: 'agent-t',
  });
}

let seq = 0;
function addAssistant(manager: AgentConversationContext, content: ContentBlock[]): void {
  manager.addAssistantMessage(content, `request-${++seq}`);
}

async function requestMessages(manager: AgentConversationContext): Promise<Message[]> {
  return (await manager.getMessagesForAI(REQUEST_SHAPE)).messages;
}

function makeSettler(
  manager: AgentConversationContext,
  appendEntry: (entry: ConversationEntry) => void = () => undefined,
): Settler {
  return new Settler(
    new ContextSettlementConversation(manager, appendEntry),
    () => undefined,
  );
}

/** 直接注入 fullMessages（构造 user 消息含 tool_result 块没有公开入口，测试直插私有区） */
function push(manager: AgentConversationContext, role: 'user' | 'assistant', content: ContentBlock[]): void {
  const target = manager as unknown as { context: { fullMessages: unknown[] } };
  target.context.fullMessages.push({
    id: `m-${++seq}`,
    role,
    content,
    timestamp: Date.now(),
  });
}

const flatpiskielocks = (messages: Message[]): ContentBlock[] =>
  messages.flatMap(m => (Array.isArray(m.content) ? (m.content as ContentBlock[]) : []));

describe('Settler production conversation boundary', () => {
  it('need_user_action 直接查询 ToolEntry.ok，且内部成功事实不进入模型请求', async () => {
    const manager = makeManager();
    const settler = makeSettler(manager);
    addAssistant(manager, [tu('need-user', 'send_event', { type: 'need_user_action' })]);

    expect(settler.settleLive({
      kind: 'tool',
      callId: 'need-user',
      toolName: 'send_event',
      result: { ok: true, text: 'delivered' },
    })).toBe('inserted');
    expect(manager.isToolCallSuccessful('need-user')).toBe(true);
    expect(deriveIdlePermits(
      manager.getAllMessages(),
      [],
      (callId) => manager.isToolCallSuccessful(callId),
    )).toEqual([{ kind: 'user_action', callId: 'need-user' }]);
    expect(manager.getAllMessages().some(message => 'toolResultOk' in message)).toBe(false);
    expect((await requestMessages(manager)).some(message => 'toolResultOk' in message)).toBe(false);
  });

  it('失败结算不被视为成功', () => {
    const manager = makeManager();
    const settler = makeSettler(manager);
    addAssistant(manager, [tu('failed-event', 'send_event', { type: 'need_user_action' })]);
    expect(settler.settleLive({
      kind: 'tool',
      callId: 'failed-event',
      toolName: 'send_event',
      result: { ok: false, text: 'not delivered' },
    })).toBe('inserted');
    expect(manager.isToolCallSuccessful('failed-event')).toBe(false);
  });

  it('新 MsgEntry 只持久化 replay/UI 真正消费的字段', () => {
    const manager = makeManager();
    const appends: Array<{ entry: ConversationEntry; requestId?: string }> = [];
    manager.setPersistHook((entry, metadata) => appends.push({
      entry,
      ...(metadata?.requestId && { requestId: metadata.requestId }),
    }));
    manager.addUserMessage('persisted message');
    manager.addAssistantMessage([{ type: 'text', text: 'canonical response' }], 'request-1');
    manager.flush();

    const entries = appends.map((append) => append.entry);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      t: 'msg',
      role: 'user',
      subtype: 'user_input',
      content: 'persisted message',
    });
    expect(entries[0]).not.toHaveProperty('estimatedTokens');
    expect(entries[0]).not.toHaveProperty('linkedToolUseId');
    expect(entries[1]).toEqual(expect.objectContaining({
      t: 'msg',
      role: 'assistant',
      content: [{ type: 'text', text: 'canonical response' }],
    }));
    expect(entries[1]).not.toHaveProperty('requestId');
    expect(appends[1]?.requestId).toBe('request-1');
    expect(entries[1]).not.toHaveProperty('aiMeta');
  });

  it('恢复通知先同步持久化，写入失败时不投影且 flush 不重复写入', () => {
    const manager = makeManager();
    manager.setPersistHook(() => { throw new Error('disk unavailable'); });

    expect(() => manager.addDurableUserMessage(
      'Worker interrupted',
      'system_event',
      'worker-interruption:worker-1',
    )).toThrow('disk unavailable');
    expect(manager.getAllMessages()).toEqual([]);

    const entries: ConversationEntry[] = [];
    manager.setPersistHook((entry) => entries.push(entry));
    manager.addDurableUserMessage(
      'Worker interrupted',
      'system_event',
      'worker-interruption:worker-1',
    );

    expect(entries).toEqual([expect.objectContaining({
      t: 'msg',
      id: 'worker-interruption:worker-1',
      role: 'user',
      subtype: 'system_event',
      content: 'Worker interrupted',
    })]);
    expect(manager.getAllMessages()).toEqual([expect.objectContaining({
      role: 'user',
      subtype: 'system_event',
      content: 'Worker interrupted',
    })]);

    manager.flush();
    expect(entries).toHaveLength(1);
  });

  it('inserted：写独立 user tool_result；二次结算 already_settled 不追加（后到者）', () => {
    const manager = makeManager();
    const entries: ConversationEntry[] = [];
    const settler = makeSettler(manager, entry => entries.push(entry));
    addAssistant(manager, [tu('a')]);

    const first = settler.settleLive({
      kind: 'answer', callId: 'a', toolName: 'ask_user', text: '用户的答案',
    });
    expect(first).toBe('inserted');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ t: 'tool', toolUseId: 'a' });
    const after = manager.getAllMessages();
    const last = after[after.length - 1];
    expect(last.role).toBe('user');
    expect((last.content as ContentBlock[])[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'a' });

    const second = settler.settleLive({
      kind: 'system', callId: 'a', toolName: 'ask_user', text: '迟到的 ESC 结算', ok: false,
      outcome: 'cancelled',
    });
    expect(second).toBe('already_settled');
    expect(manager.getAllMessages()).toHaveLength(after.length);   // 不追加、不双写
    manager.flush();
    expect(entries).toHaveLength(1); // projection 已标记落盘，flush 不重复写
  });

  it('失败结果从同一个 ok 事实派生 Anthropic is_error 信号', () => {
    const manager = makeManager();
    const entries: ConversationEntry[] = [];
    const settler = makeSettler(manager, entry => entries.push(entry));
    addAssistant(manager, [tu('failed')]);

    expect(settler.settleLive({
      kind: 'system', callId: 'failed', toolName: 'shell', text: 'boom', ok: false,
      outcome: 'failed',
    })).toBe('inserted');
    const last = manager.getAllMessages().at(-1)!;
    expect((last.content as ContentBlock[])[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'failed',
      content: [{ type: 'text', text: '<error>boom</error>' }],
      is_error: true,
    });
    expect(entries[0]).toMatchObject({ t: 'tool', ok: false });
  });

  it('unresolvable：无对应 call 不制造反向孤儿（replay 反向孤儿丢弃）', () => {
    const manager = makeManager();
    const entries: ConversationEntry[] = [];
    const settler = makeSettler(manager, entry => entries.push(entry));
    addAssistant(manager, [tu('a')]);
    const count = manager.getAllMessages().length;

    expect(settler.settleLive({
      kind: 'system', callId: 'ghost', toolName: 'shell', text: '孤儿结果', ok: false,
      outcome: 'failed',
    })).toBe('unresolvable');
    expect(manager.getAllMessages()).toHaveLength(count);
    expect(entries).toHaveLength(0);
  });

  it('unresolvable：重复 call ID 不插入，留给 Anthropic 报错而不猜测', () => {
    const manager = makeManager();
    const entries: ConversationEntry[] = [];
    const settler = makeSettler(manager, entry => entries.push(entry));
    addAssistant(manager, [tu('dup', 'ls', {})]);
    addAssistant(manager, [tu('dup', 'ls', {})]);

    expect(settler.settleLive({
      kind: 'system', callId: 'dup', toolName: 'ls', text: 'x', ok: false,
      outcome: 'failed',
    })).toBe('unresolvable');
    expect(flatpiskielocks(manager.getAllMessages()).some(b => b.type === 'tool_result')).toBe(false);
    expect(entries).toHaveLength(0);
  });

  it('同步契约：返回值是字符串三态而非 Promise（applyEvents 同步链的前提）', () => {
    const manager = makeManager();
    const settler = makeSettler(manager);
    addAssistant(manager, [tu('a')]);
    const ret = settler.settleLive({
      kind: 'system', callId: 'a', toolName: 'read', text: 'ok', ok: true, outcome: 'ok',
    }) as unknown;
    expect(typeof ret).toBe('string');
  });
});

describe('normalizeToolMessagesForRequest（纯投影，经 getMessagesForAI）', () => {
  it('连续 user 事实保持各自的 subtype 与消息边界', async () => {
    const manager = makeManager();
    manager.addUserMessage('用户原始输入', 'user_input');
    manager.addUserMessage('后台完成通知', 'system_event');

    const projected = await requestMessages(manager);

    expect(projected).toEqual([
      expect.objectContaining({
        role: 'user',
        content: '用户原始输入',
        subtype: 'user_input',
      }),
      expect.objectContaining({
        role: 'user',
        content: '后台完成通知',
        subtype: 'system_event',
      }),
    ]);
  });

  it('并行结果集中归位、顺序与 call 一致、tool_result 在普通内容之前；transcript 不被修改', async () => {
    const manager = makeManager();
    addAssistant(manager, [tu('A', 'ls', {}), tu('B', 'read', {})]);
    push(manager, 'user', [text('穿插的普通消息')]);
    push(manager, 'user', [tr('B', '结果B')]);            // 迟到且顺序颠倒
    push(manager, 'user', [tr('A', '结果A'), text('附言')]);
    const before = JSON.stringify(manager.getAllMessages());

    const projected = await requestMessages(manager);

    // assistant 批次后的首条 user：tool_result 集中且顺序 = call 顺序（A、B），普通内容在其后
    const idx = projected.findIndex(m => m.role === 'assistant'
      && Array.isArray(m.content) && (m.content as ContentBlock[]).some(b => b.type === 'tool_use'));
    expect(idx).toBeGreaterThanOrEqual(0);
    const following = projected[idx + 1];
    expect(following?.role).toBe('user');
    const blocks = following!.content as ContentBlock[];
    const kinds = blocks.map(b => (b.type === 'tool_result' ? `tr:${(b as { tool_use_id?: string }).tool_use_id}` : b.type));
    expect(kinds.slice(0, 2)).toEqual(['tr:A', 'tr:B']);
    expect(kinds.filter(k => k.startsWith('tr:'))).toHaveLength(2);   // 原位不重复输出
    const firstText = kinds.findIndex(k => k === 'text');
    expect(firstText === -1 || firstText >= 2).toBe(true);            // 结果位于普通内容之前

    // 纯投影：fullMessages 未被修改
    expect(JSON.stringify(manager.getAllMessages())).toBe(before);
  });

  it('请求 payload 删除反向孤儿 result，并在重复 result 中保留第一条', async () => {
    const manager = makeManager();
    addAssistant(manager, [tu('A', 'ls', {})]);
    push(manager, 'user', [tr('A', '第一条'), tr('ghost', '反向孤儿')]);
    push(manager, 'user', [tr('A', '第二条（重复）'), text('用户补充')]);

    const projected = await requestMessages(manager);
    const results = flatpiskielocks(projected)
      .filter(b => b.type === 'tool_result') as Array<{ tool_use_id: string; content?: unknown }>;
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ tool_use_id: 'A', content: '第一条' });
    // 普通内容不因清理丢失
    expect(flatpiskielocks(projected).some(b => b.type === 'text' && (b as { text?: string }).text === '用户补充')).toBe(true);
  });

  it('未配对 tool_use（pending ask）原样保留、不合成 result（pending 存活的关键）', async () => {
    const manager = makeManager();
    addAssistant(manager, [tu('ask-1')]);

    const projected = await requestMessages(manager);
    const blocks = flatpiskielocks(projected);
    expect(blocks.some(b => b.type === 'tool_use' && b.id === 'ask-1')).toBe(true);
    expect(blocks.some(b => b.type === 'tool_result')).toBe(false);
  });

  it('请求 payload 遇到重复 call ID 时不归位、不猜测，result 原位保留', async () => {
    const manager = makeManager();
    addAssistant(manager, [tu('dup', 'ls', {})]);
    push(manager, 'user', [tr('dup', '第一次结果')]);
    addAssistant(manager, [tu('dup', 'ls', {})]);

    const projected = await requestMessages(manager);
    const assistants = projected.filter(m => m.role === 'assistant'
      && Array.isArray(m.content) && (m.content as ContentBlock[]).some(b => b.type === 'tool_use'));
    expect(assistants).toHaveLength(2);   // call 侧原样发送，交 Anthropic 报错
    const results = flatpiskielocks(projected).filter(b => b.type === 'tool_result');
    expect(results).toHaveLength(1);      // result 原位保留恰一条
  });
});

describe('compaction summary message boundaries', () => {
  function buildMessages(
    firstSubtype: 'system_task' | 'assignment',
    content: string,
    suffix: Array<Record<string, unknown>> = [],
  ): Message[] {
    const manager = makeManager();
    const harness = manager as unknown as {
      context: {
        fullMessages: Array<Record<string, unknown>>;
        summaries: Array<Record<string, unknown>>;
      };
      projectModelMessages(): Message[];
    };
    harness.context.fullMessages = [
      {
        id: 'initial',
        role: 'user',
        content,
        subtype: firstSubtype,
        timestamp: 1,
        estimatedTokens: 10,
      },
      ...suffix,
    ];
    harness.context.summaries = [{ markdown: '# Compact summary\n\nCOMPACTED_HISTORY' }];
    return harness.projectModelMessages();
  }

  it('pending Worker Assignment 位于摘要之后并保持独立原文', () => {
    const messages = buildMessages('assignment', '<assignment>WORKER_PROMPT</assignment>');
    expect(messages).toHaveLength(2);
    expect(messages[0]?.subtype).toBe('context_summary');
    expect(messages[0]?.content).toContain('COMPACTED_HISTORY');
    expect(messages[1]).toMatchObject({
      subtype: 'assignment',
      content: '<assignment>WORKER_PROMPT</assignment>',
    });
  });

  it('任何 pending user 消息都不与摘要拼接或删除', () => {
    const messages = buildMessages('system_task', 'MAIN_INITIAL_TASK');
    expect(messages).toHaveLength(2);
    expect(messages[0]?.subtype).toBe('context_summary');
    expect(messages[0]?.content).toContain('COMPACTED_HISTORY');
    expect(messages[1]).toMatchObject({ subtype: 'system_task', content: 'MAIN_INITIAL_TASK' });
  });

  it('摘要位于最新 task 同步后缀之前，后续事实保持原始时间顺序', () => {
    const messages = buildMessages('assignment', '<assignment>WORKER_PROMPT</assignment>', [
      {
        id: 'task-call', role: 'assistant', content: [tu('task-sync', 'task', { items: [] })],
        timestamp: 2, estimatedTokens: 10,
      },
      {
        id: 'task-result', role: 'user', content: [tr('task-sync', '{"items":[]}')],
        timestamp: 3, estimatedTokens: 10,
      },
      {
        id: 'later-work', role: 'assistant', content: 'AFTER_TASK_WORK',
        timestamp: 4, estimatedTokens: 10,
      },
      {
        id: 'later-parent-event', role: 'user', content: 'NEW_PARENT_FACT',
        timestamp: 5, estimatedTokens: 10,
      },
    ]);
    const contents = messages.map((message) => typeof message.content === 'string'
      ? message.content
      : JSON.stringify(message.content));

    expect(contents[0]).toContain('COMPACTED_HISTORY');
    expect(contents[1]).toContain('WORKER_PROMPT');
    expect(contents[2]).toContain('task-sync');
    expect(contents[3]).toContain('task-sync');
    expect(contents[4]).toBe('AFTER_TASK_WORK');
    expect(contents[5]).toBe('NEW_PARENT_FACT');
  });
});
