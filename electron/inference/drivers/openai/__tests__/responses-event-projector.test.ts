import type OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import type { AiAttemptEvent } from '../../../ai/contracts.js';
import {
  OpenAiResponsesStreamError,
  projectOpenAiResponsesStream,
} from '../responses-event-projector.js';

async function* stream(events: readonly unknown[]): AsyncIterable<OpenAI.Responses.ResponseStreamEvent> {
  for (const event of events) yield event as OpenAI.Responses.ResponseStreamEvent;
}

async function collect(events: AsyncIterable<AiAttemptEvent>): Promise<AiAttemptEvent[]> {
  const result: AiAttemptEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe('OpenAI Responses event projector', () => {
  it('projects display deltas while retaining the complete opaque reasoning item', async () => {
    const reasoning = {
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: 'Inspect the page.' }],
      encrypted_content: 'encrypted-state',
      status: 'completed',
    };
    const startedCall = {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'inspect',
      arguments: '',
      status: 'in_progress',
    };
    const completedCall = { ...startedCall, arguments: '{"id":"42"}', status: 'completed' };
    const events = await collect(projectOpenAiResponsesStream(stream([
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_1',
        output_index: 0,
        summary_index: 0,
        sequence_number: 1,
        delta: 'Inspect the page.',
      },
      { type: 'response.output_item.done', output_index: 0, sequence_number: 2, item: reasoning },
      { type: 'response.output_item.added', output_index: 1, sequence_number: 3, item: startedCall },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        output_index: 1,
        sequence_number: 4,
        delta: '{"id"',
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        output_index: 1,
        sequence_number: 5,
        delta: ':"42"}',
      },
      { type: 'response.output_item.done', output_index: 1, sequence_number: 6, item: completedCall },
      {
        type: 'response.completed',
        sequence_number: 7,
        response: {
          output: [],
          usage: {
            input_tokens: 12,
            output_tokens: 8,
            total_tokens: 20,
            input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
            output_tokens_details: { reasoning_tokens: 5 },
          },
          incomplete_details: null,
        },
      },
    ])));

    expect(events).toEqual([
      { kind: 'reasoning.delta', text: 'Inspect the page.' },
      {
        kind: 'reasoning.item',
        item: {
          protocol: 'openai-responses',
          id: 'rs_1',
          summary: [{ type: 'summary_text', text: 'Inspect the page.' }],
          encryptedContent: 'encrypted-state',
          status: 'completed',
        },
      },
      {
        kind: 'tool.started',
        callId: 'call_1',
        name: 'inspect',
        providerItemId: 'fc_1',
        status: 'in_progress',
      },
      { kind: 'tool.arguments.delta', callId: 'call_1', delta: '{"id"' },
      { kind: 'tool.arguments.delta', callId: 'call_1', delta: ':"42"}' },
      { kind: 'tool.completed', callId: 'call_1' },
      {
        kind: 'usage.updated',
        usage: {
          // OpenAI 的 cached_tokens 是 input_tokens 的明细，归一化后不得再加
          totalInputTokens: 12,
          totalOutputTokens: 8,
          cachedInputTokens: 3,
          cacheWriteTokens: 2,
          reasoningTokens: 5,
        },
      },
      { kind: 'response.completed', stopReason: 'tool_use' },
    ]);
  });

  it.each([
    {
      name: 'response.failed',
      event: {
        type: 'response.failed',
        sequence_number: 7,
        response: {
          error: {
            code: 'context_length_exceeded',
            message: 'Your input exceeds the context window of this model.',
          },
        },
      },
      expected: {
        eventType: 'response.failed',
        code: 'context_length_exceeded',
        param: undefined,
        message: 'Your input exceeds the context window of this model.',
      },
    },
    {
      name: 'error',
      event: {
        type: 'error',
        sequence_number: 8,
        code: 'invalid_prompt',
        message: 'Provider rejected the prompt.',
        param: 'input',
      },
      expected: {
        eventType: 'error',
        code: 'invalid_prompt',
        param: 'input',
        message: 'Provider rejected the prompt.',
      },
    },
  ])('preserves structured $name events', async ({ event, expected }) => {
    let failure: unknown;
    try {
      await collect(projectOpenAiResponsesStream(stream([event])));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(OpenAiResponsesStreamError);
    expect(failure).toMatchObject({ ...expected, body: event });
  });
});
