/**
 * callAI 唯一 AgentIncident 写入点 + 类型凭据。
 * 覆盖：违约 provider throw string / frozen Error → 恰好一条最终 AgentIncident，
 * 上抛 RecordedAIRequestError（凭据在写入事实之后产生，cause 保留原错误）；
 * signal.aborted → 取消先行，零条 AgentIncident，原错误直接上抛。
 *
 * 外加上下文溢出恢复：压缩后重发一次，且只重发一次；
 * 恢复成功时不得留下 AgentIncident——那条错误已经不存在了。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { AIErrorType } from '../../../shared/constants/index.js';
import type { AgentControlState } from '../../../shared/types/agent-control.js';
import type { AgentLiveContentDelta } from '../../../shared/electron-contracts/agents.js';
import type { AIResponse, AgentInputEvent, Message, Tool } from '../../../shared/types/index.js';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/piskie-test' },
}));

const h = vi.hoisted(() => ({
  raiseIncident: vi.fn(),
  debugLog: vi.fn(),
}));

vi.mock('@electron/observability/logging/app-log.js', () => ({
  appLog: {
    debug: h.debugLog,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../observability/incidents/agent-incident-store.js', () => ({
  agentIncidentStore: {
    raise: h.raiseIncident,
    recover: vi.fn(),
  },
}));

import { AgentEngine } from '../agent-engine.js';
import { RecordedAIRequestError } from '../../core/ai/ai-request-error.js';
import { fakeAgentInference } from '../../testing/fake-agent-inference.js';
import { GatewayCallError } from '../../inference/execution/call-error.js';
import type {
  AgentInferenceOptions,
  AgentInferenceRequest,
} from '../../inference/application/agent-inference-port.js';

function successResponse(): AIResponse {
  return {
    content: [{ type: 'text', text: 'ok' }],
    requestInfo: {
      version: 1,
      requestId: 'request-ok',
      runId: 'run-ok',
      model: 'test::model',
      stopReason: 'end_turn',
      latencyMs: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  };
}

/** provider 判定超窗的结构化形态：协议 code，不读取展示文案。 */
function overflowError(message = 'prompt is too long: 210000 tokens > 200000 maximum'): GatewayCallError {
  return new GatewayCallError({
    source: 'provider',
    gateway: 'ai',
    providerId: 'test',
    modelId: 'model',
    driverId: 'test-driver',
    stage: 'stream',
    attempt: 1,
    traceId: 'trace-1',
    message,
    upstream: { code: 'context_length_exceeded', message },
  });
}

class CallAITestEngine extends AgentEngine {
  readonly compactAfterOverflow = vi.fn(async (
    _signal?: AbortSignal,
    onCompactionActivity?: (active: boolean) => void,
  ) => {
    onCompactionActivity?.(true);
    onCompactionActivity?.(false);
    return [] as unknown[];
  });
  readonly requestPhases: string[] = [];
  readonly liveDeltas: AgentLiveContentDelta[] = [];
  protected override emitLiveContent(event: AgentLiveContentDelta): void {
    this.liveDeltas.push(event);
  }

  get outputTokens() { return this.getActivityState().activeOutputTokens; }

  constructor(chatImpl: (req: unknown, opts?: unknown) => Promise<AIResponse>) {
    super();
    this.id = 'callai-test';
    this.mainAgentId = this.id;
    this.currentModel = 'test::model';
    this.currentTarget = { providerId: 'test', modelId: 'model' };
    this.incidentTarget = { agentId: 'callai-test' };
    this.context = {
      beginTurn: vi.fn(),
      captureRequestBoundary: vi.fn(() => undefined),
      commitSuccessfulRequest: vi.fn(),
      getContextUsage: vi.fn(() => ({ limit: 200_000 })),
      getAllMessages: () => [],
      projectRequestTokenCheckpoints: vi.fn(() => []),
      flush: vi.fn(),
      markTurnProcessed: vi.fn(),
      compactAfterOverflow: this.compactAfterOverflow,
    } as never;
    this.inference = fakeAgentInference({ invoke: chatImpl as never });
  }

