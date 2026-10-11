import type OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import type { AiAttemptEvent } from '../../../ai/contracts.js';
import { projectOpenAiChatStream } from '../event-projector.js';

function chunk(delta: unknown, finishReason: string | null = null): OpenAI.Chat.Completions.ChatCompletionChunk {
  return {
    id: 'chat-example', object: 'chat.completion.chunk', created: 1, model: 'example-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  } as OpenAI.Chat.Completions.ChatCompletionChunk;
}

async function* stream(chunks: readonly OpenAI.Chat.Completions.ChatCompletionChunk[], received: (index: number) => void) {
  for (const [index, value] of chunks.entries()) {
    received(index);
    yield value;
  }
}

async function collect(events: AsyncIterable<AiAttemptEvent>): Promise<AiAttemptEvent[]> {
  const result: AiAttemptEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

const emptyChunks = [
  { ...chunk({}), choices: [], usage: { prompt_tokens: 4, completion_tokens: 0, total_tokens: 4 } },
  chunk({ role: 'assistant' }),
  chunk({ content: '', reasoning_content: '' }),
  chunk({}),
];

describe('OpenAI Chat event projector first token', () => {
  it('ignores usage, role-only chunks, empty deltas and tool identity without arguments', async () => {
    const events = await collect(projectOpenAiChatStream(stream([
      ...emptyChunks,
      chunk({ tool_calls: [{ index: 0, id: 'call-example', function: { name: 'lookup', arguments: '' } }] }),
      chunk({}, 'tool_calls'),
    ], () => undefined)));

    expect(events.map((event) => event.kind)).toEqual(['usage.updated', 'tool.started', 'tool.completed', 'response.completed']);
  });

  it.each([
    { name: 'text', delta: { content: 'answer' } },
    { name: 'reasoning_content', delta: { reasoning_content: 'thought' } },
    { name: 'reasoning', delta: { reasoning: 'thought' } },
    { name: 'reasoning with an empty reasoning_content field', delta: { reasoning_content: '', reasoning: 'thought' } },
    { name: 'tool arguments before identity', delta: { tool_calls: [{ index: 0, function: { arguments: '{"value":' } }] } },
  ])('signals once when receiving the first nonempty $name', async ({ delta, name }) => {
    let received = -1;
    const signals: number[] = [];
    const projected: Array<{ event: AiAttemptEvent; received: number }> = [];
    const chunks = [
      ...emptyChunks,
      chunk(delta),
      ...(name === 'tool arguments before identity'
        ? [chunk({ tool_calls: [{ index: 0, id: 'call-example', function: { name: 'lookup', arguments: '1}' } }] })]
        : []),
      chunk({ content: 'more' }, 'stop'),
    ];
    for await (const event of projectOpenAiChatStream(stream(chunks, (index) => { received = index; }))) {
      if (event.kind === 'response.first_token') signals.push(received);
      projected.push({ event, received });
    }

    expect(signals).toEqual([emptyChunks.length]);
    expect(projected.find((item) => item.received === emptyChunks.length)?.event.kind).toBe('response.first_token');
    if (name === 'tool arguments before identity') {
      expect(projected.find((item) => item.event.kind === 'tool.arguments.delta')).toEqual({
        event: { kind: 'tool.arguments.delta', callId: 'call-example', delta: '{"value":1}' },
        received: emptyChunks.length + 1,
      });
    }
  });
});
