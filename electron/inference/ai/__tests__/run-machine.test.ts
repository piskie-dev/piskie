import { describe, expect, it, vi } from 'vitest';
import { GatewayCallError } from '../../execution/call-error.js';
import type { CompiledTarget } from '../../execution/runtime-snapshot.js';
import type { AiAttemptEvent, AiEvent, AiRequest } from '../contracts.js';
import { executeAiRun } from '../run-machine.js';

const request: AiRequest = {
  model: { providerId: 'provider', modelId: 'model' },
  messages: [{ role: 'user', content: [{ kind: 'text', text: 'hello' }] }],
};

const policy = {
  maxAttempts: 1,
  connectTimeoutMs: 1_000,
  streamIdleTimeoutMs: 10,
  retryBaseDelayMs: 1,
};

function target(
  openAttempt: NonNullable<CompiledTarget['ai']>['openAttempt'],
  maxOutputTokens?: number,
): CompiledTarget {
  return {
    ref: request.model,
    driverId: 'controlled-driver',
    upstreamModel: 'wire-model',
    catalogId: 'test/model',
    configRevision: 9,
    ...(maxOutputTokens !== undefined && {
      modelDefinition: {
        id: 'test/model',
        displayName: 'Test Model',
        kind: 'ai',
        lifecycle: 'active',
        compatibleDrivers: ['controlled-driver'],
        inputModalities: ['text'],
        outputModalities: ['text'],
        capabilities: { streaming: true },
        limits: { contextWindow: 200_000, maxOutputTokens },
        source: { kind: 'local', version: '1' },
      },
    }),
    ai: {
      ...(maxOutputTokens !== undefined && {
        generationDefaults: { maxOutputTokens },
      }),
      openAttempt,
    },
  };
}

