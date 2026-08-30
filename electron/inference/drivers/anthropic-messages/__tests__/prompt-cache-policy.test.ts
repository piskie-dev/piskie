import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  applyAnthropicPromptCache,
  type AnthropicPromptCacheInput,
} from '../prompt-cache-policy.js';

const EPHEMERAL = { type: 'ephemeral' };

function textMessage(index: number): Anthropic.MessageParam {
  return { role: index % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: `message-${index}` }] };
}

function input(messages: Anthropic.MessageParam[]): AnthropicPromptCacheInput {
  return {
    system: [
      { type: 'text', text: 'stable-system-a' },
      { type: 'text', text: 'stable-system-b' },
    ],
    tools: [
      { name: 'first', description: 'first tool', input_schema: { type: 'object', properties: {} } },
      { name: 'last', description: 'last tool', input_schema: { type: 'object', properties: {} } },
    ],
    messages,
  };
}

describe('Anthropic prompt cache policy', () => {
  it('combines stable-prefix breakpoints with automatic growing-conversation caching', () => {
    const source = input(Array.from({ length: 21 }, (_, index) => textMessage(index)));

    const cached = applyAnthropicPromptCache(source, true);

    expect(cached.automatic).toEqual(EPHEMERAL);
    expect(cached.system).toEqual([
      { type: 'text', text: 'stable-system-a' },
      { type: 'text', text: 'stable-system-b', cache_control: EPHEMERAL },
    ]);
    expect(cached.tools).toEqual([
      { name: 'first', description: 'first tool', input_schema: { type: 'object', properties: {} } },
      {
        name: 'last',
        description: 'last tool',
        input_schema: { type: 'object', properties: {} },
        cache_control: EPHEMERAL,
      },
    ]);
    expect(cached.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'message-1', cache_control: EPHEMERAL }],
    });
    expect(cached.messages[0]).toEqual(textMessage(0));
    expect(cached.messages.slice(2)).toEqual(source.messages.slice(2));

    expect(JSON.stringify(source)).not.toContain('cache_control');
  });

  it('moves the rolling checkpoint behind a non-cacheable thinking block', () => {
    const blocks: Anthropic.ContentBlockParam[] = Array.from(
      { length: 21 },
      (_, index) => ({ type: 'text', text: `block-${index}` }),
    );
    blocks[1] = { type: 'thinking', thinking: 'prior thought', signature: 'signature' };
    const source = input([{ role: 'assistant', content: blocks }]);

    const cached = applyAnthropicPromptCache(source, true);
    const content = cached.messages[0]!.content as Anthropic.ContentBlockParam[];

    expect(content[0]).toEqual({ type: 'text', text: 'block-0', cache_control: EPHEMERAL });
    expect(content[1]).toEqual(blocks[1]);
  });

  it('uses only the automatic and stable-prefix breakpoints for short conversations', () => {
    const source = input(Array.from({ length: 5 }, (_, index) => textMessage(index)));

    const cached = applyAnthropicPromptCache(source, true);

    expect(cached.automatic).toEqual(EPHEMERAL);
    expect(cached.messages).toEqual(source.messages);
  });

  it('uses otherwise empty breakpoint slots to extend long-history lookback coverage', () => {
    const source: AnthropicPromptCacheInput = {
      system: [],
      messages: Array.from({ length: 61 }, (_, index) => textMessage(index)),
    };

    const cached = applyAnthropicPromptCache(source, true);

    for (const index of [1, 21, 41]) {
      expect(cached.messages[index]).toEqual({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: [{ type: 'text', text: `message-${index}`, cache_control: EPHEMERAL }],
      });
    }
    expect(JSON.stringify(cached).match(/"cache_control"/g)).toHaveLength(3);
    expect(cached.automatic).toEqual(EPHEMERAL);
  });

  it('emits no cache controls when the compiled model disables caching', () => {
    const source = input(Array.from({ length: 21 }, (_, index) => textMessage(index)));

    const uncached = applyAnthropicPromptCache(source, false);

    expect(uncached.automatic).toBeUndefined();
    expect(JSON.stringify(uncached)).not.toContain('cache_control');
  });
});
