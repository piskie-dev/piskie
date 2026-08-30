/**
 * AgentEngine Pump 调度核心测试
 * 覆盖：INERT post 启动单冲程、同步重入/并发不双 Pump（微任务门闩）、finally 无条件复检、
 * 三出口分类（取消真相源 = 本冲程 controller）、出口 handler 抛异常吞并、disposed 拒收、
 * 两段式幂等 destroy（Deferred 重入门闩、errors 为空才释放资源、AggregateError）、
 * onDestroyBegin 凭据收集、
 * interrupt 丢弃 + settle、
 * applyEvents 失败携带批次 ids。
 */

import { describe, expect, it, vi } from 'vitest';
import type { AgentControlState, ConversationEntry } from '../../../shared/types/agent-control.js';
import type {
  AgentInputEvent,
  AgentInputRequest,
  PendingToolCall,
} from '../../../shared/types/index.js';
import { AgentEngine, type TurnOutcome } from '../agent-engine.js';
import { DisposedError, EventBatchApplyError, UserInterruptError } from '../agent-mailbox.js';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test' },
}));

/** 等待微任务队列排空（pump 经 Promise.resolve().then 启动，需要让出一轮） */
async function flushMicrotasks(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/**
 * Pump 骨架测试引擎：runTurn 由测试注入（turnImpl），
 * applyEvents 记录批次，runPump 走 engine 真实现（takeEvents → applyEventBatch → runTurn → 收尾）。
 */
class PumpTestEngine extends AgentEngine {
  turnRuns = 0;
  activeTurns = 0;
  maxConcurrentTurns = 0;
  appliedBatches: AgentInputEvent[][] = [];
  cancelledReasons: unknown[] = [];
  failedErrors: unknown[] = [];
  /** 每次 runTurn 的自定义实现；未设置时默认自然 idle（return {}） */
  turnImpl?: (signal: AbortSignal) => Promise<TurnOutcome>;
  /** 出口 handler 抛异常测试开关 */
  throwInExitHandler = false;
  /** applyEvents 抛错开关（测 EventBatchApplyError） */
  applyThrows?: Error;
  /** interrupt 失败隔离测试探针 */
  readonly flushContext = vi.fn();
  childEngines: AgentEngine[] = [];
  interruptionResumeEvents: AgentInputRequest[] = [];
  throwInAfterInterrupt = false;
  afterInterruptCalls = 0;

  constructor() {
    super();
    this.id = 'pump-test';
    this.mainAgentId = this.id;
    this.context = {
      flush: this.flushContext,
      setModel: vi.fn(),
      addUserMessage: vi.fn(),
      getAllMessages: () => [],
    } as never;
  }

  protected override async runTurn(signal: AbortSignal): Promise<TurnOutcome> {
    this.turnRuns++;
    this.activeTurns++;
    this.maxConcurrentTurns = Math.max(this.maxConcurrentTurns, this.activeTurns);
    try {
      if (this.turnImpl) return await this.turnImpl(signal);
      return {};
    } finally {
      this.activeTurns--;
    }
  }

  protected override applyEvents(events: AgentInputEvent[]): void {
    if (this.applyThrows) throw this.applyThrows;
    this.appliedBatches.push(events);
  }

  protected override handlePumpCancelled(reason: unknown): void {
    this.cancelledReasons.push(reason);
    if (this.throwInExitHandler) throw new Error('exit handler boom');
  }

  protected override handlePumpFailure(error: unknown): void {
    this.failedErrors.push(error);
    if (this.throwInExitHandler) throw new Error('exit handler boom');
  }

  override listChildAgents(): AgentEngine[] {
    return this.childEngines;
  }

  protected override buildInterruptionResumeEvents(): AgentInputRequest[] {
    return this.interruptionResumeEvents;
  }

  protected override onAfterInterrupt(): void {
    this.afterInterruptCalls++;
    if (this.throwInAfterInterrupt) throw new Error('after interrupt boom');
    super.onAfterInterrupt();
  }

  buildSystemPrompt(): string { return ''; }
  getControlState(): AgentControlState {
    return {
      agentId: this.id,
      phase: this.phase,
      interrupted: this.interrupted,
      ...this.getActivityState(),
    } as AgentControlState;
  }
  protected override appendConversationEntry(_entry: ConversationEntry): void {}

  // === 测试探针（暴露 protected 状态） ===
  get mailboxSize(): number { return this.mailbox.size; }
  get abortSignal(): AbortSignal | undefined { return this.pumpController?.signal; }
  get pendingApprovalCount(): number { return this.pendingApprovals.size; }
  setStateProbe(cb: (state: AgentControlState) => void): void { this.stateChangeCallback = cb; }
  setActivityStartedAt(startedAt: number): void {
    this.activityTracker.aiStarted(startedAt);
    this.recordToolExecutionStarted('activity-probe', startedAt);
  }
  startToolMetric(callId: string, startedAt: number): void {
    this.recordToolExecutionStarted(callId, startedAt);
  }
  finishToolMetric(callId: string, interval: { startedAt: number; finishedAt: number }): void {
    this.recordToolExecutionFinished(callId, interval);
  }
  settleToolMetric(callId: string): void { this.recordToolSettled(callId); }
  get metrics() { return this.getActivityState().runMetrics; }
  fireSystemEvent(): void { this.postSystemEvent('start'); }
  absorbAtAIBoundary(): void { this.applyEventBatch(this.takeEvents()); }
}

function post(engine: PumpTestEngine, id: string): boolean {
  return engine.post({ id, source: 'user', content: `msg-${id}` });
}

describe('Pump 调度（post/ensurePump/微任务门闩）', () => {
  it('INERT 时 post 启动一次冲程：吸收→应用→runTurn', async () => {
    const engine = new PumpTestEngine();
    expect(engine.isPumping).toBe(false);

    expect(post(engine, 'e1')).toBe(true);
    await flushMicrotasks();

    expect(engine.turnRuns).toBe(1);
    expect(engine.appliedBatches[0].map(e => e.id)).toEqual(['e1']);
    expect(engine.isPumping).toBe(false);
    expect(engine.mailboxSize).toBe(0);
  });

  it('同一同步块内连续 post 只启动一次冲程，事件成批应用且保持顺序', async () => {
    const engine = new PumpTestEngine();
    post(engine, 'e1');
    post(engine, 'e2');
    post(engine, 'e3');
    await flushMicrotasks();

    expect(engine.turnRuns).toBe(1);
    expect(engine.maxConcurrentTurns).toBe(1);
    expect(engine.appliedBatches[0].map(e => e.id)).toEqual(['e1', 'e2', 'e3']);
  });

  it('冲程执行中重入 post 不并发第二个 Pump（门闩先行）', async () => {
    const engine = new PumpTestEngine();
    let reentered = false;
    engine.turnImpl = async () => {
      if (!reentered) {
        reentered = true;
        post(engine, 'reentrant');   // 门闩已装：不得启动并发冲程
      }
      return {};
    };

    post(engine, 'e1');
    await flushMicrotasks();

    expect(engine.maxConcurrentTurns).toBe(1);
    // reentrant 事件留在队列 → finally 复检启动第二个（串行的）冲程
    expect(engine.turnRuns).toBe(2);
    expect(engine.mailboxSize).toBe(0);
  });

  it('finally 无条件复检：冲程运行期间到达的事件驱动下一次冲程', async () => {
    const engine = new PumpTestEngine();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let firstRun = true;
    engine.turnImpl = async () => {
      if (firstRun) {
        firstRun = false;
        await gate;   // 挂起，模拟长 turn
      }
      return {};
    };

    post(engine, 'e1');
    await flushMicrotasks();
    expect(engine.turnRuns).toBe(1);
    expect(engine.isPumping).toBe(true);

    post(engine, 'late');
    expect(engine.mailboxSize).toBe(1);

    release();
    await flushMicrotasks();

    expect(engine.turnRuns).toBe(2);
    expect(engine.maxConcurrentTurns).toBe(1);
    expect(engine.mailboxSize).toBe(0);
  });

  it('ensurePump 空批安全：守卫检查与微任务启动之间队列被清空时冲程直接返回', async () => {
    const engine = new PumpTestEngine();
    post(engine, 'e1');
    // interrupt 在冲程体（微任务）执行前丢弃队列
    await engine.interrupt();
    await flushMicrotasks();

    expect(engine.turnRuns).toBe(0);   // 空批：不 applyEvents 不 runTurn
    expect(engine.appliedBatches).toHaveLength(0);
  });
});

describe('事件应用失败', () => {
  it('applyEvents 抛异常：冲程走 failed 出口，异常为 EventBatchApplyError 且携带本批 ids', async () => {
    const engine = new PumpTestEngine();
    engine.applyThrows = new Error('context disk failure');

    post(engine, 'e1');
    post(engine, 'e2');
    await flushMicrotasks();

    expect(engine.failedErrors).toHaveLength(1);
    const err = engine.failedErrors[0] as EventBatchApplyError;
    expect(err).toBeInstanceOf(EventBatchApplyError);
    expect(err.eventIds).toEqual(['e1', 'e2']);
    expect(engine.cancelledReasons).toHaveLength(0);
    expect(engine.isPumping).toBe(false);

    // 失败退场后，新事件仍能启动新冲程。
    engine.applyThrows = undefined;
    post(engine, 'recover');
    await flushMicrotasks();
    expect(engine.turnRuns).toBe(1);
  });
});

describe('三出口分类（取消真相源 = 本冲程 controller）', () => {
  it('正常 return：既不 cancelled 也不 failed', async () => {
    const engine = new PumpTestEngine();
    post(engine, 'e1');
    await flushMicrotasks();

    expect(engine.cancelledReasons).toHaveLength(0);
    expect(engine.failedErrors).toHaveLength(0);
  });

  it('冲程体抛错且未 abort：分类为 failed，门闩必清', async () => {
    const engine = new PumpTestEngine();
    const boom = new Error('infra boom');
    engine.turnImpl = async () => { throw boom; };

    post(engine, 'e1');
    await flushMicrotasks();

    expect(engine.failedErrors).toEqual([boom]);
    expect(engine.cancelledReasons).toHaveLength(0);
    expect(engine.isPumping).toBe(false);
  });

  it('abort 后冲程抛出任意形状异常：一律分类为 cancelled（禁形状推断）', async () => {
    const engine = new PumpTestEngine();
    engine.turnImpl = (signal) => new Promise<TurnOutcome>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('provider stream torn down')));
    });

    post(engine, 'e1');
    await flushMicrotasks();
    expect(engine.isPumping).toBe(true);

    await engine.interrupt();

    expect(engine.cancelledReasons).toHaveLength(1);
    expect(engine.cancelledReasons[0]).toBeInstanceOf(UserInterruptError);
    expect(engine.failedErrors).toHaveLength(0);
  });

  it('出口 handler 抛异常被吞并：门闩仍清、后续调度不受影响', async () => {
    const engine = new PumpTestEngine();
    engine.throwInExitHandler = true;
    engine.turnImpl = async () => { throw new Error('first run fails'); };

    post(engine, 'e1');
    await flushMicrotasks();
    expect(engine.failedErrors).toHaveLength(1);
    expect(engine.isPumping).toBe(false);

    engine.throwInExitHandler = false;
    engine.turnImpl = undefined;
    post(engine, 'e2');
    await flushMicrotasks();
    expect(engine.turnRuns).toBe(2);
  });
});

