/**
 * MCP elicitation 答案配对（Runtime 消费侧）：
 * - 用户事件与在册续跑配对 → 记入 answers（不直接结算 tool_result）
 * - 单问题接受纯文本；多问题只接受面板结构化提交；数目不匹配丢弃告警
 * - 不可结算（无对应 tool_use / 已结算）→ 落回普通消息路径
 * - pendingQuestion 派生：无 pending ask 时来自续跑问题；作答后消失
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test', on: () => undefined },
}));
vi.mock('@electron/observability/logging/app-log.js', () => {
  const appLog = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  appLog.child.mockReturnValue(appLog);
  return { appLog };
});
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
import type { ToolSuspensionContinuation } from '../../tools/types.js';
import { appLog } from '@electron/observability/logging/app-log.js';
import { fakeAgentInference } from '../../testing/fake-agent-inference.js';

let assistantRequestSequence = 0;
function addAssistant(context: AgentConversationContext, content: ContentBlock[]): void {
  context.addAssistantMessage(content, `fixture-request-${++assistantRequestSequence}`);
}

function buildRuntime(): AgentRuntime {
  const spec = {
    name: 'director',
    role: 'worker',
    modules: [],
  } as unknown as AgentSpec;
  return new AgentRuntime({
    id: 'test-agent',
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

interface PendingRecord {
  toolUseId: string;
  toolName: string;
  continuation: ToolSuspensionContinuation;
  answers?: string[];
}

interface Harness {
  runtime: AgentRuntime;
  context: AgentConversationContext;
  apply(events: AgentInputEvent[]): void;
  messages(): Message[];
  setPending(record: PendingRecord): void;
  pending(): PendingRecord | undefined;
}

function makeHarness(): Harness {
  const runtime = buildRuntime();
  const context = (runtime as unknown as { context: AgentConversationContext }).context;
  const target = runtime as unknown as {
    applyEvents(e: AgentInputEvent[]): void;
    pendingToolContinuation?: PendingRecord;
  };
  return {
    runtime,
    context,
    apply: (events) => target.applyEvents(events),
    messages: () => context.getAllMessages(),
    setPending: (record) => {
      target.pendingToolContinuation = record;
    },
    pending: () => target.pendingToolContinuation,
  };
}

const mcpTu = (id: string): ContentBlock =>
  ({ type: 'tool_use', id, name: 'mcp__srv__ask-me', input: {} }) as ContentBlock;

const userEvent = (id: string, content: string): AgentInputEvent =>
  ({ id, source: 'user', content, timestamp: new Date() }) as AgentInputEvent;

const panelEvent = (id: string, answers: string[]): AgentInputEvent =>
  ({
    id,
    source: 'user',
    content: answers.join('\n'),
    timestamp: new Date(),
    uiSubmission: { kind: 'ask_user_answer', answers },
  }) as AgentInputEvent;

const toolResults = (messages: Message[]) =>
  messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => (b as ContentBlock).type === 'tool_result');

const plainUserTexts = (messages: Message[]) =>
  messages.filter(
    (m) =>
      m.role === 'user' &&
      (!Array.isArray(m.content) ||
        !(m.content as ContentBlock[]).some((b) => b.type === 'tool_result'))
  );

function pendingRecord(questions = [{ question: '需要 API key' }]): PendingRecord {
  return {
    toolUseId: 'mcp-1',
    toolName: 'mcp__srv__ask-me',
    continuation: { questions, resume: vi.fn(), cancel: vi.fn() },
  };
}

describe('续跑答案配对', () => {
  it('单问题 + 纯文本 → 记入 answers；不写 tool_result、不产生普通用户消息', () => {
    const h = makeHarness();
    addAssistant(h.context, [mcpTu('mcp-1')]);
    h.setPending(pendingRecord());

    h.apply([userEvent('evt-1', 'sk-123')]);

    expect(h.pending()?.answers).toEqual(['sk-123']);
    expect(toolResults(h.messages())).toHaveLength(0);
    expect(plainUserTexts(h.messages())).toHaveLength(0);
  });

  it('多问题 + 面板提交（数目一致）→ 按问题序记入', () => {
    const h = makeHarness();
    addAssistant(h.context, [mcpTu('mcp-1')]);
    h.setPending(pendingRecord([{ question: 'Q1' }, { question: 'Q2' }]));

    h.apply([panelEvent('evt-1', ['答一', '答二'])]);

    expect(h.pending()?.answers).toEqual(['答一', '答二']);
  });

  it('面板提交数目不匹配 → 丢弃告警，事件落回普通消息路径', () => {
    const h = makeHarness();
    addAssistant(h.context, [mcpTu('mcp-1')]);
    h.setPending(pendingRecord([{ question: 'Q1' }, { question: 'Q2' }]));

    h.apply([panelEvent('evt-1', ['只有一个'])]);

    expect(h.pending()?.answers).toBeUndefined();
    expect(plainUserTexts(h.messages())).toHaveLength(1);
    expect(vi.mocked(appLog.warn)).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'agent.answer_pairing.validate.rejected',
        context: expect.objectContaining({
          questionCount: 2,
          answerCount: 1,
          answerSource: 'continuation',
          reason: 'answer_count_mismatch',
        }),
      })
    );
  });

  it('多问题 + 散文本 → 不配对，落回普通消息路径', () => {
    const h = makeHarness();
    addAssistant(h.context, [mcpTu('mcp-1')]);
    h.setPending(pendingRecord([{ question: 'Q1' }, { question: 'Q2' }]));

    h.apply([userEvent('evt-1', '一段散文本')]);

    expect(h.pending()?.answers).toBeUndefined();
    expect(plainUserTexts(h.messages())).toHaveLength(1);
  });

  it('续跑不可结算（无对应 tool_use）→ 不配对', () => {
    const h = makeHarness();
    h.setPending(pendingRecord());

    h.apply([userEvent('evt-1', 'sk-123')]);

    expect(h.pending()?.answers).toBeUndefined();
    expect(plainUserTexts(h.messages())).toHaveLength(1);
  });

  it('已作答的续跑不再吞新事件', () => {
    const h = makeHarness();
    addAssistant(h.context, [mcpTu('mcp-1')]);
    const record = pendingRecord();
    record.answers = ['已答'];
    h.setPending(record);

    h.apply([userEvent('evt-1', '新消息')]);

    expect(h.pending()?.answers).toEqual(['已答']);
    expect(plainUserTexts(h.messages())).toHaveLength(1);
  });
});

describe('pendingQuestion 派生', () => {
  it('无 pending ask 时来自续跑问题（multiSelect 默认 false）；作答后消失', () => {
    const h = makeHarness();
    addAssistant(h.context, [mcpTu('mcp-1')]);
    h.setPending(
      pendingRecord([
        { question: '要哪个库？', options: ['a', 'b'] },
        { question: '选能力', options: ['x', 'y'], multiSelect: true },
      ])
    );

    const state = h.runtime.getControlState();
    expect(state.pendingQuestion).toMatchObject({
      id: 'mcp-1',
      questions: [
        { question: '要哪个库？', options: ['a', 'b'], multiSelect: false },
        { question: '选能力', options: ['x', 'y'], multiSelect: true },
      ],
    });

    h.apply([panelEvent('evt-1', ['a', 'x'])]);
    expect(h.runtime.getControlState().pendingQuestion).toBeUndefined();
  });
});
