import type OpenAI from 'openai';
import type { AiAttemptEvent, AiStopReason, AiUsage } from '../../ai/contracts.js';
import { normalizeUsage } from '../../ai/usage-normalizer.js';

interface ToolAccumulator {
  id?: string;
  name?: string;
  started: boolean;
  pendingArguments: string;
}

interface ExtendedDelta {
  reasoning_content?: unknown;
  reasoning?: unknown;
}

export async function* projectOpenAiChatStream(
  stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
): AsyncIterable<AiAttemptEvent> {
  const tools = new Map<number, ToolAccumulator>();
  let stopReason: AiStopReason = 'other';
  let reasoningText = '';
  let reasoningItemEmitted = false;

  for await (const chunk of stream) {
    const usage = mapUsage(chunk.usage);
    if (usage) yield { kind: 'usage.updated', usage };

    for (const choice of chunk.choices) {
      const delta = choice.delta as typeof choice.delta & ExtendedDelta;
      const reasoning = typeof delta.reasoning_content === 'string'
        ? delta.reasoning_content
        : typeof delta.reasoning === 'string' ? delta.reasoning : undefined;
      if (reasoning) {
        reasoningText += reasoning;
        yield { kind: 'reasoning.delta', text: reasoning };
      }

      if (
        !reasoningItemEmitted
        && reasoningText
        && ((typeof delta.content === 'string' && delta.content) || (delta.tool_calls?.length ?? 0) > 0)
      ) {
        reasoningItemEmitted = true;
        yield { kind: 'reasoning.item', item: { protocol: 'openai-chat', text: reasoningText } };
      }
      if (typeof delta.content === 'string' && delta.content) {
        yield { kind: 'text.delta', text: delta.content };
      }

      for (const toolDelta of delta.tool_calls ?? []) {
        const accumulator = tools.get(toolDelta.index) ?? { started: false, pendingArguments: '' };
        if (toolDelta.id) accumulator.id = toolDelta.id;
        if (toolDelta.function?.name) accumulator.name = toolDelta.function.name;
        if (toolDelta.function?.arguments) accumulator.pendingArguments += toolDelta.function.arguments;
        tools.set(toolDelta.index, accumulator);

        if (!accumulator.started && accumulator.id && accumulator.name) {
          accumulator.started = true;
          yield { kind: 'tool.started', callId: accumulator.id, name: accumulator.name };
        }
        if (accumulator.started && accumulator.pendingArguments) {
          const pending = accumulator.pendingArguments;
          accumulator.pendingArguments = '';
          yield { kind: 'tool.arguments.delta', callId: accumulator.id!, delta: pending };
        }
      }

      if (choice.finish_reason) stopReason = mapStopReason(choice.finish_reason);
    }
  }

  if (!reasoningItemEmitted && reasoningText) {
    yield { kind: 'reasoning.item', item: { protocol: 'openai-chat', text: reasoningText } };
  }
  for (const [index, tool] of tools) {
    if (!tool.started || !tool.id || !tool.name) {
      throw new Error(`OpenAI stream ended with an incomplete tool call at index ${index}`);
    }
    if (tool.pendingArguments) {
      yield { kind: 'tool.arguments.delta', callId: tool.id, delta: tool.pendingArguments };
    }
    yield { kind: 'tool.completed', callId: tool.id };
  }
  yield { kind: 'response.completed', stopReason };
}

/**
 * OpenAI Chat Completions 的 `prompt_tokens` **已含**缓存明细
 * （`prompt_tokens_details.cached_tokens`），因此声明 'cache-included'。
 */
function mapUsage(usage: OpenAI.Completions.CompletionUsage | null | undefined): AiUsage | undefined {
  if (!usage) return undefined;
  return normalizeUsage('cache-included', {
    billedInput: usage.prompt_tokens,
    output: usage.completion_tokens,
    cacheRead: usage.prompt_tokens_details?.cached_tokens,
    cacheWrite: usage.prompt_tokens_details?.cache_write_tokens,
    reasoning: usage.completion_tokens_details?.reasoning_tokens,
  });
}

function mapStopReason(reason: string): AiStopReason {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'other';
  }
}
