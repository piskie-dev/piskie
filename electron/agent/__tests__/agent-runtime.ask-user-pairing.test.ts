/**
 * 消费侧配对：
 * applyEvents 中用户事件与尾部合法 pending ask_user 的配对——
 * 实时回答与历史恢复 replay 字面同一段代码，此处锁定其全部分支。
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
import type {
  Message,
  ContentBlock,
  AgentInputEvent,
  PendingToolCall,
} from '../../../shared/types/index.js';
import type { ToolEntry } from '../../../shared/types/agent-control.js';
import { appLog } from '@electron/observability/logging/app-log.js';
import { fakeAgentInference } from '../../testing/fake-agent-inference.js';

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

interface Harness {
  runtime: AgentRuntime;
  context: AgentConversationContext;
  apply(events: AgentInputEvent[]): void;
  messages(): Message[];
  settle(callId: string, toolName: string, text: string): void;
  /** 落盘侧事实：conversationStore.append 收到的 ToolEntry（artifacts 断言用） */
  persistedToolEntries(): ToolEntry[];
}

let assistantRequestSequence = 0;
function addAssistant(context: AgentConversationContext, content: ContentBlock[]): void {
  context.addAssistantMessage(content, `fixture-request-${++assistantRequestSequence}`);
}

function makeHarness(): Harness {
  const runtime = buildRuntime();
  // Settler 与 Context 在 Runtime 构造时成对创建，测试不能只替换其中一侧。
  const context = (runtime as unknown as { context: AgentConversationContext }).context;
  const appendMock = (
    runtime as unknown as {
      conversationStore: { append: ReturnType<typeof vi.fn> };
    }
  ).conversationStore.append;
  return {
    runtime,
    context,
    apply: (events) =>
      (runtime as unknown as { applyEvents(e: AgentInputEvent[]): void }).applyEvents(events),
    messages: () => context.getAllMessages(),
    settle: (callId, toolName, text) => {
      const target = runtime as unknown as {
        settler: { settleLive(input: unknown): string };
      };
      target.settler.settleLive({
        kind: 'system',
        callId,
        toolName,
        text,
        ok: true,
        outcome: 'ok',
      });
    },
    persistedToolEntries: () =>
      appendMock.mock.calls
        .map((call) => call[2] as { t: string })
        .filter((entry): entry is ToolEntry => entry.t === 'tool'),
  };
}

const askTu = (id: string): ContentBlock =>
  ({
    type: 'tool_use',
    id,
    name: 'ask_user',
    input: { questions: [{ question: '继续吗？' }] },
  }) as ContentBlock;

const userEvent = (
  id: string,
  content: string,
  images?: Array<{ media_type: string; data: string }>
): AgentInputEvent =>
  ({
    id,
    source: 'user',
    content,
    timestamp: new Date(),
    ...(images ? { images } : {}),
  }) as AgentInputEvent;

const toolResults = (messages: Message[]) =>
  messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => (b as ContentBlock).type === 'tool_result') as Array<{
    tool_use_id: string;
    content: unknown;
  }>;

const plainUserTexts = (messages: Message[]) =>
  messages.filter(
    (m) =>
      m.role === 'user' &&
      (!Array.isArray(m.content) ||
        !(m.content as ContentBlock[]).some((b) => b.type === 'tool_result'))
  );