  buildSystemPrompt(): string { return ''; }
  getControlState(): AgentControlState {
    return {
      phase: this.phase,
      aiRequestState: this.aiRequestState,
      ...this.getActivityState(),
    } as AgentControlState;
  }
  setStateProbe(callback: (state: AgentControlState) => void): void {
    this.stateChangeCallback = callback;
  }
  protected applyEvents(_events: AgentInputEvent[]): void {}

  override emitStateChange(): void {
    if (this.aiRequestState) this.requestPhases.push(this.aiRequestState.phase);
    super.emitStateChange();
  }

  runCallAI(signal?: AbortSignal): Promise<AIResponse> {
    return this.callAI('sys', [], [], signal);
  }

  runCallAIWith(systemPrompt: string, tools: Tool[], messages: Message[]): Promise<AIResponse> {
    return this.callAI(systemPrompt, tools, messages);
  }

  get requestState() {
    return this.aiRequestState;
  }

  get activityState() {
    const state = this.getActivityState();
    return {
      activeStartedAt: state.activeStartedAt,
      activeLlmStartedAt: state.activeLlmStartedAt,
      activeToolPhaseStartedAt: state.activeToolPhaseStartedAt,
    };
  }

  startToolActivity(callId: string, startedAt: number): void {
    this.recordToolExecutionStarted(callId, startedAt);
  }

  finishToolActivity(callId: string, startedAt: number, finishedAt: number): void {
    this.recordToolExecutionFinished(callId, { startedAt, finishedAt });
  }

  finishActivity(): void {
    this.publishInert();
  }
}

beforeEach(() => {
  h.raiseIncident.mockClear();
  h.debugLog.mockClear();
});

