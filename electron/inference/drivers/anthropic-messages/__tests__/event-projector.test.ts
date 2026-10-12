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

const emptyEvents = [
  { type: 'message_start', message: { content: [], usage: { input_tokens: 4, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call_example', name: 'lookup', input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'opaque' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '' } },
];
const endingEvents = [
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_stop', index: 2 },
  { type: 'message_stop' },
];

describe('Anthropic Messages event projector', () => {
  it('ignores message usage, empty blocks and deltas, tool identity, signatures and redacted data', async () => {
    const events = await collect(projectAnthropicMessagesStream(stream([
      ...emptyEvents,
      { type: 'content_block_start', index: 3, content_block: { type: 'redacted_thinking', data: 'opaque' } },
      { type: 'content_block_stop', index: 3 },
      ...endingEvents,
    ])));

    expect(events.some((event) => event.kind === 'response.first_token')).toBe(false);
  });

  it.each([
    { name: 'initial text', event: { type: 'content_block_start', index: 3, content_block: { type: 'text', text: 'answer' } } },
    { name: 'initial thinking', event: { type: 'content_block_start', index: 3, content_block: { type: 'thinking', thinking: 'thought', signature: '' } } },
    { name: 'text delta', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } } },
    { name: 'thinking delta', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'thought' } } },
    { name: 'tool argument delta', event: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{}' } } },
    { name: 'initial tool arguments', event: { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'call_initial', name: 'lookup', input: { value: 1 } } } },
  ])('signals only once on the first nonempty $name', async ({ event }) => {
    const raw = [
      ...emptyEvents, event,
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'later' } },
      { type: 'content_block_stop', index: 3 },
      ...endingEvents,
    ];
    let received = -1;
    const signals: number[] = [];
    const source = (async function* () {
      for (const [index, value] of raw.entries()) {
        received = index;
        yield value as Anthropic.RawMessageStreamEvent;
      }
    })();
    for await (const projected of projectAnthropicMessagesStream(source)) {
      if (projected.kind === 'response.first_token') signals.push(received);
    }

    expect(signals).toEqual([emptyEvents.length]);
  });

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
      { kind: 'response.first_token' },
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