describe('destroy（两段式且幂等）', () => {
  it('disposed 后 post 拒收返回 false，事件不入队', async () => {
    const engine = new PumpTestEngine();
    await engine.destroy();

    expect(post(engine, 'after-destroy')).toBe(false);
    expect(engine.mailboxSize).toBe(0);
    expect(engine.isPumping).toBe(false);
  });

  it('并发 destroy 返回同一 Promise（幂等门闩）', async () => {
    const engine = new PumpTestEngine();
    const p1 = engine.destroy();
    const p2 = engine.destroy();
    expect(p1).toBe(p2);
    await p1;
  });

  it('abort listener 同步重入 destroy 命中门闩：finishDestroy 只执行一次', async () => {
    const engine = new PumpTestEngine();
    const releaseCalls: number[] = [];
    let reentrantPromise: Promise<void> | undefined;
    Object.defineProperty(engine, 'releaseResources', {
      value: async () => { releaseCalls.push(1); },
    });
    engine.turnImpl = (signal) => new Promise<TurnOutcome>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        reentrantPromise = engine.destroy();   // abort 同步执行 listeners，此处重入
        reject(signal.reason);
      });
    });

    post(engine, 'e1');
    await flushMicrotasks();

    const outer = engine.destroy();
    await outer;

    expect(reentrantPromise).toBe(outer);
    expect(releaseCalls).toHaveLength(1);
    expect(engine.cancelledReasons[0]).toBeInstanceOf(DisposedError);
  });

  it('destroy 丢弃 Mailbox 存量，资源释放发生在旧冲程 settle 之后', async () => {
    const engine = new PumpTestEngine();
    const order: string[] = [];
    Object.defineProperty(engine, 'releaseResources', {
      value: async () => { order.push('release'); },
    });
    let releasePump!: () => void;
    engine.turnImpl = () => new Promise<TurnOutcome>((resolve) => {
      releasePump = () => { order.push('pump-settled'); resolve({}); };
      // 不监听 abort：模拟不可取消的在途工作，destroy 必须等它自然退场
    });

    post(engine, 'e1');
    await flushMicrotasks();
    post(engine, 'queued-while-running');
    expect(engine.mailboxSize).toBe(1);

    const destroyPromise = engine.destroy();
    expect(engine.mailboxSize).toBe(0);   // 同步关门即丢弃留痕

    await flushMicrotasks();
    expect(order).not.toContain('release');   // 冲程未 settle，不得先释放

    releasePump();
    await destroyPromise;
    expect(order).toEqual(['pump-settled', 'release']);
  });

  it('模块清理失败 → 错误聚合为 AggregateError 且资源不释放（边界终止无凭据 → 租约保留）', async () => {
    const engine = new PumpTestEngine();
    let released = false;
    Object.defineProperty(engine, 'collectDestroyTasks', {
      value: () => [Promise.reject(new Error('module A boom')), Promise.resolve('ok')],
    });
    Object.defineProperty(engine, 'releaseResources', {
      value: async () => { released = true; },
    });

    await expect(engine.destroy()).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(AggregateError);
      const agg = err as AggregateError;
      expect(agg.errors).toHaveLength(1);
      expect((agg.errors[0] as Error).message).toBe('module A boom');
      return true;
    });
    expect(released).toBe(false);
  });

  it('清理全部成功 → 资源释放恰好一次（errors 为空是释放的唯一前提）', async () => {
    const engine = new PumpTestEngine();
    let releases = 0;
    Object.defineProperty(engine, 'collectDestroyTasks', {
      value: () => [Promise.resolve('ok')],
    });
    Object.defineProperty(engine, 'releaseResources', {
      value: async () => { releases++; },
    });

    await engine.destroy();
    expect(releases).toBe(1);
  });

  it('onDestroyBegin 边界终止失败 → 进 AggregateError 且资源不释放；成功凭据不误报', async () => {
    const engine = new PumpTestEngine();
    let released = false;
    Object.defineProperty(engine, 'collectDestroyBeginTasks', {
      value: () => [Promise.reject(new Error('close failed')), Promise.resolve()],
    });
    Object.defineProperty(engine, 'releaseResources', {
      value: async () => { released = true; },
    });

    await expect(engine.destroy()).rejects.toSatisfy((err: unknown) => {
      const agg = err as AggregateError;
      expect(agg.errors).toHaveLength(1);
      expect((agg.errors[0] as Error).message).toBe('close failed');
      return true;
    });
    expect(released).toBe(false);
  });

  it('disposed 后 emitStateChange 不发布任何状态（世代唯一性）', async () => {
    const engine = new PumpTestEngine();
    const published: AgentControlState[] = [];
    engine.setStateProbe((s) => published.push(s));

    engine.emitStateChange();
    expect(published).toHaveLength(1);

    await engine.destroy();
    engine.emitStateChange();   // 旧世代迟到回调在源头哑掉，不到达消费点
    expect(published).toHaveLength(1);
  });
});