describe('callAI 唯一 AgentIncident 写入点', () => {
  it('请求存活期间 Context Snapshot 暴露 inference 正在使用的同一组结构引用', async () => {
    let release!: () => void;
    let markInvoked!: () => void;
    let request: AgentInferenceRequest | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const invoked = new Promise<void>((resolve) => { markInvoked = resolve; });
    const engine = new CallAITestEngine(async (input) => {
      request = input as AgentInferenceRequest;
      markInvoked();
      await gate;
      return successResponse();
    });
    const tools: Tool[] = [{
      name: 'read',
      description: 'Read a file',
      input_schema: { type: 'object', properties: {} },
    }];
    const messages: Message[] = [{ role: 'user', content: 'inspect me' }];

    const pending = engine.runCallAIWith('exact system', tools, messages);
    await invoked;
    const snapshot = engine.buildContextSnapshot();

    expect(snapshot.systemPrompt).toBe('exact system');
    expect(snapshot.tools).toBe(request?.tools);
    expect(snapshot.messages).toBe(request?.messages);
    expect(snapshot.tools).toBe(tools);
    expect(snapshot.messages).toBe(messages);
    expect(snapshot.requestTokenCheckpoints).toEqual([]);

    release();
    await pending;
  });

  it('违约 provider throw string：规整后恰好一条最终 AgentIncident，上抛类型凭据', async () => {
    const engine = new CallAITestEngine(async () => {
      // eslint-disable-next-line no-throw-literal
      throw 'primitive failure';   // symbol 属性打不上 primitive——类型凭据必须仍然成立
    });

    const rejection = await engine.runCallAI().catch((e: unknown) => e);

    expect(rejection).toBeInstanceOf(RecordedAIRequestError);
    expect((rejection as RecordedAIRequestError).failure.message).toContain('primitive failure');
    expect((rejection as RecordedAIRequestError).cause).toBe('primitive failure');
    expect(h.raiseIncident).toHaveBeenCalledTimes(1);
    expect(h.raiseIncident.mock.calls[0][0]).toMatchObject({
      severity: 'error',
      category: 'ai_request',
    });
    expect(engine.requestState).toMatchObject({ phase: 'finished', outcome: 'failed' });
  });

  it('违约 provider throw frozen Error：同样恰好一条，cause 保留原错误', async () => {
    const frozen = Object.freeze(new Error('frozen failure'));
    const engine = new CallAITestEngine(async () => { throw frozen; });

    const rejection = await engine.runCallAI().catch((e: unknown) => e);

    expect(rejection).toBeInstanceOf(RecordedAIRequestError);
    expect((rejection as RecordedAIRequestError).cause).toBe(frozen);
    expect(h.raiseIncident).toHaveBeenCalledTimes(1);
    expect(h.raiseIncident.mock.calls[0][0].message).toContain('frozen failure');
  });

  it('signal.aborted：取消先行——零条 AgentIncident，原错误直接上抛，状态标 cancelled', async () => {
    const controller = new AbortController();
    const original = new Error('request aborted');
    const engine = new CallAITestEngine(async () => {
      controller.abort();
      throw original;
    });

    const rejection = await engine.runCallAI(controller.signal).catch((e: unknown) => e);

    expect(rejection).toBe(original);   // 不包装：取消不是错误，不产生凭据
    expect(h.raiseIncident).not.toHaveBeenCalled();
    expect(engine.requestState).toMatchObject({ phase: 'finished', outcome: 'cancelled' });
  });

  it('成功路径：零条 AgentIncident，状态 finished/success', async () => {
    const response: AIResponse = {
      ...successResponse(),
      requestInfo: {
        ...successResponse().requestInfo,
        usage: {
          inputTokens: 100,
          outputTokens: 4,
          cacheReadTokens: 60,
          cacheWriteTokens: 25,
        },
      },
    };
    const engine = new CallAITestEngine(async () => response);

    const result = await engine.runCallAI();

    expect(result.requestInfo.stopReason).toBe('end_turn');
    expect(h.raiseIncident).not.toHaveBeenCalled();
    expect(engine.requestState).toMatchObject({ phase: 'finished', outcome: 'success' });
    expect(engine.activityState.activeLlmStartedAt).toBeUndefined();
    expect(h.debugLog).toHaveBeenCalledWith({
      event: 'agent.inference.cache.measured',
      message: 'Inference cache usage measured',
      context: {
        scope: 'agent.inference.cache',
        agentId: 'callai-test',
        requestId: 'request-ok',
        model: 'test::model',
        inputTokens: 100,
        cacheReadTokens: 60,
        cacheWriteTokens: 25,
        cacheHitPercent: 60,
        cumulativeInputTokens: 100,
        cumulativeCacheReadTokens: 60,
      },
    });
  });

  it('缓存明细缺失时日志保留 null，同时按 0% 进入累计口径', async () => {
    const engine = new CallAITestEngine(async () => successResponse());

    await engine.runCallAI();

    expect(h.debugLog).toHaveBeenCalledWith(expect.objectContaining({
      event: 'agent.inference.cache.measured',
      context: expect.objectContaining({
        inputTokens: 1,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        cacheHitPercent: 0,
        cumulativeInputTokens: 1,
        cumulativeCacheReadTokens: 0,
      }),
    }));
  });

  it('keeps one activity clock across AI, tool, and the next AI request', async () => {
    let invocation = 0;
    let resolveSecond!: (response: AIResponse) => void;
    const engine = new CallAITestEngine(async () => {
      invocation++;
      if (invocation === 1) return successResponse();
      return new Promise<AIResponse>((resolve) => {
        resolveSecond = resolve;
      });
    });
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);

    try {
      await engine.runCallAI();
      expect(engine.activityState).toEqual({
        activeStartedAt: 1_000,
        activeLlmStartedAt: undefined,
        activeToolPhaseStartedAt: undefined,
      });

      engine.startToolActivity('call-1', 1_200);
      expect(engine.activityState).toEqual({
        activeStartedAt: 1_000,
        activeLlmStartedAt: undefined,
        activeToolPhaseStartedAt: 1_200,
      });
      engine.finishToolActivity('call-1', 1_200, 1_300);

      now.mockReturnValue(2_000);
      const second = engine.runCallAI();
      await Promise.resolve();
      expect(engine.activityState).toEqual({
        activeStartedAt: 1_000,
        activeLlmStartedAt: 2_000,
        activeToolPhaseStartedAt: undefined,
      });

      resolveSecond(successResponse());
      await second;
      expect(engine.activityState.activeStartedAt).toBe(1_000);

      engine.finishActivity();
      expect(engine.activityState).toEqual({
        activeStartedAt: undefined,
        activeLlmStartedAt: undefined,
        activeToolPhaseStartedAt: undefined,
      });
    } finally {
      now.mockRestore();
    }
  });
});

