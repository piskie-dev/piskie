import { describe, expect, it, vi } from 'vitest';
import { GatewayCallError } from '../../execution/call-error.js';
import type { RunContext } from '../../execution/contracts.js';
import {
  RuntimeSnapshotStore,
  type CompiledTarget,
  type InferenceRuntimeSnapshot,
} from '../../execution/runtime-snapshot.js';
import type { AiAttemptEvent, AiEvent, AiRequest } from '../contracts.js';
import { DefaultAiGateway } from '../public-gateway.js';
import { AIRequestInfoCollector } from '../request-info-collector.js';

const request: AiRequest = {
  model: { providerId: 'chosen-provider', modelId: 'chosen-model' },
  messages: [{ role: 'user', content: [{ kind: 'text', text: 'hello' }] }],
};

function context(signal: AbortSignal = new AbortController().signal): RunContext {
  return { runId: 'run-1', traceId: 'trace-1', signal };
}

function snapshot(targets: CompiledTarget[]): InferenceRuntimeSnapshot {
  const providers = new Map<string, Map<string, CompiledTarget>>();
  for (const target of targets) {
    const models = providers.get(target.ref.providerId) ?? new Map<string, CompiledTarget>();
    models.set(target.ref.modelId, target);
    providers.set(target.ref.providerId, models);
  }
  return {
    configRevision: 7,
    catalogVersion: 'test',
    targets: providers,
    policies: {
      ai: {
        maxAttempts: 3,
        connectTimeoutMs: 1_000,
        streamIdleTimeoutMs: 1_000,
        retryBaseDelayMs: 1,
      },
      image: {
        maxSubmitAttempts: 2,
        submitTimeoutMs: 1_000,
        operationTimeoutMs: 5_000,
        allowResubmitAfterAccepted: false,
      },
    },
    createdAt: '2026-07-29T00:00:00.000Z',
  };
}

function target(openAttempt: NonNullable<CompiledTarget['ai']>['openAttempt']): CompiledTarget {
  return {
    ref: request.model,
    driverId: 'fake-ai',
    upstreamModel: 'wire-model',
    catalogId: 'test/model',
    configRevision: 7,
    ai: { openAttempt },
  };
}

function gatewayWith(...targets: CompiledTarget[]): DefaultAiGateway {
  const store = new RuntimeSnapshotStore();
  store.publish(snapshot(targets));
  return new DefaultAiGateway(store, { sleep: async () => undefined });
}

