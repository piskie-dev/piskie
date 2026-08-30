import { describe, expect, it } from 'vitest';
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

describe('executeAiRun compiled model defaults', () => {
  it('adds the catalog output limit without replacing explicit generation fields', async () => {
    let received: AiRequest | undefined;
    const selected = target(async function* (attemptRequest): AsyncIterable<AiAttemptEvent> {
      received = attemptRequest;
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