describe('interrupt（非粘性中断）', () => {
  it('丢弃旧队列并等待旧冲程 settle；新事件可正常唤醒', async () => {
    const engine = new PumpTestEngine();
    let pumpSettled = false;
    engine.turnImpl = (signal) => new Promise<TurnOutcome>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        setTimeout(() => { pumpSettled = true; reject(signal.reason); }, 0);
      });
    });

    post(engine, 'e1');
    await flushMicrotasks();
    post(engine, 'stale');
    expect(engine.mailboxSize).toBe(1);

    await engine.interrupt();

    expect(pumpSettled).toBe(true);        // await 返回 = 旧冲程已 settle
    expect(engine.interrupted).toBe(true);
    expect(engine.mailboxSize).toBe(0);    // 旧输入随 activation 作废
    expect(engine.isPumping).toBe(false);

    engine.turnImpl = undefined;
    expect(post(engine, 'fresh')).toBe(true);
    expect(engine.interrupted).toBe(false); // 真实事实入 Mailbox 即同步恢复
    await flushMicrotasks();
    expect(engine.appliedBatches.at(-1)?.map(e => e.id)).toEqual(['fresh']);
  });

  it('INERT 时 interrupt 不留下永久 stopping 状态', async () => {
    const engine = new PumpTestEngine();
    await engine.interrupt();
    expect(engine.interrupted).toBe(true);
    expect(engine.phase).not.toBe('stopping');
    expect(engine.isPumping).toBe(false);
  });

  it('进入 stopping 时立即隐藏活动行并停止临时 LLM/工具计时', async () => {
    const engine = new PumpTestEngine();
    const states: AgentControlState[] = [];
    let releaseTurn!: () => void;
    engine.turnImpl = async () => {
      await new Promise<void>((resolve) => { releaseTurn = resolve; });
      return {};
    };
    engine.setStateProbe((state) => states.push(state));

    post(engine, 'task');
    await flushMicrotasks();
    engine.setActivityStartedAt(100);
    const interrupting = engine.interrupt();

    expect(states.at(-1)).toMatchObject({ phase: 'stopping' });
    expect(states.at(-1)?.activeStartedAt).toBeUndefined();
    expect(states.at(-1)?.activeLlmStartedAt).toBeUndefined();
    expect(states.at(-1)?.activeToolPhaseStartedAt).toBeUndefined();

    releaseTurn();
    await interrupting;
  });

  it('runTurn 在 abort 后正常返回也必须走 cancelled，不得提交 outcome', async () => {
    const engine = new PumpTestEngine();
    let releaseTurn!: () => void;
    engine.turnImpl = async () => {
      await new Promise<void>(resolve => { releaseTurn = resolve; });
      return {};
    };

    post(engine, 'task');
    await flushMicrotasks();
    const interruptPromise = engine.interrupt();
    releaseTurn();
    await interruptPromise;

    expect(engine.cancelledReasons).toHaveLength(1);
    expect(engine.turnRuns).toBe(1);
    expect(engine.mailboxSize).toBe(0);
  });

  it('中断置位和真实 post 清除均通过既有状态广播可见', async () => {
    const engine = new PumpTestEngine();
    const published: AgentControlState[] = [];
    engine.setStateProbe(state => published.push(state));

    await engine.interrupt();
    expect(published.some(state => state.interrupted === true)).toBe(true);

    post(engine, 'fresh');
    expect(engine.interrupted).toBe(false);
    expect(published.some(state => state.interrupted === false)).toBe(true);
    await flushMicrotasks();
  });

  it('主中断无条件级联到全部子代理并置入同一中断稳态', async () => {
    const parent = new PumpTestEngine();
    const childA = new PumpTestEngine();
    const childB = new PumpTestEngine();
    parent.childEngines = [childA, childB];

    await parent.interrupt();

    expect(parent.interrupted).toBe(true);
    expect(childA.interrupted).toBe(true);
    expect(childB.interrupted).toBe(true);
  });

  it('中断恢复时从当前事实构造前置事件，不需预存通知', async () => {
    const engine = new PumpTestEngine();
    engine.interruptionResumeEvents = [
      {
        id: 'worker-interrupted',
        source: 'system',
        content: '<worker_interrupted>worker-a</worker_interrupted>',
      },
    ];
    await engine.interrupt();

    expect(engine.interrupted).toBe(true);
    expect(engine.isPumping).toBe(false);
    expect(engine.mailboxSize).toBe(0);

    post(engine, 'fresh');
    await flushMicrotasks();

    expect(engine.appliedBatches.at(-1)?.map((event) => event.id)).toEqual([
      'worker-interrupted',
      'fresh',
    ]);
  });

  it('flush/子中断/onAfterInterrupt 失败彼此隔离，旧 Pump 仍必须 settle 后才返回', async () => {
    const engine = new PumpTestEngine();
    let releaseTurn!: () => void;
    engine.turnImpl = async () => {
      await new Promise<void>(resolve => { releaseTurn = resolve; });
      return {};
    };
    engine.flushContext.mockImplementationOnce(() => {
      throw new Error('flush boom');
    });

    const childOk = {
      id: 'child-ok',
      instantInterrupt: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentEngine;
    const childFailed = {
      id: 'child-failed',
      instantInterrupt: vi.fn().mockRejectedValue(new Error('child boom')),
    } as unknown as AgentEngine;
    engine.childEngines = [childOk, childFailed];
    engine.throwInAfterInterrupt = true;

    post(engine, 'task');
    await flushMicrotasks();

    let resolved = false;
    const interruptPromise = engine.interrupt().then(() => { resolved = true; });
    await flushMicrotasks();

    expect(childOk.instantInterrupt).toHaveBeenCalledOnce();
    expect(childFailed.instantInterrupt).toHaveBeenCalledOnce();
    // onAfterInterrupt 是 join 后的最终广播，旧冲程未 settle 前不得触发。
    expect(engine.afterInterruptCalls).toBe(0);
    expect(engine.mailboxSize).toBe(0); // 生命周期控制面失败不得进入 Mailbox
    expect(resolved).toBe(false);

    releaseTurn();
    await interruptPromise;
    expect(resolved).toBe(true);
    expect(engine.afterInterruptCalls).toBe(1);
    expect(engine.cancelledReasons).toHaveLength(1);
  });
});

