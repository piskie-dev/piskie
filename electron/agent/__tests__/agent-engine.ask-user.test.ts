/**
 * AgentEngine 的 ask_user 挂起协议：
 * - pending ask 尾部 → 模型边界守卫直接 yield，零 Provider 调用；
 *   答案到达后一次看全、恰好一次请求
 * - 混批部分结果落盘后恢复 → 补齐 gate 违规失败文本（reconcile 分类表全行）
 * - suspended 分流：不写 tool_result、onAfterExecute 不调
 * - ESC 结算 canonical interrupted、写盘失败降级、双向竞态后到者不覆盖
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentControlState, ConversationEntry } from '../../../shared/types/agent-control.js';
import type {
  AIResponse,
  ContentBlock,
  Message,
} from '../../../shared/types/index.js';
import { AgentEngine, type TurnConfig, type TurnOutcome } from '../agent-engine.js';
import {
  resolveToolUseSettlement,
  getValidPendingAskUser,
  ASK_USER_GATE_VIOLATION_TEXT,
} from '../context/conversation-protocol.js';
import { Settler } from '../conversation/settler.js';
import { PendingSettlement } from '../tool-call/pending-settlement.js';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test' },
}));

async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

const askTu = (id: string, input: unknown = { questions: [{ question: '继续吗？' }] }): ContentBlock =>
  ({ type: 'tool_use', id, name: 'ask_user', input } as ContentBlock);
const normalTu = (id: string, name = 'ls'): ContentBlock =>
  ({ type: 'tool_use', id, name, input: {} } as ContentBlock);
const unwrapError = (text: unknown): string => {
  const value = String(text);
  return value.startsWith('<error>') && value.endsWith('</error>')
    ? value.slice('<error>'.length, -'</error>'.length)
    : value;
};

function aiResponse(content: ContentBlock[], index: number): AIResponse {
  const requestId = `request-${index}`;
  return {
    content,
    requestInfo: {
      version: 1,
      requestId,
      runId: `run-${index}`,
      model: 'provider::model',
      stopReason: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
      latencyMs: 1,
      usage: {},
    },
  };
}

/** 真实语义的最小 context：消息数组 + Settler 投影入口 */
class MiniContext {
  messages: Message[] = [];
  flushCount = 0;
  flushImpl?: () => void;
  appendImpl?: () => void;

  getAllMessages(): Message[] { return this.messages; }
  isToolCallSuccessful(callId: string): boolean {
    return this.messages.some((message) =>
      message.role === 'user'
      && (message as { toolResultOk?: boolean }).toolResultOk === true
      && Array.isArray(message.content)
      && message.content.some((block) =>
        block.type === 'tool_result' && block.tool_use_id === callId,
      ),
    );
  }
  appendToolResult(id: string, result: unknown[], ok?: boolean): void {
    this.appendImpl?.();
    const content = result.length === 1
      && typeof result[0] === 'object'
      && result[0] !== null
      && (result[0] as { type?: string }).type === 'text'
      ? (result[0] as { text?: string }).text ?? ''
      : result;
    this.messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content } as unknown as ContentBlock],
      toolResultOk: ok,
    });
  }
  addAssistantMessage(content: ContentBlock[] | string): void {
    this.messages.push({ role: 'assistant', content: content as Message['content'] });
  }
  addUserMessage(text: string): void {
    this.messages.push({ role: 'user', content: text });
  }
  async getMessagesForAI(): Promise<{ messages: Message[] }> { return { messages: this.messages }; }
  flush(): void { this.flushCount++; this.flushImpl?.(); }
  setModel(): void {}
  toolResults(): Array<{ tool_use_id: string; content: unknown }> {
    return this.messages.flatMap(m => (Array.isArray(m.content) ? m.content : []))
      .filter(b => (b as ContentBlock).type === 'tool_result') as never;
  }
}

class AskUserEngine extends AgentEngine {
  readonly mini = new MiniContext();
  callAICount = 0;
  /** callAI 每次返回的 content（默认纯文本 idle） */
  aiResponses: ContentBlock[][] = [];

