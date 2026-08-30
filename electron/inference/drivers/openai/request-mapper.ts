import type OpenAI from 'openai';
import type { OpenAiWireApi } from '../../../../shared/types/inference.js';
import type { ReasoningProfile } from '../../../../shared/types/reasoning.js';
import type { AiMessage, AiReasoningItem, AiRequest } from '../../ai/contracts.js';
import {
  reasoningNativeParameters,
  selectionFromReasoningRequest,
} from '../../ai/reasoning-policy.js';
import type { ArtifactReader } from '../../execution/artifact-port.js';

export interface OpenAiModelOptions {
  wireApi?: OpenAiWireApi;
  maxTokensField: 'max_completion_tokens' | 'max_tokens';
  assistantReasoningReplay: 'omit' | 'as_text' | 'reasoning_content';
  reasoningProfile?: ReasoningProfile;
}

export class OpenAiSerializationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'OpenAiSerializationError';
  }
}

const RESERVED_EXTENSION_FIELDS = new Set([
  'model',
  'messages',
  'prompt_cache_key',
  'stream',
  'stream_options',
  'tools',
  'reasoning',
  'reasoning_effort',
  'thinking',
  'enable_thinking',
  'think',
]);

export async function mapOpenAiChatRequest(
  request: AiRequest,
  upstreamModel: string,
  options: OpenAiModelOptions,
  artifacts?: ArtifactReader,
): Promise<OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming> {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  for (const message of request.messages) messages.push(...await mapMessage(message, options, artifacts));

  const extension = request.extensions?.openai;
  if (extension !== undefined && !isRecord(extension)) {
    throw new OpenAiSerializationError('OPENAI_EXTENSION_INVALID', 'extensions.openai must be an object');
  }
  if (extension) {
    for (const field of Object.keys(extension)) {
      if (RESERVED_EXTENSION_FIELDS.has(field)) {
        throw new OpenAiSerializationError('OPENAI_EXTENSION_RESERVED', `extensions.openai cannot replace ${field}`);
      }
    }
  }

  const params: Record<string, unknown> = {
    ...extension,
    model: upstreamModel,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (request.promptCacheKey) params.prompt_cache_key = request.promptCacheKey;

  if (request.tools?.length) {
    params.tools = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }
  if (request.generation?.maxOutputTokens !== undefined) {
    params[options.maxTokensField] = request.generation.maxOutputTokens;
  }
  if (request.generation?.temperature !== undefined) params.temperature = request.generation.temperature;
  if (request.generation?.topP !== undefined) params.top_p = request.generation.topP;
  if (request.generation?.stop !== undefined) params.stop = [...request.generation.stop];
  applyReasoning(params, request, options);
  applyResponseFormat(params, request);

  return params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
}

async function mapMessage(
  message: AiMessage,
  options: OpenAiModelOptions,
  artifacts?: ArtifactReader,
): Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam[]> {
  if (message.role === 'system') {
    if (message.content.some((part) => part.kind === 'input_image')) {
      throw new OpenAiSerializationError('OPENAI_SYSTEM_IMAGE_UNSUPPORTED', 'OpenAI system messages cannot contain images');
    }
    return [{
      role: 'system',
      content: message.content.map((part) => part.kind === 'text' ? part.text : '').join(''),
    }];
  }

  if (message.role === 'user') {
    const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
    for (const part of message.content) {
      if (part.kind === 'text') {
        content.push({ type: 'text', text: part.text });
      } else {
        if (!artifacts) {
          throw new OpenAiSerializationError('ARTIFACT_READER_MISSING', 'An artifact reader is required for image input');
        }
        const artifact = await artifacts.read(part.artifact);
        content.push({
          type: 'image_url',
          image_url: {
            url: `data:${artifact.mimeType};base64,${Buffer.from(artifact.bytes).toString('base64')}`,
            detail: part.detail,
          },
        });
      }
    }
    return [{ role: 'user', content }];
  }

  if (message.role === 'tool') {
    const text: string[] = [];
    const images: OpenAI.Chat.Completions.ChatCompletionContentPartImage[] = [];
    for (const part of message.content) {
      if (part.kind === 'text') {
        text.push(part.text);
      } else {
        if (!artifacts) {
          throw new OpenAiSerializationError('ARTIFACT_READER_MISSING', 'An artifact reader is required for image tool results');
        }
        const artifact = await artifacts.read(part.artifact);
        images.push({
          type: 'image_url',
          image_url: { url: `data:${artifact.mimeType};base64,${Buffer.from(artifact.bytes).toString('base64')}` },
        });
      }
    }

    const result: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [{
      role: 'tool',
      tool_call_id: message.toolCallId,
      content: text.filter(Boolean).join('\n'),
    }];
    // OpenAI tool messages accept text only; expose returned images as a following user message.
    if (images.length > 0) {
      result.push({
        role: 'user',
        content: [{ type: 'text', text: '[工具返回的截图]' }, ...images],
      });
    }
    return result;
  }

  const text: string[] = [];
  const reasoningContent: string[] = [];
  const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];
  for (const part of message.content) {
    if (part.kind === 'text') text.push(part.text);
    if (part.kind === 'reasoning') {
      const reasoningText = displayReasoningText(part.item);
      if (reasoningText && options.assistantReasoningReplay === 'as_text') text.push(reasoningText);
      if (
        reasoningText
        && options.assistantReasoningReplay === 'reasoning_content'
        && part.item.protocol === 'openai-chat'
      ) {
        reasoningContent.push(reasoningText);
      }
    }
    if (part.kind === 'tool_call') {
      toolCalls.push({
        id: part.callId,
        type: 'function',
        function: { name: part.name, arguments: part.arguments },
      });
    }
  }
  return [{
    role: 'assistant',
    content: text.join('') || null,
    ...(reasoningContent.length > 0 && { reasoning_content: reasoningContent.join('') }),
    ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
  } as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam];
}

function displayReasoningText(item: AiReasoningItem): string {
  if (item.protocol === 'openai-chat' || item.protocol === 'anthropic-thinking') return item.text;
  if (item.protocol === 'openai-responses') {
    return item.summary.map((part) => part.text).join('\n')
      || item.content?.map((part) => part.text).join('\n')
      || '';
  }
  return '';
}

function applyReasoning(
  params: Record<string, unknown>,
  request: AiRequest,
  options: OpenAiModelOptions,
): void {
  Object.assign(
    params,
    reasoningNativeParameters(
      options.reasoningProfile?.transportPreset,
      selectionFromReasoningRequest(request.generation?.reasoning),
    ),
  );
}

function applyResponseFormat(params: Record<string, unknown>, request: AiRequest): void {
  const format = request.responseFormat;
  if (!format || format.kind === 'text') return;
  if (format.kind === 'json_object') {
    params.response_format = { type: 'json_object' };
    return;
  }
  params.response_format = {
    type: 'json_schema',
    json_schema: { name: format.name, schema: format.schema, strict: format.strict },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