async function collect(events: AsyncIterable<AiEvent>): Promise<AiEvent[]> {
  const result: AiEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function pendingIterator(
  signal: AbortSignal,
  onNext?: () => void,
): { iterator: AsyncIterator<AiAttemptEvent>; returnSawAbort: () => boolean } {
  let resolveNext: ((result: IteratorResult<AiAttemptEvent>) => void) | undefined;
  let abortedBeforeReturn = false;
  return {
    iterator: {
      next: () => {
        onNext?.();
        return new Promise<IteratorResult<AiAttemptEvent>>((resolve) => {
          resolveNext = resolve;
        });
      },
      return: async () => {
        abortedBeforeReturn = signal.aborted;
        resolveNext?.({ done: true, value: undefined });
        return { done: true, value: undefined };
      },
    },
    returnSawAbort: () => abortedBeforeReturn,
  };
}

describe('executeAiRun cancellation ownership', () => {
  it('aborts the attempt before closing its iterator on idle timeout before the first event', async () => {
    let returnSawAbort = false;
    const selected = target((_request, context) => {
      const controlled = pendingIterator(context.signal);
      returnSawAbort = controlled.returnSawAbort();
      const iterable: AsyncIterable<AiAttemptEvent> = {
        [Symbol.asyncIterator]: () => ({
          ...controlled.iterator,
          return: async () => {
            const result = await controlled.iterator.return!();
            returnSawAbort = controlled.returnSawAbort();
            return result;
          },
        }),
      };
      return iterable;
    });

    const events = await collect(executeAiRun({
      request,
      context: {
        runId: 'run-timeout',
        traceId: 'trace-timeout',
        signal: new AbortController().signal,
      },
      target: selected,
      policy,
    }));

    expect(returnSawAbort).toBe(true);
    expect(events.map((event) => event.kind)).toEqual(['response.started', 'response.failed']);
    expect(events.at(-1)).toMatchObject({
      kind: 'response.failed',
      error: { source: 'timeout', stage: 'stream_idle', localCode: 'AI_STREAM_IDLE_TIMEOUT' },
    });
  });

  it('cancels after visible output even when iterator.next ignores the signal', async () => {
    const controller = new AbortController();
    let notifyNext: (() => void) | undefined;
    const nextStarted = new Promise<void>((resolve) => {
      notifyNext = resolve;
    });
    let returnSawAbort = false;
    const selected = target((_request, context) => {
      const controlled = pendingIterator(context.signal, notifyNext);
      let reads = 0;
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            reads++;
            if (reads === 1) {
              return Promise.resolve<IteratorResult<AiAttemptEvent>>({
                done: false,
                value: { kind: 'text.delta', text: 'visible' },
              });
            }
            return controlled.iterator.next();
          },
          return: async () => {
            const result = await controlled.iterator.return!();
            returnSawAbort = controlled.returnSawAbort();
            return result;
          },
        }),
      };
    });
    const eventsPromise = collect(executeAiRun({
      request,
      context: { runId: 'run-cancel', traceId: 'trace-cancel', signal: controller.signal },
      target: selected,
      policy: { ...policy, streamIdleTimeoutMs: 60_000 },
    }));

    await nextStarted;
    controller.abort('cancel from caller');
    const events = await eventsPromise;

    expect(returnSawAbort).toBe(true);
    expect(events.map((event) => event.kind)).toEqual([
      'response.started',
      'text.delta',
      'response.cancelled',
    ]);
    expect(events.at(-1)).toMatchObject({ kind: 'response.cancelled', reason: 'cancel from caller' });
  });

  it('retries an idle timeout after visible output with the same request', async () => {
    let attempts = 0;
    let returnSawAbort = false;
    const requests: AiRequest[] = [];
    const selected = target((attemptRequest, context) => {
      attempts++;
      requests.push(attemptRequest);
      if (context.attempt === 2) {
        return (async function* (): AsyncIterable<AiAttemptEvent> {
          yield { kind: 'text.delta', text: 'replacement' };
          yield { kind: 'response.completed', stopReason: 'end_turn' };
        })();
      }
      const controlled = pendingIterator(context.signal);
      let reads = 0;
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            reads++;
            if (reads === 1) {
              return Promise.resolve<IteratorResult<AiAttemptEvent>>({
                done: false,
                value: { kind: 'text.delta', text: 'visible' },
              });
            }
            return controlled.iterator.next();
          },
          return: async () => {
            const result = await controlled.iterator.return!();
            returnSawAbort = controlled.returnSawAbort();
            return result;
          },
        }),
      };
    });

    const events = await collect(executeAiRun({
      request,
      context: {
        runId: 'run-idle-timeout',
        traceId: 'trace-idle-timeout',
        signal: new AbortController().signal,
      },
      target: selected,
      policy: { ...policy, maxAttempts: 3 },
    }));

    expect(attempts).toBe(2);
    expect(requests[1]).toBe(requests[0]);
    expect(returnSawAbort).toBe(true);
    expect(events.map((event) => event.kind)).toEqual([
      'response.started',
      'text.delta',
      'response.retrying',
      'text.delta',
      'response.completed',
    ]);
    expect(events[2]).toMatchObject({
      kind: 'response.retrying',
      error: { source: 'timeout', stage: 'stream_idle', localCode: 'AI_STREAM_IDLE_TIMEOUT' },
    });
    expect(events[3]).toMatchObject({ kind: 'text.delta', attempt: 2, text: 'replacement' });
  });

  it.each([
    {
      label: 'reasoning',
      event: { kind: 'reasoning.delta', text: 'partial thought' } satisfies AiAttemptEvent,
    },
    {
      label: 'tool call',
      event: {
        kind: 'tool.started',
        callId: 'call-partial',
        name: 'lookup',
      } satisfies AiAttemptEvent,
    },
  ])('retries a transport failure after a $label event', async ({ event }) => {
    const selected = target(async function* (_request, context): AsyncIterable<AiAttemptEvent> {
      if (context.attempt === 1) {
        yield event;
        throw new GatewayCallError({
          source: 'transport',
          gateway: 'ai',
          providerId: request.model.providerId,
          modelId: request.model.modelId,
          driverId: 'controlled-driver',
          stage: 'stream',
          attempt: context.attempt,
          traceId: context.traceId,
          message: 'temporary connection loss',
        });
      }
      yield { kind: 'text.delta', text: 'answer' };
      yield { kind: 'response.completed', stopReason: 'end_turn' };
    });

    const events = await collect(executeAiRun({
      request,
      context: {
        runId: 'run-stream-retry',
        traceId: 'trace-stream-retry',
        signal: new AbortController().signal,
      },
      target: selected,
      policy: { ...policy, maxAttempts: 2 },
      dependencies: { sleep: async () => undefined },
    }));

    expect(events.map((item) => item.kind)).toEqual([
      'response.started',
      event.kind,
      'response.retrying',
      'text.delta',
      'response.completed',
    ]);
    expect(events.at(-1)).toMatchObject({ kind: 'response.completed', attempt: 2 });
  });

  it('emits one final failure after visible attempts are exhausted', async () => {
    let attempts = 0;
    const selected = target(async function* (_request, context): AsyncIterable<AiAttemptEvent> {
      attempts++;
      yield { kind: 'text.delta', text: `partial ${context.attempt}` };
      throw new GatewayCallError({
        source: 'transport',
        gateway: 'ai',
        providerId: request.model.providerId,
        modelId: request.model.modelId,
        driverId: 'controlled-driver',
        stage: 'stream',
        attempt: context.attempt,
        traceId: context.traceId,
        message: 'temporary connection loss',
      });
    });

    const events = await collect(executeAiRun({
      request,
      context: {
        runId: 'run-exhausted',
        traceId: 'trace-exhausted',
        signal: new AbortController().signal,
      },
      target: selected,
      policy: { ...policy, maxAttempts: 2 },
      dependencies: { sleep: async () => undefined },
    }));

    expect(attempts).toBe(2);
    expect(events.map((event) => event.kind)).toEqual([
      'response.started',
      'text.delta',
      'response.retrying',
      'text.delta',
      'response.failed',
    ]);
    expect(events.filter((event) => event.kind === 'response.failed')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ kind: 'response.failed', attempt: 2 });
  });
});

