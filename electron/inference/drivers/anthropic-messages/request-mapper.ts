import type Anthropic from '@anthropic-ai/sdk';
import type { ReasoningProfile } from '../../../../shared/types/reasoning.js';
import type { AiInputPart, AiReasoningItem, AiRequest } from '../../ai/contracts.js';
import {
  reasoningNativeParameters,
  selectionFromReasoningRequest,
} from '../../ai/reasoning-policy.js';
import type { ArtifactReader } from '../../execution/artifact-port.js';
import { applyAnthropicPromptCache } from './prompt-cache-policy.js';

export interface AnthropicModelOptions {
  assistantReasoningReplay: 'omit' | 'as_text';
  promptCaching: boolean;
  reasoningProfile?: ReasoningProfile;
}

const ANTHROPIC_PROTOCOL_FALLBACK_MAX_TOKENS = 8_192;

export class AnthropicSerializationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AnthropicSerializationError';
  }
}

const RESERVED_EXTENSION_FIELDS = new Set([
  'model',
  'messages',
  'system',
  'max_tokens',
  'stream',
  'tools',
  'cache_control',
  'temperature',
  'top_p',
  'stop_sequences',
  'thinking',
  'output_config',
  'reasoning',
  'reasoning_effort',
  'enable_thinking',
  'think',
]);

export async function mapAnthropicMessagesRequest(
  request: AiRequest,
  upstreamModel: string,
  options: AnthropicModelOptions,
  artifacts?: ArtifactReader,
  signal?: AbortSignal,
): Promise<Anthropic.MessageCreateParamsStreaming> {
  const reasoningParameters = reasoningNativeParameters(
    options.reasoningProfile?.transportPreset,
    selectionFromReasoningRequest(request.generation?.reasoning),
  );
  // Anthropic 协议要求进行中的工具回合必须回传该回合的 thinking 块（签名校验）。
  // 历史来自其他协议的模型时这些块不存在也补不出来：官方服务端对此静默降级，
  // 兼容端点（DeepSeek 等）直接 400。此处在客户端复刻官方降级语义：thinking
  // 改为 disabled，且本次请求不再序列化任何 thinking 块。adaptive 模式没有
  // 该校验（官方独有且服务端自行处理），不降级。
  const degradeThinking = requestsEnabledThinking(reasoningParameters)
    && openToolTurnLacksThinking(request.messages);

  const system: Anthropic.TextBlockParam[] = [];
  const messages: Anthropic.MessageParam[] = [];

  for (const message of request.messages) {
    if (message.role === 'system') {
      system.push(...mapSystemContent(message.content));
      continue;
    }
    const mapped = await mapConversationMessage(message, options, degradeThinking, artifacts, signal);
    // Canonical messages preserve business boundaries. Anthropic alone requires alternating
    // wire roles, so adjacent user/tool-result and assistant messages are joined here.
    const previous = messages[messages.length - 1];
    if (
      previous?.role === mapped.role
      && Array.isArray(previous.content) && Array.isArray(mapped.content)
    ) {
      (previous.content as Anthropic.ContentBlockParam[]).push(...mapped.content);
    } else {
      messages.push(mapped);
    }
  }

  const extension = request.extensions?.['anthropic-messages'];
  if (extension !== undefined && !isRecord(extension)) {
    throw new AnthropicSerializationError(
      'ANTHROPIC_EXTENSION_INVALID',
      'extensions.anthropic-messages must be an object',
    );
  }
  if (extension) {
    for (const field of Object.keys(extension)) {
      if (RESERVED_EXTENSION_FIELDS.has(field)) {
        throw new AnthropicSerializationError(
          'ANTHROPIC_EXTENSION_RESERVED',
          `extensions.anthropic-messages cannot replace ${field}`,
        );
      }
    }
  }

  const tools = request.tools?.length
    ? request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    })) as Anthropic.Tool[]
    : undefined;
  const cached = applyAnthropicPromptCache({ system, messages, tools }, options.promptCaching);

  const params: Record<string, unknown> = {
    ...extension,
    model: upstreamModel,
    messages: cached.messages,
    max_tokens: request.generation?.maxOutputTokens ?? ANTHROPIC_PROTOCOL_FALLBACK_MAX_TOKENS,
    stream: true,
  };
  if (cached.automatic) params.cache_control = cached.automatic;
  if (cached.system.length > 0) params.system = cached.system;
  if (cached.tools?.length) params.tools = cached.tools;
  if (request.generation?.temperature !== undefined) params.temperature = request.generation.temperature;
  if (request.generation?.topP !== undefined) params.top_p = request.generation.topP;
  if (request.generation?.stop !== undefined) params.stop_sequences = [...request.generation.stop];
  applyReasoning(params, reasoningParameters, degradeThinking);
  applyResponseFormat(params, request);

  return params as unknown as Anthropic.MessageCreateParamsStreaming;
}

function mapSystemContent(content: readonly AiInputPart[]): Anthropic.TextBlockParam[] {
  return content.map((part) => {
    if (part.kind === 'input_image') {
      throw new AnthropicSerializationError(
        'ANTHROPIC_SYSTEM_IMAGE_UNSUPPORTED',
        'Anthropic top-level system content cannot contain images',
      );
    }
    return { type: 'text', text: part.text };
  });
}