  constructor() {
    super();
    this.id = 'ask-user-test';
    this.mainAgentId = this.id;
    this.context = this.mini as never;
    this.settler = new Settler({
      resolve: (callId) => resolveToolUseSettlement(this.mini.messages, callId),
      appendLiveToolResult: (callId, blocks, ok) => this.mini.appendToolResult(callId, blocks, ok),
      appendRecoveryToolResult: (callId, blocks, ok) => this.mini.appendToolResult(callId, blocks, ok),
      appendSystemMessage: vi.fn(),
    }, (callId) => this.recordToolSettled(callId));
    const snapshot = {
      definitions: () => [],
      resolve: () => undefined,
      resolveSkillFunction: () => ({ kind: 'notCallable' as const }),
    };
    this.toolCatalog = { snapshot: () => snapshot } as never;
    this.toolFace = {} as never;
    this.setCoordinator(async (name, callId) => new PendingSettlement(
      callId,
      name,
      { ok: true, text: `${name}-result` },
    ));
  }

  protected override async callAI(): Promise<AIResponse> {
    this.callAICount++;
    const content = this.aiResponses.shift() ?? [{ type: 'text', text: `ok-${this.callAICount}` } as ContentBlock];
    return aiResponse(content, this.callAICount);
  }

  override getAvailableTools(): never[] { return []; }
  protected override applyEvents(): void {}
  buildSystemPrompt(): string { return ''; }
  getControlState(): AgentControlState {
    return { agentId: this.id, phase: this.phase, interrupted: this.interrupted } as AgentControlState;
  }
  protected override appendConversationEntry(_entry: ConversationEntry): void {}

  setStateProbe(cb: (state: AgentControlState) => void): void { this.stateChangeCallback = cb; }
  reconcile(origin: 'runtime' | 'recovery') { return this.reconcileLatestToolBatch(origin); }
  async execTools(toolUses: ContentBlock[], opts: Parameters<AgentEngine['executeTools']>[2]): Promise<TurnOutcome> {
    return this.executeTools(toolUses, {} as never, opts, new Set());
  }
  async runConfigured(signal: AbortSignal, config: TurnConfig): Promise<TurnOutcome> {
    return super.runTurn(signal, config);
  }
  setCoordinator(run: (name: string, callId: string) => Promise<PendingSettlement | { suspended: true; reason: 'user_input' }>): void {
    this.toolCoordinator = {
      run: vi.fn((raw: { modelName: string; callId: string }) => run(raw.modelName, raw.callId)),
    } as never;
  }

  settle(callId: string, text: string, toolName = 'ask_user'): void {
    this.settler.settleLive({ kind: 'system', callId, toolName, text, ok: true, outcome: 'ok' });
  }
}

describe('模型边界守卫', () => {
  it('pending ask 尾部：直接 yield、零 callAI；答案到达后恰好一次请求', async () => {
    const engine = new AskUserEngine();
    engine.mini.addAssistantMessage([askTu('ask-1')]);

    engine.post({ source: 'agent', content: '子代理汇报' });
    await flushMicrotasks();

    expect(engine.callAICount).toBe(0);            // pending 期间 Provider 请求为零（含 compaction 前置）
    expect(engine.isPumping).toBe(false);          // 冲程已 yield 退场
    expect(engine.mini.toolResults()).toHaveLength(0);   // call 保持未配对

    // 答案到达（消费侧配对已写 tool_result）→ 新事件唤醒 → 一次看全、恰好一次请求
    engine.settle('ask-1', '用户的答案');
    engine.post({ source: 'user', content: '触发唤醒' });
    await flushMicrotasks(40);

    expect(engine.callAICount).toBe(1);
    expect(engine.isPumping).toBe(false);
  });

  it('suspended 分流走通全链：AI 返回 ask_user → 挂起 yield，不写 tool_result、不再请求', async () => {
    const engine = new AskUserEngine();
    engine.aiResponses = [[askTu('ask-live')]];
    engine.setCoordinator(async () => ({ suspended: true, reason: 'user_input' }));

    engine.post({ source: 'user', content: '开始' });
    await flushMicrotasks(40);

    expect(engine.callAICount).toBe(1);                   // 挂起后不再发第二次请求
    expect(engine.isPumping).toBe(false);
    expect(engine.mini.toolResults()).toHaveLength(0);    // 未配对 call 是唯一真相
    expect(getValidPendingAskUser(engine.mini.messages)?.toolUseId).toBe('ask-live');
  });
});