describe('executeAiRun provider retry policy', () => {
  it('retries a structured stream read error without an HTTP status', async () => {
    let attempts = 0;
    const selected = target(async function* (_request, context): AsyncIterable<AiAttemptEvent> {
      attempts++;
      if (context.attempt === 1) {
        throw new GatewayCallError({
          source: 'provider',
          gateway: 'ai',
          providerId: request.model.providerId,
          modelId: request.model.modelId,
          driverId: 'openai',
          stage: 'request',
          attempt: context.attempt,
          traceId: context.traceId,
          message: 'stream_read_error',
          upstream: {
            code: 'stream_read_error',
            type: 'upstream_error',
            message: 'stream_read_error',
          },
        });
      }
      yield { kind: 'text.delta', text: 'answer' };
      yield { kind: 'response.completed', stopReason: 'end_turn' };
    });

    const events = await collect(executeAiRun({
      request,
      context: {
        runId: 'run-provider-stream-read',
        traceId: 'trace-provider-stream-read',
        signal: new AbortController().signal,
      },
      target: selected,
      policy: { ...policy, maxAttempts: 2 },
      dependencies: { sleep: async () => undefined },
    }));

    expect(attempts).toBe(2);
    expect(events.map((event) => event.kind)).toEqual([
      'response.started',
      'response.retrying',
      'text.delta',
      'response.completed',
    ]);
    expect(events[1]).toMatchObject({
      kind: 'response.retrying',
      attempt: 1,
      error: { upstream: { code: 'stream_read_error' } },
    });
    expect(events.at(-1)).toMatchObject({ kind: 'response.completed', attempt: 2 });
  });
});