describe('系统事件（postSystemEvent factory）', () => {
  it('start 构造为完整 AgentInputEvent（source=system，id/timestamp 补全）', async () => {
    const engine = new PumpTestEngine();
    engine.fireSystemEvent();
    await flushMicrotasks();

    const batch = engine.appliedBatches[0];
    expect(batch).toHaveLength(1);
    expect(batch[0].source).toBe('system');
    expect(batch[0].id).toBeTruthy();
    expect(batch[0].timestamp).toBeInstanceOf(Date);
    expect((batch[0].content as Record<string, unknown>).type).toBe('start');
  });
});

describe('统一取消域', () => {
  const pendingCall = { id: 'call-1', toolName: 'test-tool', params: {} } as never;

  it('审批门挂起服从冲程 signal：abort 即 deny 收尾，pendingApprovals 清空', async () => {
    const engine = new PumpTestEngine();
    engine.approvalMode = 'confirm';
    const controller = new AbortController();

    const decisionPromise = engine.handleApprovalRequest(pendingCall, controller.signal);
    await flushMicrotasks();
    expect(engine.pendingApprovalCount).toBe(1);

    controller.abort();
    const decision = await decisionPromise;
    expect(decision.decision).toBe('deny');
    expect(engine.pendingApprovalCount).toBe(0);
  });

  it('signal 已 aborted 时审批门直接 deny，不挂起', async () => {
    const engine = new PumpTestEngine();
    engine.approvalMode = 'confirm';
    const controller = new AbortController();
    controller.abort();

    const decision = await engine.handleApprovalRequest(pendingCall, controller.signal);
    expect(decision.decision).toBe('deny');
    expect(engine.pendingApprovalCount).toBe(0);
  });

  it('正常 respondToApproval 处置后 abort 不产生第二次 resolve/残留', async () => {
    const engine = new PumpTestEngine();
    engine.approvalMode = 'confirm';
    const controller = new AbortController();

    const decisionPromise = engine.handleApprovalRequest(pendingCall, controller.signal);
    await flushMicrotasks();
    engine.respondToApproval({ callId: 'call-1', decision: 'allow' });
    const decision = await decisionPromise;
    expect(decision.decision).toBe('allow');

    controller.abort();   // 事后 abort 应为无操作
    expect(engine.pendingApprovalCount).toBe(0);
  });

  it('interrupt 时挂起的审批门随冲程 signal 收尾，冲程正常退场', async () => {
    const engine = new PumpTestEngine();
    engine.approvalMode = 'confirm';
    let decision: { decision: string } | undefined;
    engine.turnImpl = async (signal) => {
      decision = await engine.handleApprovalRequest(pendingCall, signal);
      return {};
    };

    post(engine, 'e1');
    await flushMicrotasks(8);
    expect(engine.isPumping).toBe(true);   // 冲程挂在审批门上
    expect(engine.pendingApprovalCount).toBe(1);

    await engine.interrupt();
    expect(decision?.decision).toBe('deny');
    expect(engine.pendingApprovalCount).toBe(0);
    expect(engine.isPumping).toBe(false);
  });

  it('审批期间到达的事件由同一冲程在审批完成后的 AI 边界吸收', async () => {
    const engine = new PumpTestEngine();
    engine.approvalMode = 'confirm';
    engine.turnImpl = async (signal) => {
      await engine.handleApprovalRequest(pendingCall, signal);
      engine.absorbAtAIBoundary();
      return { terminalReason: 'completed' };
    };

    post(engine, 'initial');
    await flushMicrotasks(8);
    expect(engine.pendingApprovalCount).toBe(1);

    post(engine, 'during-approval');
    await flushMicrotasks();
    expect(engine.turnRuns).toBe(1);
    expect(engine.mailboxSize).toBe(1);

    engine.respondToApproval({ callId: 'call-1', decision: 'allow' });
    await flushMicrotasks(12);

    expect(engine.appliedBatches.map((batch) => batch.map((event) => event.id))).toEqual([
      ['initial'],
      ['during-approval'],
    ]);
    expect(engine.turnRuns).toBe(1);
    expect(engine.isPumping).toBe(false);
  });

  it('执行中事件在 AI 边界吸收，terminal 后静默（调用数不增），新任务恰好启动一个新冲程', async () => {
    const engine = new PumpTestEngine();
    let firstTurn = true;
    engine.turnImpl = async () => {
      if (firstTurn) {
        firstTurn = false;
        post(engine, 'E1');            // AI/tool 执行中到达父流程事件
        engine.absorbAtAIBoundary();   // 模拟 runTurn 的 AI 边界吸收
        return { terminalReason: 'completed' };
      }
      return {};
    };

    post(engine, 'E0');
    await flushMicrotasks(12);
    expect(engine.turnRuns).toBe(1);
    expect(engine.mailboxSize).toBe(0);        // E1 已被吸收，不残留
    expect(engine.isPumping).toBe(false);      // Pump 结束

    await flushMicrotasks(12);
    expect(engine.turnRuns).toBe(1);           // terminal 后无新事件绝不再调 AI

    post(engine, 'E2');
    await flushMicrotasks(12);
    expect(engine.turnRuns).toBe(2);           // 恰好启动一个新冲程
    expect(engine.isPumping).toBe(false);
  });
});