describe('executeTools suspended 分流', () => {
  it('不写 tool_result、返回 suspended、onSuspended 调用而 onAfterExecute 不调', async () => {
    const engine = new AskUserEngine();
    engine.mini.addAssistantMessage([askTu('ask-1')]);
    engine.setCoordinator(async () => ({ suspended: true, reason: 'user_input' }));
    const onAfterExecute = vi.fn();
    const onSuspended = vi.fn();

    const outcome = await engine.execTools([askTu('ask-1')], {
      mode: 'sequential',
      signal: new AbortController().signal,
      onAfterExecute,
      onSuspended,
    });

    expect(outcome.suspended).toBe(true);
    expect(engine.mini.toolResults()).toHaveLength(0);
    expect(onSuspended).toHaveBeenCalledOnce();
    expect(onAfterExecute).not.toHaveBeenCalled();
  });
});

describe('工具批次执行模式实时解析', () => {
  it('confirm→auto 不改变当前批次顺序，下一批在同一 Pump 内恢复并行', async () => {
    const engine = new AskUserEngine();
    engine.approvalMode = 'confirm';
    engine.aiResponses = [
      [normalTu('a', 'tool_a'), normalTu('b', 'tool_b')],
      [normalTu('c', 'tool_c'), normalTu('d', 'tool_d')],
      [{ type: 'text', text: 'done' } as ContentBlock],
    ];

    let releaseParallel!: () => void;
    const parallelGate = new Promise<void>((resolve) => { releaseParallel = resolve; });
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    engine.setCoordinator(async (name, callId) => {
        started.push(name);
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          if (name === 'tool_a') await firstGate;
          if (name === 'tool_c' || name === 'tool_d') await parallelGate;
          return new PendingSettlement(callId, name, { ok: true, text: `${name}-result` });
        } finally {
          active--;
        }
    });

    const running = engine.runConfigured(new AbortController().signal, {
      executeMode: () => engine.approvalMode === 'auto' ? 'parallel' : 'sequential',
    });

    await vi.waitFor(() => expect(started).toEqual(['tool_a']));
    expect(started).toEqual(['tool_a']);
    engine.approvalMode = 'auto';
    releaseFirst();

    await vi.waitFor(() => expect(started).toEqual(['tool_a', 'tool_b', 'tool_c', 'tool_d']));
    expect(maxActive).toBe(2);

    releaseParallel();
    await running;
  });
});