describe('executeAiRun bounded upstream retries', () => {
  it.each([
    { code: 'upstream_stream_read_error' },
    { code: 'sample_unknown_error' },
    { code: 'sample_unknown_error', status: 400 },
  ])('retries %j and preserves structured diagnostics', async (upstream) => {
    let attempts = 0;
    const error = new GatewayCallError({
      source: 'provider', gateway: 'ai', ...request.model,
      driverId: 'controlled-driver', stage: 'request', attempt: 1, traceId: 'trace-retry',
      message: 'Sample upstream interruption',
      upstream: { ...upstream, message: 'Sample upstream interruption', requestId: 'sample-request', body: { error: upstream } },
    });
    const selected = target(async function* (): AsyncIterable<AiAttemptEvent> {
      attempts++;
      if (attempts === 1) throw error;
      yield { kind: 'text.delta', text: 'answer' };
      yield { kind: 'response.completed', stopReason: 'end_turn' };
    });
    const sleep = vi.fn(async (_delayMs: number, _signal: AbortSignal) => undefined);
    const events = await collect(executeAiRun({
      request, target: selected, policy: { ...policy, maxAttempts: 3, retryBaseDelayMs: 3_000 },
      context: { runId: 'run-retry', traceId: 'trace-retry', signal: new AbortController().signal },
      dependencies: { sleep },
    }));
    expect(attempts).toBe(2);
    expect(sleep).toHaveBeenCalledWith(3_000, expect.any(AbortSignal));
    expect(events.map((event) => event.kind)).toEqual(['response.started', 'response.retrying', 'text.delta', 'response.completed']);
    expect(events[1]).toMatchObject({ error });
    expect(events.at(-1)).toMatchObject({ attempt: 2, result: { text: 'answer' } });
  });

  it('exhausts the same budget for repeated statusless stream interruptions', async () => {
    const attempts: number[] = [];
    const selected = target((_request, context): never => {
      attempts.push(context.attempt);
      throw new GatewayCallError({
        source: 'provider', gateway: 'ai', ...request.model,
        driverId: 'controlled-driver', stage: 'request', attempt: context.attempt, traceId: context.traceId,
        message: 'Sample upstream interruption',
        upstream: { code: 'upstream_stream_read_error', message: 'Sample upstream interruption' },
      });
    });
    const sleep = vi.fn(async (_delayMs: number, _signal: AbortSignal) => undefined);
    const events = await collect(executeAiRun({
      request, target: selected, policy: { ...policy, maxAttempts: 3, retryBaseDelayMs: 3_000 },
      context: { runId: 'run-exhausted', traceId: 'trace-exhausted', signal: new AbortController().signal },
      dependencies: { sleep },
    }));
    expect(attempts).toEqual([1, 2, 3]);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([3_000, 6_000]);
    expect(events.map((event) => event.kind)).toEqual(['response.started', 'response.retrying', 'response.retrying', 'response.failed']);
    expect(events.at(-1)).toMatchObject({ attempt: 3, error: { attempt: 3, upstream: { code: 'upstream_stream_read_error' } } });
  });

  it.each([
    { status: 401 },
    { status: 403 },
    { type: 'authentication_error' },
    { type: 'permission_error' },
    { code: 'context_length_exceeded', status: 429 },
  ])('stops after one attempt for %j', async (upstream) => {
    const openAttempt = vi.fn((): never => {
      throw new GatewayCallError({
        source: 'provider', gateway: 'ai', ...request.model,
        driverId: 'controlled-driver', stage: 'request', attempt: 1, traceId: 'trace-stop',
        message: 'Sample failure', upstream: { message: 'Sample failure', ...upstream },
      });
    });
    const events = await collect(executeAiRun({
      request, target: target(openAttempt), policy: { ...policy, maxAttempts: 3 },
      context: { runId: 'run-stop', traceId: 'trace-stop', signal: new AbortController().signal },
    }));
    expect(openAttempt).toHaveBeenCalledOnce();
    expect(events.map((event) => event.kind)).toEqual(['response.started', 'response.failed']);
  });

  it('stops for an unwrapped local programming error', async () => {
    const openAttempt = vi.fn((): never => { throw new TypeError('Sample local defect'); });
    const events = await collect(executeAiRun({
      request, target: target(openAttempt), policy: { ...policy, maxAttempts: 3 },
      context: { runId: 'run-local', traceId: 'trace-local', signal: new AbortController().signal },
    }));
    expect(openAttempt).toHaveBeenCalledOnce();
    expect(events.at(-1)).toMatchObject({ kind: 'response.failed', error: { source: 'local', localCode: 'UNWRAPPED_DRIVER_ERROR' } });
  });

  it('cancels during backoff without opening another request', async () => {
    const controller = new AbortController();
    const openAttempt = vi.fn(async function* (): AsyncIterable<AiAttemptEvent> {
      yield { kind: 'response.completed', stopReason: 'other' };
    });
    const iterator = executeAiRun({
      request, target: target(openAttempt), policy: { ...policy, maxAttempts: 3, retryBaseDelayMs: 60_000 },
      context: { runId: 'run-cancel-backoff', traceId: 'trace-cancel-backoff', signal: controller.signal },
    })[Symbol.asyncIterator]();
    expect((await iterator.next()).value.kind).toBe('response.started');
    expect((await iterator.next()).value.kind).toBe('response.retrying');
    const waiting = iterator.next();
    controller.abort('Sample cancellation');
    expect((await waiting).value).toMatchObject({ kind: 'response.cancelled', reason: 'Sample cancellation' });
    expect((await iterator.next()).done).toBe(true);
    expect(openAttempt).toHaveBeenCalledOnce();
  });

  it('does not open another request when the deadline expires in backoff', async () => {
    let now = 0;
    const openAttempt = vi.fn(async function* (): AsyncIterable<AiAttemptEvent> {
      yield { kind: 'response.completed', stopReason: 'other' };
    });
    const events = await collect(executeAiRun({
      request, target: target(openAttempt), policy: { ...policy, maxAttempts: 3 },
      context: { runId: 'run-deadline', traceId: 'trace-deadline', signal: new AbortController().signal, deadlineAt: 10 },
      dependencies: { now: () => now, sleep: async () => { now = 10; } },
    }));
    expect(openAttempt).toHaveBeenCalledOnce();
    expect(events.map((event) => event.kind)).toEqual(['response.started', 'response.retrying', 'response.failed']);
    expect(events.at(-1)).toMatchObject({ error: { source: 'timeout', stage: 'absolute_deadline' } });
  });
});

