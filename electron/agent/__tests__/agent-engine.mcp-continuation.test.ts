/**
 * AgentEngine 的 MCP elicitation 续跑链：
 * - 带续跑的挂起：executeTools 存入 pendingToolContinuation，不写 tool_result
 * - 模型边界守卫：唯一缺失 call 匹配在册续跑 → yield，零 Provider 请求
 * - 答案到达 → resumeToolContinuation 喂回在途请求 → tool_result / 下一轮挂起
 * - 中断：cancel + 结算 interrupted/unknown；恢复：续跑内存已失 → 落 interrupted 分类
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentControlState,
  ConversationEntry,
} from '../../../shared/types/agent-control.js';
import type {
  AIResponse,
  ContentBlock,
  Message,
} from '../../../shared/types/index.js';
import type { ToolOutput, ToolSuspension, ToolSuspensionContinuation } from '../../tools/types.js';
import type { ToolExecutionInterval } from '../../tools/pipeline/observe.js';
import { AgentEngine, type TurnOutcome } from '../agent-engine.js';
import { resolveToolUseSettlement } from '../context/conversation-protocol.js';
import { Settler } from '../conversation/settler.js';
import { PendingSettlement } from '../tool-call/pending-settlement.js';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test' },
}));

async function flushMicrotasks(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

const mcpTu = (id: string): ContentBlock =>
  ({ type: 'tool_use', id, name: 'mcp__srv__ask-me', input: {} } as ContentBlock);

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

class MiniContext {
  messages: Message[] = [];

  getAllMessages(): Message[] { return this.messages; }
  appendToolResult(id: string, result: unknown[]): void {
    const content = result.length === 1
      && typeof result[0] === 'object'
      && result[0] !== null
      && (result[0] as { type?: string }).type === 'text'
      ? (result[0] as { text?: string }).text ?? ''
      : result;
    this.messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content } as unknown as ContentBlock],
    });
  }
  addAssistantMessage(content: ContentBlock[] | string): void {
    this.messages.push({ role: 'assistant', content: content as Message['content'] });
  }
  addUserMessage(text: string): void {
    this.messages.push({ role: 'user', content: text });
  }
  async getMessagesForAI(): Promise<{ messages: Message[] }> { return { messages: this.messages }; }
  flush(): void {}
  setModel(): void {}
  toolResults(): Array<{ tool_use_id: string; content: unknown }> {
    return this.messages.flatMap(m => (Array.isArray(m.content) ? m.content : []))
      .filter(b => (b as ContentBlock).type === 'tool_result') as never;
  }
}

class McpEngine extends AgentEngine {
  readonly mini = new MiniContext();
  callAICount = 0;
  aiResponses: ContentBlock[][] = [];

  constructor() {
    super();
    this.id = 'mcp-continuation-test';
    this.mainAgentId = this.id;
    this.context = this.mini as never;
    this.settler = new Settler({
      resolve: (callId) => resolveToolUseSettlement(this.mini.messages, callId),
      appendLiveToolResult: (callId, blocks) => {
        this.mini.appendToolResult(callId, blocks);
      },
      appendRecoveryToolResult: (callId, blocks) => this.mini.appendToolResult(callId, blocks),
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

  setCoordinator(
    run: (name: string, callId: string) => Promise<PendingSettlement | ToolSuspension>,
  ): void {
    this.toolCoordinator = {
      run: vi.fn((raw: { modelName: string; callId: string }) => run(raw.modelName, raw.callId)),
    } as never;
  }

  get pending() { return this.pendingToolContinuation; }
  get activity() { return this.getActivityState(); }
  answerContinuation(answers: string[]): void {
    this.pendingToolContinuation!.answers = answers;
  }
  installContinuation(continuation: ToolSuspensionContinuation, answers: string[]): void {
    this.pendingToolContinuation = {
      toolUseId: 'mcp-direct',
      toolName: 'mcp__srv__ask-me',
      continuation,
      answers,
    };
  }
  recordInterval(callId: string, interval: ToolExecutionInterval): void {
    this.recordToolExecutionStarted(callId, interval.startedAt);
    this.recordToolExecutionFinished(callId, interval);
  }
  async resumeContinuationDirect(controller?: AbortController): Promise<void> {
    this.pumpController = controller;
    try {
      await this.resumeToolContinuation();
    } finally {
      this.pumpController = undefined;
    }
  }
  reconcile(origin: 'runtime' | 'recovery') { return this.reconcileLatestToolBatch(origin); }
  settleOnInterrupt(): boolean { return this.settlePendingAsksOnInterrupt(); }
  async execTools(toolUses: ContentBlock[], opts: Parameters<AgentEngine['executeTools']>[2]): Promise<TurnOutcome> {
    return this.executeTools(toolUses, {} as never, opts, new Set());
  }
}

function suspensionWith(continuation: ToolSuspensionContinuation): ToolSuspension {
  return { suspended: true, reason: 'user_input', continuation };
}

const QUESTIONS = [{ question: '需要 API key' }];

describe('带续跑的挂起（executeTools）', () => {
  it('存入 pendingToolContinuation、suspended=true、不写 tool_result', async () => {
    const engine = new McpEngine();
    engine.mini.addAssistantMessage([mcpTu('mcp-1')]);
    const continuation: ToolSuspensionContinuation = {
      questions: QUESTIONS,
      resume: vi.fn(),
      cancel: vi.fn(),
    };
    engine.setCoordinator(async () => suspensionWith(continuation));

    const outcome = await engine.execTools([mcpTu('mcp-1')], {
      mode: 'sequential',
      signal: new AbortController().signal,
    });

    expect(outcome.suspended).toBe(true);
    expect(engine.mini.toolResults()).toHaveLength(0);
    expect(engine.pending).toMatchObject({ toolUseId: 'mcp-1', toolName: 'mcp__srv__ask-me' });
    expect(engine.pending!.continuation).toBe(continuation);
  });
});

describe('模型边界守卫 × 在册续跑', () => {
  it('唯一缺失 call 匹配续跑 → yield 零请求；答案到达 → 续跑结算 → 恰好一次请求', async () => {
    const engine = new McpEngine();
    engine.aiResponses = [[mcpTu('mcp-1')]];
    const resume = vi.fn(async (): Promise<ToolOutput<unknown>> => ({ ok: true, text: 'resumed-ok' }));
    engine.setCoordinator(async () => suspensionWith({ questions: QUESTIONS, resume, cancel: vi.fn() }));

    engine.post({ source: 'user', content: '开始' });
    await flushMicrotasks();

    expect(engine.callAICount).toBe(1);
    expect(engine.isPumping).toBe(false);
    expect(engine.mini.toolResults()).toHaveLength(0);

    engine.answerContinuation(['sk-123']);
    engine.post({ source: 'user', content: '触发唤醒' });
    await flushMicrotasks();

    expect(resume).toHaveBeenCalledWith(['sk-123']);
    const results = engine.mini.toolResults();
    expect(results).toHaveLength(1);
    expect(results[0].tool_use_id).toBe('mcp-1');
    expect(String(results[0].content)).toContain('resumed-ok');
    expect(engine.callAICount).toBe(2);
    expect(engine.pending).toBeUndefined();
  });

  it('多轮追问：resume 返回下一轮挂起 → 滚动续跑、不写结果、不发请求', async () => {
    const engine = new McpEngine();
    engine.aiResponses = [[mcpTu('mcp-1')]];
    const secondRound: ToolSuspensionContinuation = {
      questions: [{ question: '再要一个 OTP' }],
      resume: vi.fn(),
      cancel: vi.fn(),
    };
    const resume = vi.fn(async (): Promise<ToolSuspension> => suspensionWith(secondRound));
    engine.setCoordinator(async () => suspensionWith({ questions: QUESTIONS, resume, cancel: vi.fn() }));

    engine.post({ source: 'user', content: '开始' });
    await flushMicrotasks();
    engine.answerContinuation(['答一']);
    engine.post({ source: 'user', content: '唤醒' });
    await flushMicrotasks();

    expect(engine.mini.toolResults()).toHaveLength(0);
    expect(engine.callAICount).toBe(1);
    expect(engine.pending?.continuation).toBe(secondRound);
    expect(engine.pending?.answers).toBeUndefined();
  });

  it('resume 抛错 → 结算失败 tool_result，冲程继续', async () => {
    const engine = new McpEngine();
    engine.aiResponses = [[mcpTu('mcp-1')]];
    const resume = vi.fn(async () => {
      throw new Error(
        'connection reset token=continuation-secret https://api.test/callback?code=query-secret',
      );
    });
    engine.setCoordinator(async () => suspensionWith({ questions: QUESTIONS, resume, cancel: vi.fn() }));

    engine.post({ source: 'user', content: '开始' });
    await flushMicrotasks();
    engine.answerContinuation(['x']);
    engine.post({ source: 'user', content: '唤醒' });
    await flushMicrotasks();

    const results = engine.mini.toolResults();
    expect(results).toHaveLength(1);
    expect(String(results[0].content)).toContain('MCP 工具续跑失败');
    expect(String(results[0].content)).toContain('connection reset');
    expect(String(results[0].content)).not.toContain('continuation-secret');
    expect(String(results[0].content)).not.toContain('query-secret');
    expect(engine.callAICount).toBe(2);
  });

  it('tracks execute and resume intervals in runtime without counting the user wait', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    try {
      const engine = new McpEngine();
      engine.mini.addAssistantMessage([mcpTu('mcp-direct')]);
      engine.recordInterval('mcp-direct', { startedAt: 0, finishedAt: 2_000 });
      engine.installContinuation({
        questions: QUESTIONS,
        resume: vi.fn(async () => {
          vi.setSystemTime(35_000);
          return { ok: true, text: 'resumed' };
        }),
        cancel: vi.fn(),
      }, ['answer']);

      vi.setSystemTime(32_000);
      await engine.resumeContinuationDirect();

      expect(engine.activity.runMetrics).toMatchObject({
        steps: 1,
        toolDurationMs: 5_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('resume 遇到当前冲程 Abort 时保持控制流，不结算为模型错误', async () => {
    const engine = new McpEngine();
    const controller = new AbortController();
    const reason = new Error('user interrupted');
    controller.abort(reason);
    engine.installContinuation({
      questions: QUESTIONS,
      resume: vi.fn(async () => { throw reason; }),
      cancel: vi.fn(),
    }, ['x']);

    await expect(engine.resumeContinuationDirect(controller)).rejects.toBe(reason);
    expect(engine.mini.toolResults()).toHaveLength(0);
  });

  it('再挂起但无续跑通道 → 写失败结果防悬挂', async () => {
    const engine = new McpEngine();
    engine.aiResponses = [[mcpTu('mcp-1')]];
    const resume = vi.fn(async (): Promise<ToolSuspension> => ({ suspended: true, reason: 'user_input' }));
    engine.setCoordinator(async () => suspensionWith({ questions: QUESTIONS, resume, cancel: vi.fn() }));

    engine.post({ source: 'user', content: '开始' });
    await flushMicrotasks();
    engine.answerContinuation(['x']);
    engine.post({ source: 'user', content: '唤醒' });
    await flushMicrotasks();

    const results = engine.mini.toolResults();
    expect(results).toHaveLength(1);
    expect(String(results[0].content)).toContain('未携带续跑通道');
  });
});

describe('中断与恢复', () => {
  it('中断结算：cancel 尽力通知 + interrupted/unknown + 续跑清除', () => {
    const engine = new McpEngine();
    engine.mini.addAssistantMessage([mcpTu('mcp-1')]);
    const cancel = vi.fn();
    (engine as unknown as { pendingToolContinuation: unknown }).pendingToolContinuation = {
      toolUseId: 'mcp-1',
      toolName: 'mcp__srv__ask-me',
      continuation: { questions: QUESTIONS, resume: vi.fn(), cancel },
    };

    const changed = engine.settleOnInterrupt();

    expect(changed).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(engine.pending).toBeUndefined();
    const results = engine.mini.toolResults();
    expect(results).toHaveLength(1);
    const text = String(results[0].content);
    expect(text).toContain('user_interrupted');
    expect(text).toContain('unknown');
  });

  it('cancel 抛错不阻塞中断结算', () => {
    const engine = new McpEngine();
    engine.mini.addAssistantMessage([mcpTu('mcp-1')]);
    (engine as unknown as { pendingToolContinuation: unknown }).pendingToolContinuation = {
      toolUseId: 'mcp-1',
      toolName: 'mcp__srv__ask-me',
      continuation: { questions: QUESTIONS, resume: vi.fn(), cancel: () => { throw new Error('gone'); } },
    };

    expect(engine.settleOnInterrupt()).toBe(true);
    expect(engine.mini.toolResults()).toHaveLength(1);
  });

  it('恢复：续跑内存已失 → 缺失 call 落 recovery_interrupted / unknown 分类', () => {
    const engine = new McpEngine();
    engine.mini.addAssistantMessage([mcpTu('mcp-1')]);

    const r = engine.reconcile('recovery');

    expect(r).toEqual({ pendingAsk: false, wrote: true });
    const results = engine.mini.toolResults();
    expect(results).toHaveLength(1);
    const text = String(results[0].content);
    expect(text).toContain('recovery_interrupted');
    expect(text).toContain('unknown');
  });
});
