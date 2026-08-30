/**
 * callAI 唯一 AgentIncident 写入点 + 类型凭据。
 * 覆盖：违约 provider throw string / frozen Error → 恰好一条最终 AgentIncident，
 * 上抛 RecordedAIRequestError（凭据在写入事实之后产生，cause 保留原错误）；
 * signal.aborted → 取消先行，零条 AgentIncident，原错误直接上抛。
 *
 * 外加上下文溢出恢复：压缩后重发一次，且只重发一次；
 * 恢复成功时不得留下 AgentIncident——那条错误已经不存在了。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AgentControlState } from '../../../shared/types/agent-control.js';
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
      projectRequestTokenCheckpoints: vi.fn(() => []),
      flush: vi.fn(),
      markTurnProcessed: vi.fn(),
      compactAfterOverflow: this.compactAfterOverflow,
    } as never;
    this.inference = fakeAgentInference({ invoke: chatImpl as never });
  }

  buildSystemPrompt(): string { return ''; }
  getControlState(): AgentControlState { return {} as AgentControlState; }
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
          firstVisibleContentLatencyMs: 25,
          generationDurationMs: 75,
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
        firstVisibleContentLatencyMs: 25,
        generationDurationMs: 75,
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