describe('统一 Auto 与工作流确认', () => {
  const pending = (id: string, modeInvariant = false): PendingToolCall => ({
    id,
    agentId: 'pump-test',
    mainAgentId: 'pump-test',
    toolName: 'test-tool',
    params: {},
    timestamp: new Date(),
    description: 'Tool approval',
    category: 'system',
    modeInvariant,
  });

  it('Auto 对所有普通工具生效，不按工具来源分叉', async () => {
    const engine = new PumpTestEngine();
    engine.approvalMode = 'auto';

    await expect(engine.handleApprovalRequest(pending('mcp-call'))).resolves.toEqual({
      callId: 'mcp-call',
      decision: 'allow',
    });
    expect(engine.pendingApprovalCount).toBe(0);
  });

  it('计划正文等模式无关工作流确认仍需显式决定', async () => {
    const engine = new PumpTestEngine();
    engine.approvalMode = 'auto';

    const decisionPromise = engine.handleApprovalRequest(pending('plan-call', true));
    await flushMicrotasks();
    expect(engine.pendingApprovalCount).toBe(1);

    engine.respondToApproval({ callId: 'plan-call', decision: 'allow' });
    await expect(decisionPromise).resolves.toMatchObject({ decision: 'allow' });
  });

  it('切换 Auto 放行全部工具审批，但不吞掉工作流确认', async () => {
    const engine = new PumpTestEngine();
    engine.approvalMode = 'confirm';
    const current = engine.handleApprovalRequest(pending('current'));
    const ordinary = engine.handleApprovalRequest(pending('ordinary'));
    const workflow = engine.handleApprovalRequest(pending('workflow', true));
    await flushMicrotasks();

    engine.respondToApproval({
      callId: 'current',
      decision: 'allow',
      changeToAuto: true,
    });
    await expect(current).resolves.toMatchObject({ decision: 'allow' });
    await expect(ordinary).resolves.toMatchObject({ decision: 'allow' });
    expect(engine.pendingApprovalCount).toBe(1);

    engine.respondToApproval({ callId: 'workflow', decision: 'deny' });
    await expect(workflow).resolves.toMatchObject({ decision: 'deny' });
  });

  it('工作流确认即使收到伪造的 changeToAuto 也只批准本次', async () => {
    const engine = new PumpTestEngine();
    engine.approvalMode = 'confirm';
    const workflow = engine.handleApprovalRequest(pending('workflow', true));
    await flushMicrotasks();

    engine.respondToApproval({
      callId: 'workflow',
      decision: 'allow',
      changeToAuto: true,
    });

    await expect(workflow).resolves.toMatchObject({ decision: 'allow' });
    expect(engine.approvalMode).toBe('confirm');
  });
});

