import type Anthropic from '@anthropic-ai/sdk';
import type { AiAttemptEvent, AiStopReason, AiUsage } from '../../ai/contracts.js';
import { normalizeUsage } from '../../ai/usage-normalizer.js';

interface ToolBlock {
  callId: string;
  name: string;
  completed: boolean;
}

interface ThinkingBlock {
  text: string;
  signature: string;
}

export async function* projectAnthropicMessagesStream(
  stream: AsyncIterable<Anthropic.RawMessageStreamEvent>,
): AsyncIterable<AiAttemptEvent> {
  const tools = new Map<number, ToolBlock>();
  const thinking = new Map<number, ThinkingBlock>();
  const redactedThinking = new Map<number, string>();
  let stopReason: AiStopReason = 'other';

  for await (const event of stream) {
    switch (event.type) {
      case 'message_start': {
        const usage = mapUsage(event.message.usage);
        if (hasUsage(usage)) yield { kind: 'usage.updated', usage };
        break;
      }
      case 'content_block_start': {
        const block = event.content_block;
        if (block.type === 'text' && block.text) {
          yield { kind: 'text.delta', text: block.text };
        } else if (block.type === 'thinking') {
          if (block.thinking) yield { kind: 'reasoning.delta', text: block.thinking };
          thinking.set(event.index, { text: block.thinking, signature: block.signature });
        } else if (block.type === 'redacted_thinking') {
          redactedThinking.set(event.index, block.data);
        } else if (block.type === 'tool_use') {
          tools.set(event.index, { callId: block.id, name: block.name, completed: false });
          yield { kind: 'tool.started', callId: block.id, name: block.name };
        }
        break;
      }
      case 'content_block_delta': {
        if (event.delta.type === 'text_delta' && event.delta.text) {
          yield { kind: 'text.delta', text: event.delta.text };
        } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
          const current = thinking.get(event.index);
          if (!current) throw new Error(`Anthropic thinking delta has no start block at index ${event.index}`);
          current.text += event.delta.thinking;
          yield { kind: 'reasoning.delta', text: event.delta.thinking };
        } else if (event.delta.type === 'signature_delta' && event.delta.signature) {
          const current = thinking.get(event.index);
          if (!current) throw new Error(`Anthropic signature delta has no thinking block at index ${event.index}`);
          current.signature += event.delta.signature;
        } else if (event.delta.type === 'input_json_delta' && event.delta.partial_json) {
          const tool = tools.get(event.index);
          if (!tool) throw new Error(`Anthropic tool delta has no start block at index ${event.index}`);
          yield { kind: 'tool.arguments.delta', callId: tool.callId, delta: event.delta.partial_json };
        }
        break;
      }
      case 'content_block_stop': {
        const completedThinking = thinking.get(event.index);
        if (completedThinking) {
          thinking.delete(event.index);
          yield {
            kind: 'reasoning.item',
            item: completedThinking.signature
              ? {
                  protocol: 'anthropic-thinking',
                  text: completedThinking.text,
                  signature: completedThinking.signature,
                }
              : { protocol: 'openai-chat', text: completedThinking.text },
          };
        }
        const redacted = redactedThinking.get(event.index);
        if (redacted !== undefined) {
          redactedThinking.delete(event.index);
          yield {
            kind: 'reasoning.item',
            item: { protocol: 'anthropic-redacted', data: redacted },
          };
        }
        const tool = tools.get(event.index);
        if (tool && !tool.completed) {
          tool.completed = true;
          yield { kind: 'tool.completed', callId: tool.callId };
        }
        break;
      }
      case 'message_delta': {
        if (event.delta.stop_reason) stopReason = mapStopReason(event.delta.stop_reason);
        const usage = mapUsage(event.usage);
        if (hasUsage(usage)) yield { kind: 'usage.updated', usage };
        break;
      }
      case 'message_stop':
        for (const [index, tool] of tools) {
          if (!tool.completed) throw new Error(`Anthropic stream ended with an incomplete tool call at index ${index}`);
        }
        if (thinking.size > 0 || redactedThinking.size > 0) {
          throw new Error('Anthropic stream ended with an incomplete reasoning block');
        }
        yield { kind: 'response.completed', stopReason };
        return;
    }
  }

  throw new Error('Anthropic stream ended without a message_stop event');
}

/**
 * Anthropic 的 `input_tokens` **不含**缓存读写两项（官方文档口径），
 * 因此声明 'cache-excluded'——求和由 normalizeUsage 完成，这里只抽字段。
 */
function mapUsage(usage: Anthropic.Usage | Anthropic.MessageDeltaUsage): AiUsage {
  return normalizeUsage('cache-excluded', {
    ...(typeof usage.input_tokens === 'number' && { billedInput: usage.input_tokens }),
    ...(typeof usage.output_tokens === 'number' && { output: usage.output_tokens }),
    ...(typeof usage.cache_read_input_tokens === 'number' && {
      cacheRead: usage.cache_read_input_tokens,
    }),
    ...(typeof usage.cache_creation_input_tokens === 'number' && {
      cacheWrite: usage.cache_creation_input_tokens,
    }),
    ...(typeof usage.output_tokens_details?.thinking_tokens === 'number' && {
      reasoning: usage.output_tokens_details.thinking_tokens,
    }),
  });
}

function hasUsage(usage: AiUsage): boolean {
  return Object.keys(usage).length > 0;
}

function mapStopReason(reason: Anthropic.StopReason): AiStopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'refusal':
      return 'content_filter';
    default:
      return 'other';
  }
}