describe('reconcileLatestToolBatch 分类表', () => {
  it('混批部分结果落盘后恢复 → 剩余缺失 call 补 gate 违规失败文本', () => {
    const engine = new AskUserEngine();
    engine.mini.addAssistantMessage([askTu('ask-1'), normalTu('ls-1')]);
    engine.settle('ls-1', 'ls 结果（崩溃前已落盘）', 'ls');

    const r = engine.reconcile('recovery');

    expect(r).toEqual({ pendingAsk: false, wrote: true });
    const results = engine.mini.toolResults();
    expect(results).toHaveLength(2);
    const askResult = results.find(x => x.tool_use_id === 'ask-1');
    expect(askResult?.content).toBe(`<error>${ASK_USER_GATE_VIOLATION_TEXT}</error>`);
  });

  it('单个合法 ask 缺结果 → pendingAsk=true，不写任何结果', () => {
    const engine = new AskUserEngine();
    engine.mini.addAssistantMessage([askTu('ask-1')]);

    expect(engine.reconcile('runtime')).toEqual({ pendingAsk: true, wrote: false });
    expect(engine.mini.toolResults()).toHaveLength(0);
  });

  it('单个非法 ask（questions 空）会写验证失败文本且不挂起', () => {
    const engine = new AskUserEngine();
    engine.mini.addAssistantMessage([askTu('ask-bad', { questions: [] })]);

    const r = engine.reconcile('runtime');

    expect(r.pendingAsk).toBe(false);
    const [result] = engine.mini.toolResults();
    expect(result.tool_use_id).toBe('ask-bad');
    expect(String(result.content)).toContain('questions');
  });

  it('纯普通批次缺结果 → canonical interrupted（origin 决定 reason，execution=unknown）', () => {
    const engine = new AskUserEngine();
    engine.mini.addAssistantMessage([normalTu('a'), normalTu('b')]);
    engine.settle('a', '已有结果', 'ls');

    engine.reconcile('recovery');

    const b = engine.mini.toolResults().find(x => x.tool_use_id === 'b');
    expect(JSON.parse(unwrapError(b!.content))).toMatchObject({
      status: 'interrupted',
      reason: 'recovery_interrupted',
      execution: 'unknown',
    });
  });

  it('重复 call ID 不写结果（unresolvable），仍照常构建 Anthropic 请求', () => {
    const engine = new AskUserEngine();
    engine.mini.addAssistantMessage([normalTu('dup')]);
    engine.mini.addAssistantMessage([normalTu('dup')]);

    expect(engine.reconcile('runtime')).toEqual({ pendingAsk: false, wrote: false });
    expect(engine.mini.toolResults()).toHaveLength(0);
  });

  it('尾部为纯文本或批次完整时无需修复', () => {
    const engine = new AskUserEngine();
    engine.mini.addAssistantMessage([normalTu('old')]);   // 较早缺结果
    engine.mini.addUserMessage('中间消息');
    engine.mini.addAssistantMessage([{ type: 'text', text: '纯文本收尾' } as ContentBlock]);

    expect(engine.reconcile('runtime')).toEqual({ pendingAsk: false, wrote: false });
    expect(engine.mini.toolResults()).toHaveLength(0);    // 不向前修复
  });
});

describe('runTurn gate 打回整链', () => {
  it('ask_user + 普通工具混批：普通工具执行次数为零，每个 call 得 gate 违规文本，本冲程继续重试', async () => {
    const engine = new AskUserEngine();
    engine.aiResponses = [[askTu('ask-mix'), normalTu('ls-mix')]];   // 第二轮默认纯文本 idle
    const execute = vi.fn(async (_name: string, callId: string) => new PendingSettlement(
      callId,
      'unexpected',
      { ok: true, text: 'ok' },
    ));
    engine.setCoordinator(execute);

    engine.post({ source: 'user', content: '开始' });
    await flushMicrotasks(40);

    expect(execute).not.toHaveBeenCalled();   // 打回发生在 executeTools 之前
    const results = engine.mini.toolResults();
    expect(results.map(r => r.tool_use_id).sort()).toEqual(['ask-mix', 'ls-mix']);
    for (const r of results) {
      expect(r.content).toBe(`<error>${ASK_USER_GATE_VIOLATION_TEXT}</error>`);
    }
    expect(engine.callAICount).toBe(2);       // 打回后本冲程继续让 AI 重试，随后自然 idle
  });
});

