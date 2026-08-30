import { describe, expect, it } from 'vitest';
import { GatewayCallError } from '../../execution/call-error.js';
import type { ModelTarget } from '../../execution/contracts.js';
import type { AiEvent } from '../contracts.js';
import { collectAiResult } from '../result-reducer.js';

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

async function* eventStream(events: readonly AiEvent[]): AsyncIterable<AiEvent> {
  yield* events;
}

function baseFactory() {
  let sequence = 0;
  return (attempt: number) => ({
    runId: 'run-result',
    sequence: ++sequence,
    attempt,
    emittedAt: sequence,
  });
}

describe('collectAiResult attempt isolation', () => {
  it('returns only the complete successful attempt', async () => {
    const base = baseFactory();
    const events = [
      {
        ...base(1),
        kind: 'response.started',
        model,
        configRevision: 7,
      },
      { ...base(1), kind: 'text.delta', text: 'stale answer' },
      { ...base(1), kind: 'reasoning.delta', text: 'stale thought' },
      { ...base(1), kind: 'reasoning.signature', signature: 'stale-signature' },
      {
        ...base(1),
        kind: 'reasoning.item',
        item: {
          protocol: 'openai-responses',
          id: 'reasoning-stale',
          summary: [{ type: 'summary_text', text: 'stale summary' }],
        },
      },
      {
        ...base(1),
        kind: 'tool.started',
        callId: 'call-stale',
        name: 'lookup',
        providerItemId: 'item-stale',
        status: 'in_progress',
      },
      {
        ...base(1),
        kind: 'tool.arguments.delta',
        callId: 'call-stale',
        delta: '{"value":',
      },
      {
        ...base(1),
        kind: 'usage.updated',
        usage: { totalInputTokens: 100, totalOutputTokens: 40, cachedInputTokens: 20 },
      },
      { ...base(1), kind: 'response.retrying', retryAt: 100, error: retryError(1) },
      { ...base(2), kind: 'reasoning.delta', text: 'fresh thought' },
      { ...base(2), kind: 'reasoning.signature', signature: 'fresh-signature' },
      { ...base(2), kind: 'text.delta', text: 'fresh answer' },
      {
        ...base(2),
        kind: 'tool.started',
        callId: 'call-fresh',
        name: 'lookup',
        providerItemId: 'item-fresh',
        status: 'in_progress',
      },
      {
        ...base(2),
        kind: 'tool.arguments.delta',
        callId: 'call-fresh',
        delta: '{"value":2}',
      },
      { ...base(2), kind: 'tool.completed', callId: 'call-fresh' },
      {
        ...base(2),
        kind: 'usage.updated',
        usage: { totalInputTokens: 7, totalOutputTokens: 3 },
      },
      { ...base(2), kind: 'response.completed', stopReason: 'tool_use' },
    ] satisfies AiEvent[];

    const result = await collectAiResult(eventStream(events), model, 'trace-result');

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
      {
        kind: 'reasoning',
        item: {
          protocol: 'anthropic-thinking',
          text: 'fresh thought',
          signature: 'fresh-signature',
        },
      },
      { kind: 'text', text: 'fresh answer' },
      {
        kind: 'tool_call',
        callId: 'call-fresh',
        name: 'lookup',
        arguments: '{"value":2}',
        providerItemId: 'item-fresh',
        status: 'completed',
      },
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
    const base = baseFactory();
    const events = [
      { ...base(1), kind: 'response.started', model, configRevision: 7 },
      { ...base(1), kind: 'text.delta', text: 'attempt one' },
      { ...base(1), kind: 'response.retrying', retryAt: 100, error: retryError(1) },
      { ...base(2), kind: 'text.delta', text: 'attempt two' },
      { ...base(2), kind: 'usage.updated', usage: { totalOutputTokens: 9 } },
      { ...base(2), kind: 'response.retrying', retryAt: 200, error: retryError(2) },
      { ...base(3), kind: 'text.delta', text: 'attempt three' },
      { ...base(3), kind: 'response.completed', stopReason: 'end_turn' },
    ] satisfies AiEvent[];

    const result = await collectAiResult(eventStream(events), model, 'trace-result');

    expect(result.text).toBe('attempt three');
    expect(result.content).toEqual([{ kind: 'text', text: 'attempt three' }]);
    expect(result.usage).toEqual({});
  });

  it('rejects a stream that ends without a completed attempt', async () => {
    const base = baseFactory();
    const events = [
      { ...base(1), kind: 'response.started', model, configRevision: 7 },
      { ...base(1), kind: 'text.delta', text: 'partial one' },
      { ...base(1), kind: 'response.retrying', retryAt: 100, error: retryError(1) },
      { ...base(2), kind: 'text.delta', text: 'partial two' },
    ] satisfies AiEvent[];

    await expect(collectAiResult(eventStream(events), model, 'trace-result')).rejects.toMatchObject({
      source: 'local',
      localCode: 'AI_RESULT_INCOMPLETE',
    });
  });
});