describe('callAI output activity', () => {
  it('updates during generation, rejects finished and older request callbacks, and clears between activities', async () => {
    const calls: AgentInferenceOptions[] = [];
    let release!: () => void;
    const engine = new CallAITestEngine(async (_request, rawOptions) => {
      const options = rawOptions as AgentInferenceOptions;
      calls.push(options);
      await new Promise<void>((resolve) => { release = resolve; });
      return { ...successResponse(), requestInfo: {
        ...successResponse().requestInfo, requestId: options.requestId, usage: { outputTokens: 4 },
      } };
    });
    const first = engine.runCallAI();
    const old = calls[0]!;
    old.onOutputProgress?.({ kind: 'attempt-started', runId: 'run-1', attempt: 1 });
    old.onOutputProgress?.({ kind: 'delta', runId: 'run-1', attempt: 1, sequence: 2, delta: 'abcd' });
    expect(engine.outputTokens).toEqual({ count: 1, estimated: true });
    release();
    await first;
    expect(engine.outputTokens).toEqual({ count: 4, estimated: false });
    old.onOutputProgress?.({ kind: 'usage', runId: 'run-1', attempt: 1, sequence: 3, outputTokens: 999 });
    expect(engine.outputTokens).toEqual({ count: 4, estimated: false });
    const second = engine.runCallAI();
    old.onOutputProgress?.({ kind: 'usage', runId: 'run-1', attempt: 1, sequence: 4, outputTokens: 999 });
    const fresh = calls[1]!;
    fresh.onOutputProgress?.({ kind: 'attempt-started', runId: 'run-2', attempt: 1 });
    fresh.onOutputProgress?.({ kind: 'delta', runId: 'run-2', attempt: 1, sequence: 2, delta: 'abcd' });
    expect(engine.outputTokens).toEqual({ count: 5, estimated: true });
    release();
    await second;
    expect(engine.outputTokens).toEqual({ count: 8, estimated: false });
    engine.finishActivity();
    expect(engine.outputTokens).toBeUndefined();
    const third = engine.runCallAI();
    expect(engine.outputTokens).toBeUndefined();
    fresh.onOutputProgress?.({ kind: 'usage', runId: 'run-2', attempt: 1, sequence: 3, outputTokens: 999 });
    expect(engine.outputTokens).toBeUndefined();
    release();
    await third;
  });

  it('ignores output and visible content arriving after cancellation', async () => {
    const controller = new AbortController();
    let options!: AgentInferenceOptions;
    let reject!: (error: Error) => void;
    const engine = new CallAITestEngine(async (_request, rawOptions) => {
      options = rawOptions as AgentInferenceOptions;
      return new Promise<AIResponse>((_resolve, rejectRequest) => { reject = rejectRequest; });
    });
    const pending = engine.runCallAI(controller.signal);
    const base = { runId: 'run-1', attempt: 1 };
    options.onOutputProgress?.({ ...base, kind: 'attempt-started' });
    options.onOutputProgress?.({ ...base, kind: 'delta', sequence: 2, delta: 'abcd' });
    options.onVisibleDelta?.({ ...base, kind: 'text', sequence: 1, delta: 'abcd' });
    controller.abort();
    options.onOutputProgress?.({ ...base, kind: 'usage', sequence: 3, outputTokens: 999 });
    options.onVisibleDelta?.({ ...base, kind: 'text', sequence: 2, delta: 'late' });
    expect(engine.outputTokens).toEqual({ count: 1, estimated: true });
    expect(engine.liveDeltas.map((delta) => delta.delta)).toEqual(['abcd']);
    const original = new Error('cancelled request');
    reject(original);
    await expect(pending).rejects.toBe(original);
    engine.finishActivity();
    expect(engine.outputTokens).toBeUndefined();
    options.onOutputProgress?.({ ...base, kind: 'delta', sequence: 4, delta: 'late' });
    expect(engine.outputTokens).toBeUndefined();
  });

  it('replaces an overflow run within the same request and rejects its late output', async () => {
    let invocations = 0;
    const calls: AgentInferenceOptions[] = [];
    const engine = new CallAITestEngine(async (_request, rawOptions) => {
      const options = rawOptions as AgentInferenceOptions;
      calls.push(options);
      invocations++;
      if (invocations === 1) {
        options.onOutputProgress?.({ kind: 'attempt-started', runId: 'overflow-run', attempt: 1 });
        options.onOutputProgress?.({ kind: 'usage', runId: 'overflow-run', attempt: 1, sequence: 2, outputTokens: 50 });
        throw overflowError();
      }
      options.onOutputProgress?.({ kind: 'attempt-started', runId: 'resend-run', attempt: 1 });
      expect(engine.outputTokens).toBeUndefined();
      options.onOutputProgress?.({ kind: 'usage', runId: 'overflow-run', attempt: 1, sequence: 3, outputTokens: 999 });
      expect(engine.outputTokens).toBeUndefined();
      options.onOutputProgress?.({ kind: 'delta', runId: 'resend-run', attempt: 1, sequence: 2, delta: 'abcd' });
      expect(engine.outputTokens).toEqual({ count: 1, estimated: true });
      return { ...successResponse(), requestInfo: {
        ...successResponse().requestInfo, requestId: options.requestId, runId: 'resend-run',
        usage: { outputTokens: 3, reasoningTokens: 2 },
      } };
    });
    await engine.runCallAI();
    expect(calls[1]).toBe(calls[0]);
    expect(engine.outputTokens).toEqual({ count: 3, estimated: false });
    expect(h.raiseIncident).not.toHaveBeenCalled();
  });
});

