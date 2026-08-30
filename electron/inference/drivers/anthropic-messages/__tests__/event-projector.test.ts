import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import type { AiAttemptEvent } from '../../../ai/contracts.js';
import { projectAnthropicMessagesStream } from '../event-projector.js';

async function* stream(events: readonly unknown[]): AsyncIterable<Anthropic.RawMessageStreamEvent> {
  for (const event of events) yield event as Anthropic.RawMessageStreamEvent;
}

async function collect(events: AsyncIterable<AiAttemptEvent>): Promise<AiAttemptEvent[]> {
  const result: AiAttemptEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe('Anthropic Messages event projector', () => {
  it('retains multiple signed and redacted thinking blocks as ordered protocol items', async () => {
    const events = await collect(projectAnthropicMessagesStream(stream([
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: 'first-', signature: 'sig-' },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'thought' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'one' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'redacted_thinking', data: 'opaque-redacted' },
      },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'tool_use', id: 'call_1', name: 'lookup', input: {} },
      },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 2 },
      {
        type: 'content_block_start',
        index: 3,
        content_block: { type: 'thinking', thinking: 'second', signature: 'sig-two' },
      },
      { type: 'content_block_stop', index: 3 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 7 },
      },
      { type: 'message_stop' },
    ])));

    expect(events).toEqual([
      { kind: 'reasoning.delta', text: 'first-' },
      { kind: 'reasoning.delta', text: 'thought' },
      {
        kind: 'reasoning.item',
        item: {
          protocol: 'anthropic-thinking',
          text: 'first-thought',
          signature: 'sig-one',
        },
      },
      {
        kind: 'reasoning.item',
        item: { protocol: 'anthropic-redacted', data: 'opaque-redacted' },
      },
      { kind: 'tool.started', callId: 'call_1', name: 'lookup' },
      { kind: 'tool.arguments.delta', callId: 'call_1', delta: '{}' },
      { kind: 'tool.completed', callId: 'call_1' },
      { kind: 'reasoning.delta', text: 'second' },
      {
        kind: 'reasoning.item',
        item: {
          protocol: 'anthropic-thinking',
          text: 'second',
          signature: 'sig-two',
        },
      },
      { kind: 'usage.updated', usage: { totalOutputTokens: 7 } },
      { kind: 'response.completed', stopReason: 'tool_use' },
    ]);
  });
});