describe('need_user_action 挂起与恢复', () => {
  const needUserAction = (id: string): ContentBlock => ({
    type: 'tool_use',
    id,
    name: 'send_event',
    input: {
      type: 'need_user_action',
      message: '当前停在登录页，请完成登录。',
    },
  } as ContentBlock);

  it('成功送达后立即 yield；Director 转达用户消息后原 Worker 继续', async () => {
    const engine = new AskUserEngine();
    engine.aiResponses = [
      [needUserAction('need-login')],
      [{
        type: 'tool_use',
        id: 'completed-after-login',
        name: 'send_event',
        input: {
          type: 'completed',
          message: '已验证登录状态，并从原检查点完成探索。',
        },
      } as ContentBlock],
    ];
    engine.setCoordinator(async (name, callId) => new PendingSettlement(
      callId,
      name,
      { ok: true, text: '已通知 director' },
      callId === 'completed-after-login' ? 'completed' : undefined,
    ));

    engine.post({ source: 'user', content: '开始探索' });
    await flushMicrotasks(40);

    expect(engine.callAICount).toBe(1);
    expect(engine.getIdlePermits()).toEqual([
      { kind: 'user_action', callId: 'need-login' },
    ]);

    engine.post({ source: 'agent', content: '用户已完成登录，请先验证后继续。' });
    await flushMicrotasks(40);

    expect(engine.callAICount).toBe(2);
    expect(engine.getIdlePermits()).toEqual([]);
  });

  it('投递失败不产生 user_action permit，并继续请求模型处理错误', async () => {
    const engine = new AskUserEngine();
    engine.aiResponses = [
      [needUserAction('need-login-failed')],
      [{ type: 'text', text: '通知未送达，改为报告失败。' } as ContentBlock],
    ];
    engine.setCoordinator(async (name, callId) => new PendingSettlement(
      callId,
      name,
      { ok: false, text: '事件未送达 director' },
    ));

    engine.post({ source: 'user', content: '开始探索' });
    await flushMicrotasks(40);

    expect(engine.callAICount).toBe(2);
    expect(engine.getIdlePermits()).toEqual([]);
  });
});

describe('关闭应用 = preserve', () => {
  it('destroy：pending ask 保持未配对，不写结果、无游离写入', async () => {
    const engine = new AskUserEngine();
    engine.mini.addAssistantMessage([askTu('ask-1')]);

    await engine.destroy();

    expect(engine.mini.toolResults()).toHaveLength(0);   // 不结算——重启后仍可回答
    expect(getValidPendingAskUser(engine.mini.messages)?.toolUseId).toBe('ask-1');
    expect(engine.callAICount).toBe(0);
  });
});

describe('ESC 结算', () => {
  it('interrupt → 唯一 user_interrupted/not_started 同步结算，最终广播后派生 pending 消失', async () => {
    const engine = new AskUserEngine();
    engine.mini.addAssistantMessage([askTu('ask-1')]);
    const states: AgentControlState[] = [];
    engine.setStateProbe(s => states.push(s));

    await engine.interrupt();

    const results = engine.mini.toolResults();
    expect(results).toHaveLength(1);
    expect(JSON.parse(unwrapError(results[0].content))).toMatchObject({
      status: 'interrupted',
      reason: 'user_interrupted',
      execution: 'not_started',
    });
    expect(engine.mini.flushCount).toBeGreaterThanOrEqual(1);   // ToolEntry 由 Settler 同步落盘，无二次 flush
    expect(getValidPendingAskUser(engine.mini.messages)).toBeUndefined();   // 派生面板消失
    expect(states.length).toBeGreaterThanOrEqual(1);            // 存在最终广播
    expect(engine.callAICount).toBe(0);                         // 结算不启动 AI
  });

  it('结算写盘失败 → warn 降级，interrupt 不 reject，不制造内存假结果', async () => {
    const engine = new AskUserEngine();
    engine.mini.addAssistantMessage([askTu('ask-1')]);
    engine.mini.appendImpl = () => { throw new Error('disk full'); };

    await expect(engine.interrupt()).resolves.toBeUndefined();

    expect(engine.interrupted).toBe(true);
    expect(engine.mini.toolResults()).toHaveLength(0);   // 写前失败，重启与当前内存都仍是 pending
  });

  it('答案先到 → ESC 后到者 already_settled，不覆盖真实答案', async () => {
    const engine = new AskUserEngine();
    engine.mini.addAssistantMessage([askTu('ask-1')]);
    engine.settle('ask-1', '用户的真实答案');

    await engine.interrupt();

    const results = engine.mini.toolResults();
    expect(results).toHaveLength(1);                       // 最终只有一个结果
    expect(results[0].content).toBe('用户的真实答案');     // 后到的 ESC 不覆盖
  });

  it('无 pending：interrupt 不做任何结算（普通中断回归）', async () => {
    const engine = new AskUserEngine();
    engine.mini.addAssistantMessage([{ type: 'text', text: '收尾' } as ContentBlock]);

    await engine.interrupt();

    expect(engine.mini.toolResults()).toHaveLength(0);
  });
});