class OutputPumpTestEngine extends CallAITestEngine {
  protected override async runTurn(signal: AbortSignal) {
    await this.runCallAI(signal);
    return {};
  }
}

function outputProgressHarness(Engine = CallAITestEngine) {
  const calls: Array<{
    options: AgentInferenceOptions;
    resolve: (response: AIResponse) => void;
    reject: (error: Error) => void;
  }> = [];
  const engine = new Engine((_request, options) => new Promise((resolve, reject) => {
    calls.push({ options: options as AgentInferenceOptions, resolve, reject });
  }));
  const states: AgentControlState[] = [];
  engine.setStateProbe((state) => states.push(state));
  const complete = (index: number, outputTokens = 4) => {
    const call = calls[index]!;
    call.resolve({
      ...successResponse(),
      requestInfo: {
        ...successResponse().requestInfo,
        requestId: call.options.requestId,
        usage: { outputTokens },
      },
    });
  };
  return { engine, calls, states, complete };
}

function startOutput(options: AgentInferenceOptions, runId = 'sample-run', attempt = 1) {
  const base = { runId, attempt };
  options.onOutputProgress?.({ ...base, kind: 'attempt-started' });
  return (sequence: number) => options.onOutputProgress?.({
    ...base, kind: 'delta', sequence, delta: 'abcd',
  });
}