describe('executeAiRun empty results', () => {
  it('validates before publishing success and clears usage from the empty attempt', async () => {
    const selected = target(async function* (_request, context): AsyncIterable<AiAttemptEvent> {
      if (context.attempt === 1) {
        yield { kind: 'text.delta', text: '' };
        yield { kind: 'reasoning.delta', text: '' };
        yield { kind: 'reasoning.signature', signature: 'sample-signature' };
        yield { kind: 'usage.updated', usage: { totalInputTokens: 50, totalOutputTokens: 0 } };
      } else {
        yield { kind: 'text.delta', text: 'answer' };
      }
      yield { kind: 'response.completed', stopReason: 'end_turn' };
    });
    const events = await collect(executeAiRun({
      request, target: selected, policy: { ...policy, maxAttempts: 3 },
      context: { runId: 'run-empty', traceId: 'trace-empty', signal: new AbortController().signal },
      dependencies: { sleep: async () => undefined },
    }));
    expect(events.filter((event) => event.kind === 'response.completed')).toEqual([
      expect.objectContaining({ attempt: 2, result: expect.objectContaining({ text: 'answer', usage: {} }) }),
    ]);
    expect(events.find((event) => event.kind === 'response.retrying')).toMatchObject({
      error: { source: 'provider', stage: 'result', localCode: 'AI_RESULT_EMPTY', attempt: 1, upstream: { stopReason: 'end_turn' } },
    });
    const completed = events.at(-1);
    if (completed?.kind !== 'response.completed') throw new Error('Missing completion');
    expect(completed.result.reasoningSignature).toBeUndefined();
  });

  it.each(['end_turn', 'other', 'content_filter', 'max_tokens'] as const)('fails after three empty attempts and preserves %s', async (stopReason) => {
    const openAttempt = vi.fn(async function* (): AsyncIterable<AiAttemptEvent> {
      yield { kind: 'response.completed', stopReason };
    });
    const events = await collect(executeAiRun({
      request, target: target(openAttempt), policy: { ...policy, maxAttempts: 3 },
      context: { runId: 'run-empty', traceId: 'trace-empty', signal: new AbortController().signal },
      dependencies: { sleep: async () => undefined },
    }));
    expect(openAttempt).toHaveBeenCalledTimes(3);
    expect(events.map((event) => event.kind)).toEqual(['response.started', 'response.retrying', 'response.retrying', 'response.failed']);
    const failed = events.at(-1);
    if (failed?.kind !== 'response.failed') throw new Error('Missing failure');
    expect(failed.error.toJSON()).toMatchObject({
      source: 'provider', stage: 'result', localCode: 'AI_RESULT_EMPTY', attempt: 3,
      driverId: 'controlled-driver', traceId: 'trace-empty', upstream: { stopReason },
    });
    expect(failed.error.message).toBe('AI returned empty response (no text, reasoning, or tool calls)');
  });

  it('does not reuse partial content to validate a subsequent empty attempt', async () => {
    const selected = target(async function* (_request, context): AsyncIterable<AiAttemptEvent> {
      if (context.attempt === 1) {
        yield { kind: 'text.delta', text: 'partial' };
        throw new GatewayCallError({
          source: 'transport', gateway: 'ai', ...request.model,
          driverId: 'controlled-driver', stage: 'stream', attempt: 1, traceId: context.traceId,
          message: 'Sample interruption',
        });
      }
      yield { kind: 'response.completed', stopReason: 'other' };
    });
    const events = await collect(executeAiRun({
      request, target: selected, policy: { ...policy, maxAttempts: 3 },
      context: { runId: 'run-mixed', traceId: 'trace-mixed', signal: new AbortController().signal },
      dependencies: { sleep: async () => undefined },
    }));
    expect(events.map((event) => event.kind)).toEqual(['response.started', 'text.delta', 'response.retrying', 'response.retrying', 'response.failed']);
    expect(events.at(-1)).toMatchObject({ attempt: 3, error: { attempt: 3, localCode: 'AI_RESULT_EMPTY' } });
  });
});

