/**
 * engine 结算写入点的中断统一分类。
 * - signal 已 abort 且 outcome 失败 → canonical interrupted（execution: unknown），不是普通工具失败；
 * - success: true 的真实结果保留（含 abort 后迟到成功）；
 * - abort 后未启动的工具写 not_started（sequential 现状）；
 * - 未 abort 时普通失败保持原样（分类判据是 aborted && !success，不是失败本身）；
 * - generate_image 不纳入 yield gate。
 */
import { describe, it, expect, vi } from 'vitest';
import type {
  AgentControlState,
  ConversationEntry,
} from '../../../shared/types/agent-control.js';
import type { AgentInputEvent, ContentBlock } from '../../../shared/types/index.js';
import type { ToolExecutionInterval } from '../../tools/pipeline/observe.js';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test' },
}));


import { AgentEngine, type TurnOutcome, type ExecuteToolsOptions } from '../agent-engine.js';
import { PendingSettlement } from '../tool-call/pending-settlement.js';

class SettleEngine extends AgentEngine {
  settleCalls: Array<{ id: string; result: string }> = [];
  turnImpl?: (signal: AbortSignal) => Promise<TurnOutcome>;

  constructor() {
    super();
    this.id = 'agent-settle';
    this.mainAgentId = this.id;
    this.context = { flush: vi.fn(), getAllMessages: () => [] } as never;
    this.settler = {
      settleLive: vi.fn((settlement: { callId: string; result?: { text: string }; text?: string }) => {
        this.settleCalls.push({
          id: settlement.callId,
          result: settlement.result?.text ?? settlement.text ?? '',
        });
        return 'inserted';
      }),
    } as never;
  }

  buildSystemPrompt(): string { return ''; }
  getControlState(): AgentControlState { return {} as AgentControlState; }
  protected applyEvents(_events: AgentInputEvent[]): void {}
  protected appendConversationEntry(_entry: ConversationEntry): void {}
  protected override async runTurn(signal: AbortSignal): Promise<TurnOutcome> {
    if (this.turnImpl) return this.turnImpl(signal);
    return {};
  }

  setCoordinator(execute: (name: string) => Promise<{ result: string; success: boolean }>): void {
    this.toolCoordinator = {
      run: vi.fn(async (raw: { modelName: string; callId: string }) => {
        const outcome = await execute(raw.modelName);
        return new PendingSettlement(
          raw.callId,
          raw.modelName,
          { ok: outcome.success, text: outcome.result },
        );
      }),
    } as never;
  }

  runExecuteTools(toolUses: ContentBlock[], options: ExecuteToolsOptions): Promise<TurnOutcome> {
    return this.executeTools(toolUses, {} as never, options, new Set());
  }

  runCheckYieldGate(toolUses: ContentBlock[]): string | null {
    return this.checkExclusiveToolGate(toolUses);
  }

  recordInterval(callId: string, interval: ToolExecutionInterval): void {
    this.recordToolExecutionStarted(callId, interval.startedAt);
    this.recordToolExecutionFinished(callId, interval);
  }

  settle(callId: string): void { this.recordToolSettled(callId); }
  get activity() { return this.getActivityState(); }
}

const toolUse = (id: string, name: string): ContentBlock =>
  ({ type: 'tool_use', id, name, input: {} }) as unknown as ContentBlock;

const parseSettle = (result: string): Record<string, unknown> => JSON.parse(result);