describe('callAI output notification coalescing', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('accumulates every dense delta immediately and publishes the latest value at most every 100ms', async () => {
    const { engine, calls, states, complete } = outputProgressHarness();
    const project = vi.spyOn(engine, 'getControlState');
    const pending = engine.runCallAI();
    const delta = startOutput(calls[0]!.options);
    delta(2);
    expect(states.at(-1)?.activeOutputTokens).toEqual({ count: 1, estimated: true });
    expect(vi.getTimerCount()).toBe(0);

    for (let sequence = 3; sequence <= 52; sequence++) delta(sequence);
    expect(engine.outputTokens).toEqual({ count: 51, estimated: true });
    expect(states).toHaveLength(2);
    expect(project).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(99);
    expect(states).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(states.at(-1)?.activeOutputTokens).toEqual({ count: 51, estimated: true });

    for (let sequence = 53; sequence <= 102; sequence++) delta(sequence);
    expect(engine.outputTokens).toEqual({ count: 101, estimated: true });
    expect(states).toHaveLength(3);
    vi.advanceTimersByTime(100);
    expect(states.at(-1)?.activeOutputTokens).toEqual({ count: 101, estimated: true });
    expect(project).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(1_000);
    expect(states).toHaveLength(4);
    expect(engine.outputTokens).toEqual({ count: 101, estimated: true });
    engine.emitStateChange();
    expect(states).toHaveLength(5);
    complete(0);
    await pending;
  });

  it('publishes provider usage and final response corrections immediately and starts the next activity fresh', async () => {
    const { engine, calls, states, complete } = outputProgressHarness();
    const pending = engine.runCallAI();
    const options = calls[0]!.options;
    const delta = startOutput(options);
    delta(2);
    delta(3);
    expect(vi.getTimerCount()).toBe(1);
    options.onOutputProgress?.({
      kind: 'usage', runId: 'sample-run', attempt: 1, sequence: 4, outputTokens: 7,
    });
    expect(states.at(-1)?.activeOutputTokens).toEqual({ count: 7, estimated: false });
    expect(vi.getTimerCount()).toBe(0);
    delta(5);
    delta(6);
    expect(vi.getTimerCount()).toBe(1);
    complete(0, 11);
    await pending;
    expect(states.at(-1)?.activeOutputTokens).toEqual({ count: 11, estimated: false });
    expect(states.at(-1)?.aiRequestState?.phase).toBe('finished');
    expect(vi.getTimerCount()).toBe(0);
    engine.finishActivity();
    expect(states.at(-1)?.activeOutputTokens).toBeUndefined();
    const emitted = states.length;
    vi.advanceTimersByTime(1_000);
    expect(states).toHaveLength(emitted);

    const next = engine.runCallAI();
    startOutput(calls[1]!.options, 'sample-next-run')(2);
    expect(states.at(-1)?.activeOutputTokens).toEqual({ count: 1, estimated: true });
    expect(vi.getTimerCount()).toBe(0);
    complete(1);
    await next;
  });

  it('flushes pending output at backoff and cancels it when an attempt or overflow run is replaced', async () => {
    const { engine, calls, states, complete } = outputProgressHarness();
    const pending = engine.runCallAI();
    const options = calls[0]!.options;
    const first = startOutput(options);
    first(2);
    first(3);
    expect(vi.getTimerCount()).toBe(1);
    options.onBackoff?.({
      attempt: 1, maxAttempts: 2, errorType: AIErrorType.NETWORK,
      retryAt: Date.now() + 1_000, errorMessage: 'Sample retry',
    });
    expect(states.at(-1)?.activeOutputTokens).toEqual({ count: 2, estimated: true });
    expect(states.at(-1)?.aiRequestState?.phase).toBe('backoff');
    expect(vi.getTimerCount()).toBe(0);
    const retry = startOutput(options, 'sample-run', 2);
    options.onAttemptStart?.({ attempt: 1, maxAttempts: 2 });
    expect(states.at(-1)?.activeOutputTokens).toBeUndefined();
    retry(4);
    expect(states.at(-1)?.activeOutputTokens).toEqual({ count: 1, estimated: true });
    retry(5);
    expect(vi.getTimerCount()).toBe(1);
    const resend = startOutput(options, 'sample-resend-run');
    expect(states.at(-1)?.activeOutputTokens).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    resend(2);
    expect(states.at(-1)?.activeOutputTokens).toEqual({ count: 1, estimated: true });
    const emitted = states.length;
    vi.advanceTimersByTime(100);
    expect(states).toHaveLength(emitted);
    complete(0);
    await pending;
  });

  it('removes a pending refresh on abort before the provider settles', async () => {
    const { engine, calls, states } = outputProgressHarness();
    const controller = new AbortController();
    const pending = engine.runCallAI(controller.signal);
    const delta = startOutput(calls[0]!.options);
    delta(2);
    delta(3);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    expect(vi.getTimerCount()).toBe(0);
    const emitted = states.length;
    delta(4);
    vi.advanceTimersByTime(1_000);
    expect(states).toHaveLength(emitted);
    expect(engine.outputTokens).toEqual({ count: 2, estimated: true });
    const error = new Error('Sample cancellation');
    calls[0]!.reject(error);
    await expect(pending).rejects.toBe(error);
    expect(states.at(-1)?.aiRequestState?.outcome).toBe('cancelled');
    engine.finishActivity();
    expect(states.at(-1)?.activeOutputTokens).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['interrupt', 'destroy'] as const)('%s cancels a pending refresh synchronously while the pump is settling', async (action) => {
    const { engine, calls, states, complete } = outputProgressHarness(OutputPumpTestEngine);
    engine.post({ source: 'user', content: 'Sample request' });
    await Promise.resolve();
    const delta = startOutput(calls[0]!.options);
    delta(2);
    delta(3);
    expect(vi.getTimerCount()).toBe(1);
    const stopping = engine[action]();
    expect(vi.getTimerCount()).toBe(0);
    if (action === 'interrupt') {
      expect(states.at(-1)?.phase).toBe('stopping');
      expect(states.at(-1)?.activeOutputTokens).toBeUndefined();
    }
    const emitted = states.length;
    delta(4);
    vi.advanceTimersByTime(1_000);
    expect(states).toHaveLength(emitted);
    expect(vi.getTimerCount()).toBe(0);
    calls[0]!.reject(new Error('Sample cancellation'));
    await stopping;
    expect(vi.getTimerCount()).toBe(0);
    if (action === 'interrupt') {
      const next = engine.runCallAI();
      startOutput(calls[1]!.options, 'sample-next-run')(2);
      expect(states.at(-1)?.activeOutputTokens).toEqual({ count: 1, estimated: true });
      complete(1);
      await next;
    }
  });
});