describe('消费侧配对', () => {
  it('回答含图片 → 唯一 tool_result（text+image），不产生普通用户消息', () => {
    const h = makeHarness();
    addAssistant(h.context, [askTu('ask-1')]);

    h.apply([userEvent('evt-1', '选方案 A', [{ media_type: 'image/png', data: 'aW1n' }])]);

    const results = toolResults(h.messages());
    expect(results).toHaveLength(1);
    expect(results[0].tool_use_id).toBe('ask-1');
    const blocks = results[0].content as ContentBlock[];
    expect(blocks[0]).toMatchObject({ type: 'text', text: '选方案 A' });
    expect(blocks[1]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aW1n' },
    });
    // 同一事件恰好一种模型可见形态：无普通用户消息
    expect(plainUserTexts(h.messages())).toHaveLength(0);
  });

  it('重复提交/IM 连发 → 第一条配对，第二条落回普通用户消息', () => {
    const h = makeHarness();
    addAssistant(h.context, [askTu('ask-1')]);

    h.apply([userEvent('evt-1', '第一次回答')]);
    h.apply([userEvent('evt-2', '第二次连发')]);

    const results = toolResults(h.messages());
    expect(results).toHaveLength(1); // pending 已消失，第二条不再配对

    const plains = plainUserTexts(h.messages());
    expect(plains).toHaveLength(1);
    expect(JSON.stringify(plains[0].content)).toContain('第二次连发');
  });

  it('较早损坏同 ID call + 尾部表面合法 ask → 不配对不吞消息，M 成为普通用户消息', () => {
    const h = makeHarness();
    // 损坏档案：较早批次同 ID call（已结算）+ 尾部表面合法 ask_user 撞同一 ID
    addAssistant(h.context, [
      { type: 'tool_use', id: 'dup', name: 'ls', input: {} } as ContentBlock,
    ]);
    h.settle('dup', 'ls', 'ls 结果');
    addAssistant(h.context, [askTu('dup')]);

    h.apply([userEvent('evt-M', '用户消息 M')]);

    expect(toolResults(h.messages())).toHaveLength(1); // 只有 ls 那条，未新增
    const plains = plainUserTexts(h.messages());
    expect(plains.some((m) => JSON.stringify(m.content).includes('用户消息 M'))).toBe(true);
  });

  it('pending 期间系统/子代理事件进入上下文后，pending 仍保持未配对', () => {
    const h = makeHarness();
    addAssistant(h.context, [askTu('ask-1')]);

    h.apply([
      {
        id: 'evt-agent',
        source: 'agent',
        content: '子代理进度汇报',
        timestamp: new Date(),
      } as AgentInputEvent,
    ]);

    expect(toolResults(h.messages())).toHaveLength(0); // 非用户事件绝不配对
    const plains = plainUserTexts(h.messages());
    expect(plains.some((m) => JSON.stringify(m.content).includes('子代理进度汇报'))).toBe(true);
  });

  it('pending ask 已结算 + role.onAfterInterrupt（writeHeader）抛错 → interrupt 不 reject，基类最终广播仍发出', async () => {
    const h = makeHarness();
    addAssistant(h.context, [askTu('ask-1')]);
    h.settle('ask-1', 'ask_user', '已有真实答案'); // pending 已结算

    const target = h.runtime as unknown as {
      role: { onAfterInterrupt(agent: unknown): void };
      stateChangeCallback?: () => void;
    };
    target.role.onAfterInterrupt = () => {
      throw new Error('writeHeader boom');
    };
    const broadcasts = vi.fn();
    target.stateChangeCallback = broadcasts;

    await expect(h.runtime.interrupt()).resolves.toBeUndefined();

    expect(broadcasts).toHaveBeenCalled(); // try/finally：header 写失败不吞最终 emitStateChange
    // 已结算的 ask 不被 interrupt 覆盖（结算只有 inserted 消费）
    const results = toolResults(h.messages());
    expect(results).toHaveLength(1);
    expect(results[0].content).toEqual([{ type: 'text', text: '已有真实答案' }]);
  });

  it('尾部纯文本（无 pending）：用户事件走普通路径（回归）', () => {
    const h = makeHarness();
    addAssistant(h.context, [{ type: 'text', text: '已完成' } as ContentBlock]);

    h.apply([userEvent('evt-1', '谢谢')]);

    expect(toolResults(h.messages())).toHaveLength(0);
    expect(
      plainUserTexts(h.messages()).some((m) => JSON.stringify(m.content).includes('谢谢'))
    ).toBe(true);
  });
});

const askTuMulti = (id: string, questions: string[]): ContentBlock =>
  ({
    type: 'tool_use',
    id,
    name: 'ask_user',
    input: { questions: questions.map((question) => ({ question })) },
  }) as ContentBlock;

