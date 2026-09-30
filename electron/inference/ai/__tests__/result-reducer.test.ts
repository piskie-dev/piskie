import { describe, expect, it } from 'vitest';
import { GatewayCallError } from '../../execution/call-error.js';
import type { ModelTarget } from '../../execution/contracts.js';
import type { AiAttemptEvent, AiEvent, AiResult } from '../contracts.js';
import { collectAiResult } from '../result-reducer.js';
import { executeAiRun } from '../run-machine.js';

const model: ModelTarget = { providerId: 'provider', modelId: 'model' };

function retryError(attempt: number): GatewayCallError {
  return new GatewayCallError({
    source: 'transport',
    gateway: 'ai',
    providerId: model.providerId,
    modelId: model.modelId,
    driverId: 'test-driver',
    stage: 'stream',
    attempt,
    traceId: 'trace-result',
    message: 'temporary connection loss',
  });
}

function attemptStream(attempts: readonly (readonly (AiAttemptEvent | GatewayCallError)[])[]): AsyncIterable<AiEvent> {
  return executeAiRun({
    request: { model, messages: [] },
    context: { runId: 'run-result', traceId: 'trace-result', signal: new AbortController().signal },
    target: {
      ref: model,
      configRevision: 7,
      driverId: 'test-driver',
      upstreamModel: 'wire-model',
      catalogId: 'test/model',
      ai: {
        openAttempt: async function* (_request, context) {
          for (const event of attempts[context.attempt - 1]!) {
            if (event instanceof GatewayCallError) throw event;
            yield event;
          }
        },
      },
    },
    policy: { maxAttempts: attempts.length, connectTimeoutMs: 1_000, streamIdleTimeoutMs: 1_000, retryBaseDelayMs: 1 },
    dependencies: { sleep: async () => undefined },
  });
}

async function* eventStream(events: readonly AiEvent[]): AsyncIterable<AiEvent> {
  yield* events;
}

const base = { runId: 'run-result', sequence: 1, attempt: 1, emittedAt: 1 };