async function mapConversationMessage(
  message: AiRequest['messages'][number],
  options: AnthropicModelOptions,
  degradeThinking: boolean,
  artifacts?: ArtifactReader,
  signal?: AbortSignal,
): Promise<Anthropic.MessageParam> {
  if (message.role === 'system') {
    throw new AnthropicSerializationError(
      'ANTHROPIC_SYSTEM_MAPPING_INVALID',
      'System messages must be mapped to the top-level system field',
    );
  }
  if (message.role === 'user') {
    const content: Anthropic.ContentBlockParam[] = [];
    for (const part of message.content) {
      if (part.kind === 'text') content.push({ type: 'text', text: part.text });
      else content.push(await mapImage(part.artifact, artifacts, signal));
    }
    return { role: 'user', content };
  }

  if (message.role === 'tool') {
    const content: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [];
    for (const part of message.content) {
      if (part.kind === 'text') content.push({ type: 'text', text: part.text });
      else content.push(await mapImage(part.artifact, artifacts, signal));
    }
    return {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        is_error: message.isError,
        content,
      }],
    };
  }

  const content: Anthropic.ContentBlockParam[] = [];
  for (const part of message.content) {
    if (part.kind === 'text') {
      content.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.kind === 'reasoning') {
      if (!degradeThinking && part.item.protocol === 'anthropic-thinking') {
        content.push({
          type: 'thinking',
          thinking: part.item.text,
          signature: part.item.signature,
        });
      } else if (!degradeThinking && part.item.protocol === 'anthropic-redacted') {
        content.push({ type: 'redacted_thinking', data: part.item.data });
      } else if (options.assistantReasoningReplay === 'as_text') {
        const text = displayReasoningText(part.item);
        if (text) content.push({ type: 'text', text });
      }
      continue;
    }
    if (part.kind !== 'tool_call') {
      throw new AnthropicSerializationError(
        'ANTHROPIC_ASSISTANT_PART_INVALID',
        `Anthropic assistant messages cannot contain ${part.kind}`,
      );
    }

    let parsedArguments: unknown;
    try {
      parsedArguments = JSON.parse(part.arguments);
    } catch (cause) {
      throw new AnthropicSerializationError(
        'ANTHROPIC_TOOL_ARGUMENTS_INVALID',
        `Tool call ${part.callId} arguments must contain valid JSON: ${String(cause)}`,
      );
    }
    content.push({
      type: 'tool_use',
      id: part.callId,
      name: part.name,
      input: parsedArguments,
    });
  }
  return { role: 'assistant', content };
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

function requestsEnabledThinking(reasoningParameters: Record<string, unknown>): boolean {
  const thinking = reasoningParameters.thinking;
  return isRecord(thinking) && thinking.type === 'enabled';
}

/**
 * 进行中的工具回合里是否存在拿不出可回传 thinking 块的 assistant 消息。
 *
 * 回合边界是最后一条真实 user 消息（tool_result 属于回合内部，不是边界）。
 * 只有该边界之后的 assistant 工具调用消息受协议校验约束；更早回合的
 * thinking 块服务端一律忽略，不参与判定。
 */
function openToolTurnLacksThinking(messages: AiRequest['messages']): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'user' || message.role === 'system') return false;
    if (message.role !== 'assistant') continue;
    if (!message.content.some((part) => part.kind === 'tool_call')) continue;
    const hasReplayableThinking = message.content.some((part) =>
      part.kind === 'reasoning'
      && (part.item.protocol === 'anthropic-thinking' || part.item.protocol === 'anthropic-redacted'),
    );
    if (!hasReplayableThinking) return true;
  }
  return false;
}

async function mapImage(
  ref: { artifactId: string },
  artifacts: ArtifactReader | undefined,
  signal: AbortSignal | undefined,
): Promise<Anthropic.ImageBlockParam> {
  if (!artifacts) {
    throw new AnthropicSerializationError(
      'ARTIFACT_READER_MISSING',
      'An artifact reader is required for Anthropic image input',
    );
  }
  const artifact = await artifacts.read(ref, signal);
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: artifact.mimeType as Anthropic.Base64ImageSource['media_type'],
      data: Buffer.from(artifact.bytes).toString('base64'),
    },
  };
}

function applyReasoning(
  params: Record<string, unknown>,
  reasoningParameters: Record<string, unknown>,
  degradeThinking: boolean,
): void {
  for (const [field, value] of Object.entries(reasoningParameters)) {
    if (field === 'thinking' && degradeThinking) params.thinking = { type: 'disabled' };
    else if (field === 'output_config' && isRecord(value)) mergeOutputConfig(params, value);
    else params[field] = value;
  }
}

function applyResponseFormat(params: Record<string, unknown>, request: AiRequest): void {
  const format = request.responseFormat;
  if (!format || format.kind === 'text') return;
  const schema = format.kind === 'json_schema' ? format.schema : { type: 'object' };
  mergeOutputConfig(params, { format: { type: 'json_schema', schema } });
}

function mergeOutputConfig(params: Record<string, unknown>, addition: Record<string, unknown>): void {
  params.output_config = {
    ...(isRecord(params.output_config) ? params.output_config : {}),
    ...addition,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