const answerEvent = (
  id: string,
  content: string,
  answers: string[],
  images?: Array<{ media_type: string; data: string }>
): AgentInputEvent =>
  ({
    ...userEvent(id, content, images),
    uiSubmission: { kind: 'ask_user_answer', answers },
  }) as AgentInputEvent;

const artifactsOf = (h: Harness) =>
  h.persistedToolEntries().flatMap((entry) => entry.artifacts ?? []);

describe('ask_user answers artifact', () => {
  it('1. 单问题：旧序列化 content 照常进模型，原始数组进 artifact', () => {
    const h = makeHarness();
    addAssistant(h.context, [askTu('ask-1')]);

    h.apply([answerEvent('evt-1', '选方案 A', ['选方案 A'])]);

    // 模型面：与无旁路时相同的文本 tool_result
    const results = toolResults(h.messages());
    expect(results).toHaveLength(1);
    expect(results[0].content).toEqual([{ type: 'text', text: '选方案 A' }]);
    // 落盘面：原始数组
    const entry = h.persistedToolEntries().find((e) => e.toolUseId === 'ask-1');
    expect(entry?.artifacts).toEqual([
      { kind: 'ask_user_answers', payload: { answers: ['选方案 A'] } },
    ]);
  });

  it('2. 多问题按下标持久化（顺序即语义）', () => {
    const h = makeHarness();
    addAssistant(h.context, [askTuMulti('ask-1', ['选哪个方案？', '要测试吗？'])]);

    h.apply([answerEvent('evt-1', '序列化文本', ['方案 B', '要'])]);

    expect(artifactsOf(h)).toEqual([
      { kind: 'ask_user_answers', payload: { answers: ['方案 B', '要'] } },
    ]);
  });

  it('3. 自由输入含换行：artifact 原样保留', () => {
    const h = makeHarness();
    addAssistant(h.context, [askTu('ask-1')]);
    const multiline = '第一行\n第二行\n\n第四行';

    h.apply([answerEvent('evt-1', multiline, [multiline])]);

    expect(artifactsOf(h)).toEqual([
      { kind: 'ask_user_answers', payload: { answers: [multiline] } },
    ]);
  });

  it('4. 数量不匹配：文本结算成功、artifact 缺省、warn 只记计数不记内容', () => {
    const h = makeHarness();
    addAssistant(h.context, [askTuMulti('ask-1', ['Q1', 'Q2'])]);

    h.apply([answerEvent('evt-1', '只有一个答案的文本', ['只有一个答案的文本'])]);

    // 文本结算照常
    const results = toolResults(h.messages());
    expect(results).toHaveLength(1);
    // artifact 缺省（不截断、不补空、不部分配对）
    const entry = h.persistedToolEntries().find((e) => e.toolUseId === 'ask-1');
    expect(entry).toBeDefined();
    expect(entry && 'artifacts' in entry).toBe(false);
    // 审计只有计数，绝不含答案文本
    const warnCall = (appLog.warn as ReturnType<typeof vi.fn>).mock.calls.find(
      ([record]) => record.event === 'agent.answer_pairing.validate.rejected'
    );
    expect(warnCall).toBeDefined();
    expect(warnCall![0]).toMatchObject({
      message: 'Agent answer submission rejected',
      context: {
        scope: 'agent.answer_pairing',
        agentId: expect.any(String),
        toolUseId: 'ask-1',
        questionCount: 2,
        answerCount: 1,
        answerSource: 'ask_user',
        reason: 'answer_count_mismatch',
      },
    });
    expect(JSON.stringify(warnCall)).not.toContain('只有一个答案的文本');
  });

  it('5/6. 无 uiSubmission（普通 composer / IM / API）：正常结算但无 artifact', () => {
    const h = makeHarness();
    addAssistant(h.context, [askTu('ask-1')]);

    h.apply([userEvent('evt-1', 'IM 渠道的回答')]);

    const results = toolResults(h.messages());
    expect(results).toHaveLength(1);
    const entry = h.persistedToolEntries().find((e) => e.toolUseId === 'ask-1');
    expect(entry).toBeDefined();
    expect(entry && 'artifacts' in entry).toBe(false);
  });

  it('7. pending 已结算：旁路答案不被消费为 artifact，事件落回普通用户消息', () => {
    const h = makeHarness();
    addAssistant(h.context, [askTu('ask-1')]);
    h.settle('ask-1', 'ask_user', '已有真实答案');

    h.apply([answerEvent('evt-2', '迟到的回答', ['迟到的回答'])]);

    expect(toolResults(h.messages())).toHaveLength(1); // 仍只有已结算那条
    expect(artifactsOf(h)).toEqual([]);
    expect(
      plainUserTexts(h.messages()).some((m) => JSON.stringify(m.content).includes('迟到的回答'))
    ).toBe(true);
  });

  it('8. 图片行为不变：text+image tool_result 照旧，artifact 同时保留', () => {
    const h = makeHarness();
    addAssistant(h.context, [askTu('ask-1')]);

    h.apply([
      answerEvent('evt-1', '带图回答', ['带图回答'], [{ media_type: 'image/png', data: 'aW1n' }]),
    ]);

    const results = toolResults(h.messages());
    expect(results).toHaveLength(1);
    const blocks = results[0].content as ContentBlock[];
    expect(blocks[0]).toMatchObject({ type: 'text', text: '带图回答' });
    expect(blocks[1]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aW1n' },
    });
    expect(artifactsOf(h)).toEqual([
      { kind: 'ask_user_answers', payload: { answers: ['带图回答'] } },
    ]);
  });

  it('配对后 Context 模型消息与无旁路基线深度相等', () => {
    const withBypass = makeHarness();
    addAssistant(withBypass.context, [askTu('ask-1')]);
    withBypass.apply([answerEvent('evt-1', '同一段回答', ['同一段回答'])]);

    const baseline = makeHarness();
    addAssistant(baseline.context, [askTu('ask-1')]);
    baseline.apply([userEvent('evt-1', '同一段回答')]);

    expect(withBypass.messages()).toEqual(baseline.messages());
  });
});

