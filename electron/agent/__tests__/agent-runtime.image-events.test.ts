/**
 * 注入侧图片事件语义：
 * - defaultProcessEvent 空内容守卫收窄（正文与 images 都为空才忽略）
 * - 私聊纯图片产生只含 image block 的 user message
 * - pending ask_user 纯图片回答省略空 text block
 * - 文本+图片仍同时保留文本与全部 image blocks
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test', on: () => undefined },
}));

vi.mock('../../services/paths.service.js', () => ({
  pathsService: {
    getDefaultWorkspaceDir: () => '/tmp/piskie-test/workspace',
    getTempDir: (agentId: string) => `/tmp/piskie/${agentId}`,
    ensureTempDir: vi.fn(),
  },
}));
vi.mock('../../observability/incidents/agent-incident-store.js', () => ({
  agentIncidentStore: { raise: vi.fn(), recover: vi.fn() },
}));
vi.mock('../../agent-runs/compaction-archive.js', () => ({
  compactionArchive: { saveCompaction: vi.fn(), loadCompactions: vi.fn(() => []) },
}));

import { AgentRuntime } from '../agent-runtime.js';
import type { AgentConversationContext } from '../context/agent-conversation-context.js';
import type { AgentSpec } from '../specs/spec.js';
import type { Message, ContentBlock, AgentInputEvent } from '../../../shared/types/index.js';
import { fakeAgentInference } from '../../testing/fake-agent-inference.js';

function buildRuntime(): AgentRuntime {
  const spec = {
    name: 'director',
    role: 'worker',
    modules: [],
  } as unknown as AgentSpec;
  return new AgentRuntime({
    spec,
    inference: fakeAgentInference(),
    pilotPorts: undefined,
    conversationStore: { append: vi.fn(), count: vi.fn(() => 0) } as never,
    onStateChange: () => {},
    options: {
      mainAgentId: 'parent-1',
      initialModel: 'p::m',
      subagentConfig: {
        subject: '测试任务',
        taskIds: ['task-test'],
        prompt: '完成测试任务。',
        skills: [],
        mode: 'local',
      },
    } as never,
  });
}

interface Harness {
  runtime: AgentRuntime;
  context: AgentConversationContext;
  apply(events: AgentInputEvent[]): void;
  messages(): Message[];
}

function makeHarness(): Harness {
  const runtime = buildRuntime();
  // Settler 与 Context 在 Runtime 构造时成对创建，测试不能只替换其中一侧。
  const context = (runtime as unknown as { context: AgentConversationContext }).context;
  return {
    runtime,
    context,
    apply: events => (runtime as unknown as { applyEvents(e: AgentInputEvent[]): void }).applyEvents(events),
    messages: () => context.getAllMessages(),
  };
}

const IMG = { media_type: 'image/png', data: 'aW1nZGF0YQ==' };

const userEvent = (id: string, content: string, images?: Array<{ media_type: string; data: string }>): AgentInputEvent =>
  ({ id, source: 'user', content, timestamp: new Date(), ...(images ? { images } : {}) } as AgentInputEvent);

const askTu = (id: string): ContentBlock =>
  ({ type: 'tool_use', id, name: 'ask_user', input: { questions: [{ question: '继续吗？' }] } } as ContentBlock);

const toolResults = (messages: Message[]) =>
  messages.flatMap(m => (Array.isArray(m.content) ? m.content : []))
    .filter(b => (b as ContentBlock).type === 'tool_result') as Array<{ tool_use_id: string; content: unknown }>;

describe('defaultProcessEvent 空内容守卫', () => {
  it('私聊纯图片（content 为空 + images 非空）不提前返回，产生只含 image block 的 user message', () => {
    const h = makeHarness();
    h.apply([userEvent('evt-1', '', [IMG])]);

    const userMsgs = h.messages().filter(m => m.role === 'user');
    expect(userMsgs).toHaveLength(1);
    const blocks = userMsgs[0].content as ContentBlock[];
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aW1nZGF0YQ==' },
    });
    // 不产生空 text block
    expect(blocks.some(b => b.type === 'text')).toBe(false);
  });

  it('正文和 images 都为空的事件仍按现状忽略', () => {
    const h = makeHarness();
    h.apply([userEvent('evt-1', '')]);
    h.apply([{ id: 'evt-2', source: 'user', content: '', timestamp: new Date(), images: [] } as unknown as AgentInputEvent]);
    expect(h.messages()).toHaveLength(0);
  });

  it('文本+图片同时保留原文本与全部 image blocks', () => {
    const h = makeHarness();
    h.apply([userEvent('evt-1', '看这两张图', [IMG, { media_type: 'image/jpeg', data: 'anBn' }])]);

    const userMsgs = h.messages().filter(m => m.role === 'user');
    expect(userMsgs).toHaveLength(1);
    const blocks = userMsgs[0].content as ContentBlock[];
    expect(blocks.filter(b => b.type === 'image')).toHaveLength(2);
    expect(blocks.find(b => b.type === 'text')).toMatchObject({ type: 'text', text: '看这两张图' });
  });
});

describe('encodeAnswerContent 纯图片回答', () => {
  it('pending ask_user 收到纯图片回答 → tool_result 只含 image block，无空 text block', () => {
    const h = makeHarness();
    h.context.addAssistantMessage([askTu('ask-1')], 'fixture-request-1');

    h.apply([userEvent('evt-1', '', [IMG])]);

    const results = toolResults(h.messages());
    expect(results).toHaveLength(1);
    expect(results[0].tool_use_id).toBe('ask-1');
    const blocks = results[0].content as ContentBlock[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aW1nZGF0YQ==' },
    });
    expect(blocks.some(b => b.type === 'text')).toBe(false);
  });

  it('文本+图片回答不受纯图片修复影响：text block 在前，图片齐全', () => {
    const h = makeHarness();
    h.context.addAssistantMessage([askTu('ask-1')], 'fixture-request-2');

    h.apply([userEvent('evt-1', '选 A', [IMG])]);

    const results = toolResults(h.messages());
    const blocks = results[0].content as ContentBlock[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: 'text', text: '选 A' });
    expect(blocks[1]).toMatchObject({ type: 'image' });
  });
});

describe('Provider 请求保留 image block（穿过上下文构建）', () => {
  it('纯图片 user message 经 getMessagesForAI 后 image block 仍在', async () => {
    const h = makeHarness();
    h.apply([userEvent('evt-1', '', [IMG])]);

    const { messages: aiMessages } = await h.context.getMessagesForAI({
      systemPrompt: 'system prompt',
      tools: [],
      model: h.runtime.currentTarget,
      reasoningOverride: h.runtime.reasoningOverride,
      promptCacheKey: h.runtime.id,
    });
    const userMsgs = aiMessages.filter(m => m.role === 'user');
    expect(userMsgs.length).toBeGreaterThan(0);
    const blocks = userMsgs[userMsgs.length - 1].content as ContentBlock[];
    expect(blocks.some(b => b.type === 'image')).toBe(true);
    expect(blocks.some(b => b.type === 'text' && (b as { text?: string }).text === '')).toBe(false);
  });
});
