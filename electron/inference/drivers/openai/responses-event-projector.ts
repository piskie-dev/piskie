import type OpenAI from 'openai';
import type { AiAttemptEvent, AiStopReason, AiUsage } from '../../ai/contracts.js';
import { normalizeUsage } from '../../ai/usage-normalizer.js';

interface ToolAccumulator {
  callId: string;
  name: string;
  arguments: string;
  completed: boolean;
}

export class OpenAiResponsesStreamError extends Error {
  readonly eventType: 'response.failed' | 'error';
  readonly code?: string;
  readonly param?: string;
  readonly body: unknown;

  constructor(input: {
    eventType: 'response.failed' | 'error';
    message: string;
    code?: string | null;
    param?: string | null;
    body: unknown;
  }) {
    super(input.message);
    this.name = 'OpenAiResponsesStreamError';
    this.eventType = input.eventType;
    this.code = input.code ?? undefined;
    this.param = input.param ?? undefined;
    this.body = input.body;
  }
}

export async function* projectOpenAiResponsesStream(
  stream: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>,
): AsyncIterable<AiAttemptEvent> {
  const tools = new Map<string, ToolAccumulator>();
  let sawRefusal = false;

  for await (const event of stream) {
    switch (event.type) {
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        if (event.delta) yield { kind: 'reasoning.delta', text: event.delta };
        break;
      case 'response.output_text.delta':
        if (event.delta) yield { kind: 'text.delta', text: event.delta };
        break;
      case 'response.refusal.delta':
        sawRefusal = true;
        if (event.delta) yield { kind: 'text.delta', text: event.delta };
        break;
      case 'response.output_item.added':
        if (event.item.type === 'function_call') {
          const key = toolKey(event.item, event.output_index);
          const tool: ToolAccumulator = {
            callId: event.item.call_id,
            name: event.item.name,
            arguments: event.item.arguments,
            completed: false,
          };
          tools.set(key, tool);
          yield {
            kind: 'tool.started',
            callId: tool.callId,
            name: tool.name,
            ...(event.item.id && { providerItemId: event.item.id }),
            ...(event.item.status && { status: event.item.status }),
          };
          if (tool.arguments) {
            yield { kind: 'tool.arguments.delta', callId: tool.callId, delta: tool.arguments };
          }
        }
        break;
      case 'response.function_call_arguments.delta': {
        const tool = tools.get(event.item_id);
        if (!tool) throw new Error(`OpenAI Responses tool delta has no start item ${event.item_id}`);
        tool.arguments += event.delta;
        if (event.delta) yield { kind: 'tool.arguments.delta', callId: tool.callId, delta: event.delta };
        break;
      }
      case 'response.output_item.done':
        if (event.item.type === 'reasoning') {
          yield { kind: 'reasoning.item', item: mapReasoningItem(event.item) };
        } else if (event.item.type === 'function_call') {
          const key = toolKey(event.item, event.output_index);
          const tool = tools.get(key);
          if (!tool) throw new Error(`OpenAI Responses tool completion has no start item ${key}`);
          const remainder = remainingArguments(tool.arguments, event.item.arguments, tool.callId);
          if (remainder) {
            tool.arguments += remainder;
            yield { kind: 'tool.arguments.delta', callId: tool.callId, delta: remainder };
          }
          tool.completed = true;
          yield { kind: 'tool.completed', callId: tool.callId };
        }
        break;
      case 'response.completed': {
        assertToolsCompleted(tools);
        const usage = mapUsage(event.response.usage);
        if (usage) yield { kind: 'usage.updated', usage };
        yield { kind: 'response.completed', stopReason: completedStopReason(tools, sawRefusal) };
        return;
      }
      case 'response.incomplete': {
        assertToolsCompleted(tools);
        const usage = mapUsage(event.response.usage);
        if (usage) yield { kind: 'usage.updated', usage };
        yield { kind: 'response.completed', stopReason: incompleteStopReason(event.response) };
        return;
      }
      case 'response.failed':
        throw new OpenAiResponsesStreamError({
          eventType: event.type,
          message: event.response.error?.message ?? 'OpenAI Responses request failed',
          code: event.response.error?.code,
          body: event,
        });
      case 'error': {
        throw new OpenAiResponsesStreamError({
          eventType: event.type,
          message: event.message,
          code: event.code,
          param: event.param,
          body: event,
        });
      }
      default:
        break;
    }
  }

  throw new Error('OpenAI Responses stream ended without a terminal event');
}

function mapReasoningItem(
  item: OpenAI.Responses.ResponseReasoningItem,
): Extract<AiAttemptEvent, { kind: 'reasoning.item' }>['item'] {
  return {
    protocol: 'openai-responses',
    id: item.id,
    summary: item.summary.map((part) => ({ type: 'summary_text', text: part.text })),
    ...(item.content && {
      content: item.content.map((part) => ({ type: 'reasoning_text' as const, text: part.text })),
    }),
    ...(item.encrypted_content && { encryptedContent: item.encrypted_content }),
    ...(item.status && { status: item.status }),
  };
}

function toolKey(item: OpenAI.Responses.ResponseFunctionToolCall, outputIndex: number): string {
  return item.id ?? `output-${outputIndex}`;
}

function remainingArguments(current: string, completed: string, callId: string): string {
  if (current === completed) return '';
  if (completed.startsWith(current)) return completed.slice(current.length);
  throw new Error(`OpenAI Responses tool ${callId} arguments changed before completion`);
}

function assertToolsCompleted(tools: ReadonlyMap<string, ToolAccumulator>): void {
  for (const [itemId, tool] of tools) {
    if (!tool.completed) throw new Error(`OpenAI Responses stream ended with incomplete tool item ${itemId}`);
  }
}

/**
 * OpenAI Responses 的 `input_tokens` **已含**缓存明细（`input_tokens_details`），
 * 因此声明 'cache-included'——再加一次会双计。
 */
function mapUsage(usage: OpenAI.Responses.ResponseUsage | undefined): AiUsage | undefined {
  if (!usage) return undefined;
  return normalizeUsage('cache-included', {
    billedInput: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.input_tokens_details?.cached_tokens,
    cacheWrite: usage.input_tokens_details?.cache_write_tokens,
    reasoning: usage.output_tokens_details?.reasoning_tokens,
  });
}

function completedStopReason(
  tools: ReadonlyMap<string, ToolAccumulator>,
  sawRefusal: boolean,
): AiStopReason {
  if (tools.size > 0) return 'tool_use';
  if (sawRefusal) return 'content_filter';
  return 'end_turn';
}

function incompleteStopReason(response: OpenAI.Responses.Response): AiStopReason {
  if (response.incomplete_details?.reason === 'max_output_tokens') return 'max_tokens';
  if (response.incomplete_details?.reason === 'content_filter') return 'content_filter';
  return 'other';
}