describe('上下文溢出恢复', () => {
  const ok = successResponse();

  it('溢出 → 压缩 → 重发一次成功：零条 AgentIncident（那条错误已经不存在了）', async () => {
    let attempts = 0;
    const engine = new CallAITestEngine(async () => {
      attempts++;
      if (attempts === 1) throw overflowError();
      return ok;
    });

    await expect(engine.runCallAI()).resolves.toBe(ok);
    expect(attempts).toBe(2);
    expect(engine.compactAfterOverflow).toHaveBeenCalledTimes(1);
    expect(h.raiseIncident).not.toHaveBeenCalled();
    const compacting = engine.requestPhases.indexOf('compacting');
    const resending = engine.requestPhases.indexOf('resending');
    expect(compacting).toBeGreaterThanOrEqual(0);
    expect(resending).toBeGreaterThan(compacting);
    expect(engine.requestPhases.at(-1)).toBe('finished');
    expect(engine.requestState).toMatchObject({ phase: 'finished', outcome: 'success' });
  });

  it('overflow resend reuses one logical request and returns only the successful run facts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const calls: AgentInferenceOptions[] = [];
    const requests: AgentInferenceRequest[] = [];
    const engine = new CallAITestEngine(async (rawRequest, rawOptions) => {
      requests.push(rawRequest as AgentInferenceRequest);
      const options = rawOptions as AgentInferenceOptions;
      calls.push(options);
      if (calls.length === 1) {
        vi.setSystemTime(1_400);
        throw overflowError();
      }
      vi.setSystemTime(1_800);
      return {
        content: [{ type: 'text', text: 'recovered' }],
        requestInfo: {
          version: 1,
          requestId: options.requestId,
          runId: 'successful-overflow-run',
          model: 'test::model',
          stopReason: 'end_turn',
          latencyMs: Date.now() - options.logicalStartedAt,
          firstTokenLatencyMs: 25,
          attemptDurationMs: 100,
          usage: { inputTokens: 2, outputTokens: 1 },
        },
      };
    });

    try {
      const response = await engine.runCallAI();

      expect(calls).toHaveLength(2);
      expect(calls[1]).toBe(calls[0]);
      expect(requests.map((request) => request.promptCacheKey)).toEqual([
        'callai-test',
        'callai-test',
      ]);
      expect(calls[0]).toMatchObject({
        requestId: expect.stringMatching(/^turn-1000-/),
        logicalStartedAt: 1_000,
      });
      expect(response.requestInfo).toMatchObject({
        requestId: calls[0]!.requestId,
        runId: 'successful-overflow-run',
        latencyMs: 800,
        firstTokenLatencyMs: 25,
        attemptDurationMs: 100,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('重发后仍溢出：只重发一次并原样展示第二次 provider 错误 E2', async () => {
    let attempts = 0;
    const firstMessage = 'E1: original request exceeded context';
    const secondMessage = 'E2: compacted request still exceeded context';
    const engine = new CallAITestEngine(async () => {
      attempts++;
      throw overflowError(attempts === 1 ? firstMessage : secondMessage);
    });

    const rejection = await engine.runCallAI().catch((e: unknown) => e);

    expect(attempts).toBe(2);
    expect(engine.compactAfterOverflow).toHaveBeenCalledTimes(1);
    expect(rejection).toBeInstanceOf(RecordedAIRequestError);
    expect((rejection as RecordedAIRequestError).failure.errorType).toBe('context_overflow');
    expect((rejection as RecordedAIRequestError).failure.message).toBe(secondMessage);
    expect(h.raiseIncident).toHaveBeenCalledTimes(1);
    expect(h.raiseIncident.mock.calls[0][0].message).toBe(secondMessage);
  });

  it('摘要不成立或失败：不重发并原样展示第一次 provider 错误 E1', async () => {
    let attempts = 0;
    const firstMessage = 'E1: original provider overflow message';
    const engine = new CallAITestEngine(async () => {
      attempts++;
      throw overflowError(firstMessage);
    });
    engine.compactAfterOverflow.mockResolvedValue(undefined as never);

    const rejection = await engine.runCallAI().catch((error: unknown) => error);

    expect(attempts).toBe(1);
    expect(engine.compactAfterOverflow).toHaveBeenCalledTimes(1);
    expect(rejection).toBeInstanceOf(RecordedAIRequestError);
    expect((rejection as RecordedAIRequestError).failure.message).toBe(firstMessage);
    expect(h.raiseIncident).toHaveBeenCalledTimes(1);
    expect(h.raiseIncident.mock.calls[0][0].message).toBe(firstMessage);
  });

  it('非溢出错误不走这条路：不压缩，直接记录', async () => {
    const engine = new CallAITestEngine(async () => { throw new Error('boom'); });

    await engine.runCallAI().catch(() => undefined);

    expect(engine.compactAfterOverflow).not.toHaveBeenCalled();
    expect(h.raiseIncident).toHaveBeenCalledTimes(1);
  });
});