describe('审批控制态投影', () => {
  const pending = (id: string): PendingToolCall => ({
    id,
    agentId: 'test-agent',
    mainAgentId: 'parent-1',
    toolName: 'test-tool',
    params: {},
    timestamp: new Date(),
    description: 'Tool approval',
    category: 'system',
  });

  it('从 pendingApprovals 的首项派生当前审批并在结算后推进', async () => {
    const h = makeHarness();
    h.runtime.setApprovalMode('confirm');

    const first = h.runtime.handleApprovalRequest(pending('first'));
    const second = h.runtime.handleApprovalRequest(pending('second'));
    expect(h.runtime.getControlState().pendingToolCall?.id).toBe('first');

    expect(h.runtime.respondToApproval({ callId: 'first', decision: 'allow' })).toBe(true);
    await expect(first).resolves.toMatchObject({ decision: 'allow' });
    expect(h.runtime.getControlState().pendingToolCall?.id).toBe('second');

    expect(h.runtime.respondToApproval({ callId: 'second', decision: 'deny' })).toBe(true);
    await expect(second).resolves.toMatchObject({ decision: 'deny' });
    expect(h.runtime.getControlState().pendingToolCall).toBeUndefined();
  });

  it('首项被取消时从同一 Map 推进到下一项', async () => {
    const h = makeHarness();
    h.runtime.setApprovalMode('confirm');
    const controller = new AbortController();

    const first = h.runtime.handleApprovalRequest(pending('first'), controller.signal);
    const second = h.runtime.handleApprovalRequest(pending('second'));
    controller.abort();

    await expect(first).resolves.toMatchObject({ decision: 'deny' });
    expect(h.runtime.getControlState().pendingToolCall?.id).toBe('second');

    h.runtime.respondToApproval({ callId: 'second', decision: 'allow' });
    await expect(second).resolves.toMatchObject({ decision: 'allow' });
  });
});
