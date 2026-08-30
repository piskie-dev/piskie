import type OpenAI from 'openai';
import type { AiMessage, AiReasoningItem, AiRequest } from '../../ai/contracts.js';
import {
  reasoningNativeParameters,
  selectionFromReasoningRequest,
} from '../../ai/reasoning-policy.js';
import type { ArtifactReader } from '../../execution/artifact-port.js';
import { OpenAiSerializationError, type OpenAiModelOptions } from './request-mapper.js';

const RESERVED_EXTENSION_FIELDS = new Set([
  'model',
  'input',
  'messages',
  'prompt_cache_key',
  'stream',
  'store',
  'include',
  'tools',
  'max_output_tokens',
  'temperature',
  'top_p',
  'reasoning',
  'text',
]);

export async function mapOpenAiResponsesRequest(
  request: AiRequest,
  upstreamModel: string,
  options: OpenAiModelOptions,
  artifacts?: ArtifactReader,
): Promise<OpenAI.Responses.ResponseCreateParamsStreaming> {
  if (request.generation?.stop !== undefined) {
    throw new OpenAiSerializationError(
      'OPENAI_RESPONSES_STOP_UNSUPPORTED',
      'OpenAI Responses requests do not support stop sequences',
    );
  }

  const input: OpenAI.Responses.ResponseInputItem[] = [];
  for (const message of request.messages) {
    input.push(...await mapMessage(message, options, artifacts));
  }

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
    input,
    stream: true,
    store: false,
    include: ['reasoning.encrypted_content'],
  };
  if (request.promptCacheKey) params.prompt_cache_key = request.promptCacheKey;
  if (request.tools?.length) {
    params.tools = request.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: false,
    }));
  }
  if (request.generation?.maxOutputTokens !== undefined) {
    params.max_output_tokens = request.generation.maxOutputTokens;
  }
  if (request.generation?.temperature !== undefined) params.temperature = request.generation.temperature;
  if (request.generation?.topP !== undefined) params.top_p = request.generation.topP;
  applyReasoning(params, request, options);
  applyResponseFormat(params, request);

  return params as unknown as OpenAI.Responses.ResponseCreateParamsStreaming;
}

async function mapMessage(
  message: AiMessage,
  options: OpenAiModelOptions,
  artifacts?: ArtifactReader,
): Promise<OpenAI.Responses.ResponseInputItem[]> {
  if (message.role === 'system' || message.role === 'user') {
    const content: OpenAI.Responses.ResponseInputMessageContentList = [];
    for (const part of message.content) {
      if (part.kind === 'text') {
        content.push({ type: 'input_text', text: part.text });
      } else {
        if (message.role === 'system') {
          throw new OpenAiSerializationError(
            'OPENAI_SYSTEM_IMAGE_UNSUPPORTED',
            'OpenAI system messages cannot contain images',
          );
        }
        content.push(await mapImage(part.artifact, part.detail, artifacts));
      }
    }
    return [{
      type: 'message',
      role: message.role === 'system' ? 'developer' : 'user',
      content,
    }];
  }

  if (message.role === 'tool') {
    const output: OpenAI.Responses.ResponseFunctionCallOutputItemList = [];
    for (const part of message.content) {
      if (part.kind === 'text') output.push({ type: 'input_text', text: part.text });
      else output.push(await mapImage(part.artifact, undefined, artifacts));
    }
    return [{
      type: 'function_call_output',
      call_id: message.toolCallId,
      output,
    }];
  }

  const assistant = message as Extract<AiMessage, { role: 'assistant' }>;
  const result: OpenAI.Responses.ResponseInputItem[] = [];
  let text: string[] = [];
  const flushText = () => {
    if (text.length === 0) return;
    result.push({ type: 'message', role: 'assistant', content: text.join('') });
    text = [];
  };

  for (const part of assistant.content) {
    if (part.kind === 'text') {
      text.push(part.text);
      continue;
    }
    if (part.kind === 'reasoning') {
      if (part.item.protocol === 'openai-responses') {
        flushText();
        result.push(mapReasoningItem(part.item));
      } else if (options.assistantReasoningReplay === 'as_text') {
        const visible = displayReasoningText(part.item);
        if (visible) text.push(visible);
      }
      continue;
    }

    flushText();
    result.push({
      type: 'function_call',
      call_id: part.callId,
      name: part.name,
      arguments: part.arguments,
      ...(part.providerItemId && { id: part.providerItemId }),
      ...(part.status && { status: part.status }),
    });
  }
  flushText();
  return result;
}

function mapReasoningItem(
  item: Extract<AiReasoningItem, { protocol: 'openai-responses' }>,
): OpenAI.Responses.ResponseReasoningItem {
  if (!item.id) {
    throw new OpenAiSerializationError(
      'OPENAI_RESPONSES_REASONING_ID_MISSING',
      'OpenAI Responses reasoning items must retain their provider item id',
    );
  }
  return {
    type: 'reasoning',
    id: item.id,
    summary: item.summary.map((part) => ({ ...part })),
    ...(item.content && { content: item.content.map((part) => ({ ...part })) }),
    ...(item.encryptedContent && { encrypted_content: item.encryptedContent }),
    ...(item.status && { status: item.status }),
  };
}

async function mapImage(
  ref: { artifactId: string },
  detail: 'auto' | 'low' | 'high' | undefined,
  artifacts: ArtifactReader | undefined,
): Promise<OpenAI.Responses.ResponseInputImage> {
  if (!artifacts) {
    throw new OpenAiSerializationError('ARTIFACT_READER_MISSING', 'An artifact reader is required for image input');
  }
  const artifact = await artifacts.read(ref);
  return {
    type: 'input_image',
    image_url: `data:${artifact.mimeType};base64,${Buffer.from(artifact.bytes).toString('base64')}`,
    detail: detail ?? 'auto',
  };
}

function displayReasoningText(item: Exclude<AiReasoningItem, { protocol: 'openai-responses' }>): string {
  if (item.protocol === 'openai-chat' || item.protocol === 'anthropic-thinking') return item.text;
  return '';
}

function applyReasoning(
  params: Record<string, unknown>,
  request: AiRequest,
  options: OpenAiModelOptions,
): void {
  const transportPreset = options.reasoningProfile?.transportPreset;
  const selection = selectionFromReasoningRequest(request.generation?.reasoning);
  const native = reasoningNativeParameters(
    transportPreset,
    selection,
  );
  const requestSummary = selection.kind === 'effort'
    && (transportPreset === 'openai-effort' || transportPreset === 'openai-reasoning-object');
  const summary = requestSummary ? { summary: 'auto' as const } : {};

  if (native.reasoning !== undefined) {
    params.reasoning = { ...(native.reasoning as Record<string, unknown>), ...summary };
  } else if (typeof native.reasoning_effort === 'string') {
    params.reasoning = { effort: native.reasoning_effort, ...summary };
  }
}

function applyResponseFormat(params: Record<string, unknown>, request: AiRequest): void {
  const format = request.responseFormat;
  if (!format || format.kind === 'text') return;
  if (format.kind === 'json_object') {
    params.text = { format: { type: 'json_object' } };
    return;
  }
  params.text = {
    format: {
      type: 'json_schema',
      name: format.name,
      schema: format.schema,
      strict: format.strict,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