describe('独占工具守门（混批）', () => {
  const tu = (name: string, input: Record<string, unknown> = {}) =>
    ({ type: 'tool_use', id: `t-${name}`, name, input });

  class GateProbe extends PumpTestEngine {
    gate(toolUses: unknown[]): string | null {
      return this.checkExclusiveToolGate(toolUses as never);
    }
  }

  it('终态 send_event 单独调用：放行', () => {
    const engine = new GateProbe();
    expect(engine.gate([tu('send_event', { type: 'completed' })])).toBeNull();
  });

  it('终态 send_event 与普通工具混批：整批打回普通失败文本（无本地协议错误形状）', () => {
    const engine = new GateProbe();
    const violation = engine.gate([
      tu('read', { file_path: '/x' }),
      tu('send_event', { type: 'failed' }),
    ]);
    expect(violation).not.toBeNull();
    expect(violation).toContain('单独调用');
    expect(() => JSON.parse(violation!)).toThrow(); // 普通文本，非结构化 JSON
  });

  it('ask_user 单独调用：放行（ask_user 纳入 yield gate）', () => {
    const engine = new GateProbe();
    expect(engine.gate([tu('ask_user', { questions: [{ question: 'Q?' }] })])).toBeNull();
  });

  it('ask_user 与普通工具混批：整批打回，文案含 questions 数组合并指引', () => {
    const engine = new GateProbe();
    const violation = engine.gate([
      tu('ask_user', { questions: [{ question: 'Q?' }] }),
      tu('ls', {}),
    ]);
    expect(violation).not.toBeNull();
    expect(violation).toContain('合并到一次 ask_user 调用的 questions 数组');
  });

  it('多个 ask_user 同批：整批打回，文案含 questions 数组合并指引', () => {
    const engine = new GateProbe();
    const violation = engine.gate([
      tu('ask_user', { questions: [{ question: 'A?' }] }),
      tu('ask_user', { questions: [{ question: 'B?' }] }),
    ]);
    expect(violation).not.toBeNull();
    expect(violation).toContain('合并到一次 ask_user 调用的 questions 数组');
  });

  it('多个普通工具并行：放行（守门只管独占工具）', () => {
    const engine = new GateProbe();
    expect(engine.gate([tu('ls'), tu('read')])).toBeNull();
  });

  it('need_user_action send_event 与普通工具混批：整批打回', () => {
    const engine = new GateProbe();
    const violation = engine.gate([
      tu('send_event', { type: 'need_user_action' }),
      tu('ls'),
    ]);
    expect(violation).not.toBeNull();
    expect(violation).toContain('send_event');
  });

  it('一般消息 send_event 与普通工具混批：同样整批打回', () => {
    const engine = new GateProbe();
    expect(engine.gate([
      tu('send_event', { type: 'message', message: '继续处理' }),
      tu('ls'),
    ])).toContain('send_event');
  });

  it('非法 send_event 与普通工具混批：先整批打回，普通工具零副作用', () => {
    const engine = new GateProbe();
    expect(engine.gate([
      tu('send_event', { type: 'obsolete_type', message: '旧协议事件' }),
      tu('write'),
    ])).toContain('send_event');
  });
});

describe('并行工具实时指标', () => {
  it('does not double-count an early settlement over the active parallel union', () => {
    const engine = new PumpTestEngine();

    engine.startToolMetric('call-a', 0);
    engine.startToolMetric('call-b', 2);
    engine.finishToolMetric('call-a', { startedAt: 0, finishedAt: 10 });
    engine.settleToolMetric('call-a');

    expect(engine.metrics).toMatchObject({ steps: 1, toolDurationMs: 0 });
    expect(engine.getControlState().activeToolPhaseStartedAt).toBe(0);

    engine.finishToolMetric('call-b', { startedAt: 2, finishedAt: 14 });
    engine.settleToolMetric('call-b');

    expect(engine.metrics).toMatchObject({ steps: 2, toolDurationMs: 14 });
    expect(engine.getControlState().activeToolPhaseStartedAt).toBeUndefined();
  });
});