describe('executeAiRun compiled model defaults', () => {
  it('adds the catalog output limit without replacing explicit generation fields', async () => {
    let received: AiRequest | undefined;
    const selected = target(async function* (attemptRequest): AsyncIterable<AiAttemptEvent> {
      received = attemptRequest;
      yield { kind: 'text.delta', text: 'answer' };
      yield { kind: 'response.completed', stopReason: 'end_turn' };
    }, 64_000);
    const configuredRequest: AiRequest = {
      ...request,
      generation: {
        temperature: 0.25,
        topP: 0.8,
        stop: ['DONE'],
        reasoning: { kind: 'effort', effort: 'high' },
      },
    };

    await collect(executeAiRun({
      request: configuredRequest,
      context: { runId: 'run-defaults', traceId: 'trace-defaults', signal: new AbortController().signal },
      target: selected,
      policy,
    }));

    expect(received?.generation).toEqual({
      maxOutputTokens: 64_000,
      temperature: 0.25,
      topP: 0.8,
      stop: ['DONE'],
      reasoning: { kind: 'effort', effort: 'high' },
    });
    expect(configuredRequest.generation).not.toHaveProperty('maxOutputTokens');
  });

  it('keeps an explicit request limit and treats max_tokens as a terminal provider result', async () => {
    let attempts = 0;
    let received: AiRequest | undefined;
    const selected = target(async function* (attemptRequest): AsyncIterable<AiAttemptEvent> {
      attempts++;
      received = attemptRequest;
      yield { kind: 'text.delta', text: 'provider result before its limit' };
      yield { kind: 'response.completed', stopReason: 'max_tokens' };
    }, 64_000);

    const events = await collect(executeAiRun({
      request: { ...request, generation: { maxOutputTokens: 128 } },
      context: { runId: 'run-explicit', traceId: 'trace-explicit', signal: new AbortController().signal },
      target: selected,
      policy: { ...policy, maxAttempts: 3 },
    }));

    expect(received?.generation?.maxOutputTokens).toBe(128);
    expect(attempts).toBe(1);
    expect(events.at(-1)).toMatchObject({ kind: 'response.completed', stopReason: 'max_tokens' });
  });
});