async function collect(events: AsyncIterable<AiEvent>): Promise<AiEvent[]> {
  const result: AiEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe('DefaultAiGateway', () => {
  it('retries the exact selected target before visible output', async () => {
    const attempts: number[] = [];
    const selected = target(async function* (_request, attemptContext): AsyncIterable<AiAttemptEvent> {
      attempts.push(attemptContext.attempt);
      expect(_request.model).toEqual(request.model);
      if (attemptContext.attempt === 1) {
        throw new GatewayCallError({
          source: 'transport',
          gateway: 'ai',
          providerId: request.model.providerId,
          modelId: request.model.modelId,
          driverId: 'fake-ai',
          stage: 'connect',
          attempt: 1,
          traceId: attemptContext.traceId,
          message: 'socket unavailable',
        });
      }
      yield { kind: 'text.delta', text: 'ok' };
      yield { kind: 'usage.updated', usage: { totalInputTokens: 2, totalOutputTokens: 1 } };
      yield { kind: 'response.completed', stopReason: 'end_turn' };
    });

    const events = await collect(gatewayWith(selected).open(request, context()).events);
    expect(attempts).toEqual([1, 2]);
    expect(events.map((event) => event.kind)).toEqual([
      'response.started',
      'response.retrying',
      'text.delta',
      'usage.updated',
      'response.completed',
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it('retries a statusless structured provider overload through the gateway loop', async () => {
    const attempts: number[] = [];
    const selected = target(async function* (_request, attemptContext): AsyncIterable<AiAttemptEvent> {
      attempts.push(attemptContext.attempt);
      if (attemptContext.attempt === 1) {
        throw new GatewayCallError({
          source: 'provider',
          gateway: 'ai',
          providerId: request.model.providerId,
          modelId: request.model.modelId,
          driverId: 'openai',
          stage: 'request',
          attempt: 1,
          traceId: attemptContext.traceId,
          message: 'Our servers are currently overloaded. Please try again later.',
          upstream: {
            code: 'server_is_overloaded',
            type: 'service_unavailable_error',
            message: 'Our servers are currently overloaded. Please try again later.',
          },
        });
      }
      yield { kind: 'text.delta', text: 'ok' };
      yield { kind: 'response.completed', stopReason: 'end_turn' };
    });

    const events = await collect(gatewayWith(selected).open(request, context()).events);

    expect(attempts).toEqual([1, 2]);
    expect(events.map((event) => event.kind)).toEqual([
      'response.started',
      'response.retrying',
      'text.delta',
      'response.completed',
    ]);
    expect(events[1]).toMatchObject({
      kind: 'response.retrying',
      attempt: 1,
      error: {
        source: 'provider',
        upstream: { code: 'server_is_overloaded' },
      },
    });
  });

  it('retries the selected target after visible output without invoking another target', async () => {
    const failure = new GatewayCallError({
      source: 'provider',
      gateway: 'ai',
      providerId: request.model.providerId,
      modelId: request.model.modelId,
      driverId: 'fake-ai',
      stage: 'stream',
      attempt: 1,
      traceId: 'trace-1',
      message: 'upstream closed',
      upstream: { status: 503, message: 'upstream closed', body: { detail: 'real body' } },
    });
    const selectedCalls = vi.fn();
    const otherCalls = vi.fn();
    const selected = target(async function* (_request, attemptContext): AsyncIterable<AiAttemptEvent> {
      selectedCalls();
      if (attemptContext.attempt === 1) {
        yield { kind: 'text.delta', text: 'partial' };
        throw failure;
      }
      yield { kind: 'text.delta', text: 'replacement' };
      yield { kind: 'response.completed', stopReason: 'end_turn' };
    });
    const other: CompiledTarget = {
      ...target(async function* (): AsyncIterable<AiAttemptEvent> {
        otherCalls();
        yield { kind: 'response.completed', stopReason: 'end_turn' };
      }),
      ref: { providerId: 'other-provider', modelId: 'other-model' },
    };

    const events = await collect(gatewayWith(selected, other).open(request, context()).events);
    expect(selectedCalls).toHaveBeenCalledTimes(2);
    expect(otherCalls).not.toHaveBeenCalled();
    expect(events.map((event) => event.kind)).toEqual([
      'response.started',
      'text.delta',
      'response.retrying',
      'text.delta',
      'response.completed',
    ]);
    expect(events[2]).toMatchObject({ kind: 'response.retrying', error: failure });
    expect(events[3]).toMatchObject({ kind: 'text.delta', attempt: 2, text: 'replacement' });
  });

  it('complete collects the same event engine and rethrows the lossless error', async () => {
    const failure = new GatewayCallError({
      source: 'provider',
      gateway: 'ai',
      providerId: request.model.providerId,
      modelId: request.model.modelId,
      driverId: 'fake-ai',
      stage: 'request',
      attempt: 1,
      traceId: 'trace-1',
      message: 'bad request from provider',
      upstream: {
        status: 400,
        code: 'bad_input',
        type: 'invalid_request_error',
        message: 'bad request from provider',
        requestId: 'req-real',
        body: { error: { message: 'bad request from provider' } },
      },
    });
    const selected = target((): never => {
      throw failure;
    });

    await expect(gatewayWith(selected).complete(request, context())).rejects.toBe(failure);
  });

  it('returns a local reference error instead of selecting a default', async () => {
    const fallbackCalls = vi.fn();
    const fallback: CompiledTarget = {
      ...target(async function* (): AsyncIterable<AiAttemptEvent> {
        fallbackCalls();
        yield { kind: 'response.completed', stopReason: 'end_turn' };
      }),
      ref: { providerId: 'default-provider', modelId: 'default-model' },
    };

    const events = await collect(gatewayWith(fallback).open(request, context()).events);
    expect(fallbackCalls).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      kind: 'response.failed',
      error: { localCode: 'MODEL_TARGET_NOT_FOUND' },
    });
  });

  it('settles statistics when the iterator is returned before its first next', async () => {
    const selected = target(async function* (): AsyncIterable<AiAttemptEvent> {
      yield { kind: 'text.delta', text: 'unread' };
      yield { kind: 'response.completed', stopReason: 'end_turn' };
    });
    const run = gatewayWith(selected).open(request, context());

    await run.events[Symbol.asyncIterator]().return?.();

    await expect(run.statistics).resolves.toEqual({});
  });

  it('settles statistics when an active iterator is returned early', async () => {
    const selected = target(async function* (): AsyncIterable<AiAttemptEvent> {
      yield { kind: 'text.delta', text: 'unread' };
      yield { kind: 'response.completed', stopReason: 'end_turn' };
    });
    const run = gatewayWith(selected).open(request, context());
    const iterator = run.events[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toMatchObject({ kind: 'response.started' });
    await iterator.return?.();

    await expect(run.statistics).resolves.toEqual({});
  });

  it('measures visible latency and generation duration at Gateway boundaries', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    try {
      const selected = target(async function* (): AsyncIterable<AiAttemptEvent> {
        vi.setSystemTime(140);
        yield { kind: 'reasoning.delta', text: 'thought' };
        vi.setSystemTime(200);
        yield { kind: 'response.completed', stopReason: 'end_turn' };
      });
      const run = gatewayWith(selected).open(request, context());

      await collect(run.events);

      await expect(run.statistics).resolves.toEqual({
        firstVisibleContentLatencyMs: 40,
        generationDurationMs: 60,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports visible timing from the successful retry attempt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    try {
      const selected = target(async function* (_request, attemptContext): AsyncIterable<AiAttemptEvent> {
        if (attemptContext.attempt === 1) {
          vi.setSystemTime(120);
          yield { kind: 'text.delta', text: 'partial' };
          vi.setSystemTime(130);
          throw new GatewayCallError({
            source: 'transport',
            gateway: 'ai',
            providerId: request.model.providerId,
            modelId: request.model.modelId,
            driverId: 'fake-ai',
            stage: 'stream',
            attempt: 1,
            traceId: attemptContext.traceId,
            message: 'temporary connection loss',
          });
        }
        vi.setSystemTime(160);
        yield { kind: 'text.delta', text: 'replacement' };
        vi.setSystemTime(200);
        yield { kind: 'response.completed', stopReason: 'end_turn' };
      });
      const run = gatewayWith(selected).open(request, context());

      await collect(run.events);

      await expect(run.statistics).resolves.toEqual({
        firstVisibleContentLatencyMs: 30,
        generationDurationMs: 40,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not manufacture visible timing for a tool-only response', async () => {
    const selected = target(async function* (): AsyncIterable<AiAttemptEvent> {
      yield { kind: 'tool.started', callId: 'call-1', name: 'lookup' };
      yield { kind: 'tool.arguments.delta', callId: 'call-1', delta: '{}' };
      yield { kind: 'tool.completed', callId: 'call-1' };
      yield { kind: 'response.completed', stopReason: 'tool_use' };
    });
    const run = gatewayWith(selected).open(request, context());

    await collect(run.events);

    await expect(run.statistics).resolves.toEqual({});
  });

  it('keeps events unchanged and resolves empty statistics when collection fails', async () => {
    const attempt = vi.spyOn(AIRequestInfoCollector.prototype, 'onAttemptStarted')
      .mockImplementation(() => { throw new Error('attempt statistics failed'); });
    const visible = vi.spyOn(AIRequestInfoCollector.prototype, 'onVisibleContent')
      .mockImplementation(() => { throw new Error('visible statistics failed'); });
    const complete = vi.spyOn(AIRequestInfoCollector.prototype, 'complete')
      .mockImplementation(() => { throw new Error('completion statistics failed'); });
    const selected = target(async function* (): AsyncIterable<AiAttemptEvent> {
      yield { kind: 'text.delta', text: 'still visible' };
      yield { kind: 'response.completed', stopReason: 'end_turn' };
    });

    try {
      const run = gatewayWith(selected).open(request, context());

      await expect(collect(run.events)).resolves.toMatchObject([
        { kind: 'response.started' },
        { kind: 'text.delta', text: 'still visible' },
        { kind: 'response.completed', stopReason: 'end_turn' },
      ]);
      await expect(run.statistics).resolves.toEqual({});
      expect(attempt).toHaveBeenCalledOnce();
      expect(visible).toHaveBeenCalledOnce();
      expect(complete).toHaveBeenCalledOnce();
    } finally {
      attempt.mockRestore();
      visible.mockRestore();
      complete.mockRestore();
    }
  });
});