describe('executeTools 结算写入点的中断统一分类', () => {
  it('parallel：abort 后 success:false 写 canonical interrupted（unknown），success:true 真值保留（含迟到成功）', async () => {
    const engine = new SettleEngine();
    engine.approvalMode = 'auto';
    const controller = new AbortController();
    engine.setCoordinator(async (name) => {
      if (name === 'tool_late_success') {
        // abort 发生在执行期间，随后仍成功——迟到成功写真值，不压制
        controller.abort(new Error('user stop'));
        return { result: 'late-success-value', success: true };
      }
      return { result: '普通失败文案', success: false };
    });

    await engine.runExecuteTools(
      [toolUse('t1', 'tool_late_success'), toolUse('t2', 'tool_failed')],
      { mode: 'parallel', signal: controller.signal },
    );

    const late = engine.settleCalls.find(c => c.id === 't1')!;
    expect(late.result).toBe('late-success-value');

    const interrupted = parseSettle(engine.settleCalls.find(c => c.id === 't2')!.result);
    expect(interrupted.status).toBe('interrupted');
    expect(interrupted.reason).toBe('user_interrupted');
    expect(interrupted.execution).toBe('unknown');
  });

  it('sequential：执行中 abort 的失败写 interrupted（unknown），abort 后未启动的写 not_started', async () => {
    const engine = new SettleEngine();
    const controller = new AbortController();
    engine.setCoordinator(async () => {
      controller.abort(new Error('user stop'));
      return { result: '执行中被中断', success: false };
    });

    await engine.runExecuteTools(
      [toolUse('s1', 'tool_a'), toolUse('s2', 'tool_b')],
      { mode: 'sequential', signal: controller.signal },
    );

    const first = parseSettle(engine.settleCalls.find(c => c.id === 's1')!.result);
    expect(first.status).toBe('interrupted');
    expect(first.execution).toBe('unknown');

    // s2 在 abort 后未启动——直接证据，写 not_started
    const second = parseSettle(engine.settleCalls.find(c => c.id === 's2')!.result);
    expect(second.status).toBe('interrupted');
    expect(second.execution).toBe('not_started');
  });

  it('未 abort 时普通失败保持原样：分类判据是 aborted && !success，不吞业务失败', async () => {
    const engine = new SettleEngine();
    engine.approvalMode = 'auto';
    const controller = new AbortController();
    engine.setCoordinator(async () => ({ result: '业务失败原文', success: false }));

    await engine.runExecuteTools(
      [toolUse('p1', 'tool_a'), toolUse('p2', 'tool_b')],
      { mode: 'parallel', signal: controller.signal },
    );

    expect(engine.settleCalls.map(c => c.result)).toEqual(['业务失败原文', '业务失败原文']);
  });
});

describe('confirm 模式批次调度', () => {
  it('实时模式为 confirm 时，即使上层传入 parallel 也逐个启动', async () => {
    const engine = new SettleEngine();
    engine.approvalMode = 'confirm';
    const started: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    engine.setCoordinator(async (name) => {
      started.push(name);
      if (name === 'tool_first') await firstGate;
      return { result: `${name}-result`, success: true };
    });

    const execution = engine.runExecuteTools(
      [toolUse('c1', 'tool_first'), toolUse('c2', 'tool_last')],
      { mode: 'parallel', signal: new AbortController().signal },
    );

    await Promise.resolve();
    expect(started).toEqual(['tool_first']);

    releaseFirst();
    await execution;
    expect(started).toEqual(['tool_first', 'tool_last']);
  });
});

describe('generate_image 不纳入 yield gate', () => {
  it('generate_image 与普通工具混批不触发守门', () => {
    const engine = new SettleEngine();

    expect(engine.runCheckYieldGate([
      toolUse('g1', 'generate_image'),
      toolUse('g2', 'read'),
    ])).toBeNull();
  });
});

describe('工具执行运行态统计', () => {
  it('keeps execution duration and settlement count in the runtime tracker', () => {
    const engine = new SettleEngine();
    engine.recordInterval('cancelled-call', { startedAt: 10, finishedAt: 20 });
    engine.recordInterval('cancelled-call', { startedAt: 50, finishedAt: 55 });
    engine.settle('cancelled-call');
    engine.settle('cancelled-call');

    expect(engine.activity.runMetrics).toMatchObject({
      steps: 1,
      toolDurationMs: 15,
    });
  });
});