describe('AI attempt result isolation', () => {
  it('returns only the complete successful attempt', async () => {
    const events = attemptStream([
      [
        { kind: 'text.delta', text: 'stale answer' },
        { kind: 'reasoning.delta', text: 'stale thought' },
        { kind: 'reasoning.signature', signature: 'stale-signature' },
        {
          kind: 'reasoning.item',
          item: {
            protocol: 'openai-responses',
            id: 'reasoning-stale',
            summary: [{ type: 'summary_text', text: 'stale summary' }],
          },
        },
        { kind: 'tool.started', callId: 'call-stale', name: 'lookup', providerItemId: 'item-stale', status: 'in_progress' },
        { kind: 'tool.arguments.delta', callId: 'call-stale', delta: '{"value":' },
        { kind: 'usage.updated', usage: { totalInputTokens: 100, totalOutputTokens: 40, cachedInputTokens: 20 } },
        retryError(1),
      ],
      [
        { kind: 'reasoning.delta', text: 'fresh thought' },
        { kind: 'reasoning.signature', signature: 'fresh-signature' },
        { kind: 'text.delta', text: 'fresh answer' },
        { kind: 'tool.started', callId: 'call-fresh', name: 'lookup', providerItemId: 'item-fresh', status: 'in_progress' },
        { kind: 'tool.arguments.delta', callId: 'call-fresh', delta: '{"value":2}' },
        { kind: 'tool.completed', callId: 'call-fresh' },
        { kind: 'usage.updated', usage: { totalInputTokens: 7, totalOutputTokens: 3 } },
        { kind: 'response.completed', stopReason: 'tool_use' },
      ],
    ]);

    const result = await collectAiResult(events, model, 'trace-result');

    expect(result).toMatchObject({
      runId: 'run-result',
      model,
      configRevision: 7,
      text: 'fresh answer',
      reasoning: 'fresh thought',
      reasoningSignature: 'fresh-signature',
      usage: { totalInputTokens: 7, totalOutputTokens: 3 },
      stopReason: 'tool_use',
    });
    expect(result.reasoningItems).toEqual([{
      protocol: 'anthropic-thinking',
      text: 'fresh thought',
      signature: 'fresh-signature',
    }]);
    expect(result.content).toEqual([
      { kind: 'reasoning', item: { protocol: 'anthropic-thinking', text: 'fresh thought', signature: 'fresh-signature' } },
      { kind: 'text', text: 'fresh answer' },
      { kind: 'tool_call', callId: 'call-fresh', name: 'lookup', arguments: '{"value":2}', providerItemId: 'item-fresh', status: 'completed' },
    ]);
    expect(result.toolCalls).toEqual([{
      callId: 'call-fresh',
      name: 'lookup',
      argumentsText: '{"value":2}',
      arguments: { value: 2 },
      providerItemId: 'item-fresh',
      status: 'completed',
    }]);
    expect(JSON.stringify(result)).not.toContain('stale');
  });

  it('rebuilds the accumulator for every retry', async () => {
    const events = attemptStream([
      [{ kind: 'text.delta', text: 'attempt one' }, retryError(1)],
      [{ kind: 'text.delta', text: 'attempt two' }, { kind: 'usage.updated', usage: { totalOutputTokens: 9 } }, retryError(2)],
      [{ kind: 'text.delta', text: 'attempt three' }, { kind: 'response.completed', stopReason: 'end_turn' }],
    ]);

    const result = await collectAiResult(events, model, 'trace-result');

    expect(result.text).toBe('attempt three');
    expect(result.content).toEqual([{ kind: 'text', text: 'attempt three' }]);
    expect(result.usage).toEqual({});
  });

  it.each([
    { label: 'text', event: { kind: 'text.delta', text: 'Answer.' } },
    { label: 'reasoning', event: { kind: 'reasoning.delta', text: 'A private reasoning trace.' } },
    { label: 'opaque reasoning', event: { kind: 'reasoning.item', item: { protocol: 'anthropic-redacted', data: 'opaque-state' } } },
    { label: 'tool call', event: { kind: 'tool.started', callId: 'call-1', name: 'lookup' } },
  ] satisfies Array<{ label: string; event: AiAttemptEvent }>)('accepts a $label-only completed attempt', async ({ event }) => {
    const events = attemptStream([[event, { kind: 'response.completed', stopReason: 'end_turn' }]]);
    const result = await collectAiResult(events, model, 'trace-result');
    expect(result.content).toHaveLength(1);
    if (event.kind === 'reasoning.delta') {
      expect(result.content).toEqual([{
        kind: 'reasoning', item: { protocol: 'openai-chat', text: event.text },
      }]);
    }
  });
});

describe('collectAiResult', () => {
  it('returns the validated completion result without aggregating the public deltas again', async () => {
    const result: AiResult = {
      runId: base.runId, model, configRevision: 7,
      text: 'Answer.', reasoning: '', reasoningItems: [], toolCalls: [], usage: {},
      content: [{ kind: 'text', text: 'Answer.' }], stopReason: 'end_turn',
    };
    const events = eventStream([
      { ...base, kind: 'response.completed', stopReason: result.stopReason, result },
    ]);
    await expect(collectAiResult(events, model, 'trace-result')).resolves.toBe(result);
  });

  it('rejects a stream that ends without a completed attempt', async () => {
    const events = eventStream([
      { ...base, kind: 'text.delta', text: 'partial one' },
      { ...base, sequence: 2, kind: 'response.retrying', retryAt: 100, error: retryError(1) },
      { ...base, sequence: 3, attempt: 2, kind: 'text.delta', text: 'partial two' },
    ]);
    await expect(collectAiResult(events, model, 'trace-result')).rejects.toMatchObject({
      source: 'local', localCode: 'AI_RESULT_INCOMPLETE', attempt: 2,
    });
  });

  it('preserves the final failure object', async () => {
    const error = retryError(3);
    const events = eventStream([{ ...base, attempt: 3, kind: 'response.failed', error }]);
    await expect(collectAiResult(events, model, 'trace-result')).rejects.toBe(error);
  });

  it('preserves cancellation and the actual attempt', async () => {
    const events = eventStream([{ ...base, attempt: 2, kind: 'response.cancelled', reason: 'Sample cancellation' }]);
    await expect(collectAiResult(events, model, 'trace-result')).rejects.toMatchObject({
      source: 'cancelled', attempt: 2, message: 'Sample cancellation',
    });
  });
});
