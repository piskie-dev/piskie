import { appLog } from '@electron/observability/logging/app-log.js';
import { createUuid } from '@shared/utils/identifiers.js';
import { AIErrorType } from '../../../shared/constants/index.js';
import { MIN_CONTEXT_WINDOW } from '../../../shared/constants/token.js';
import type {
  AIResponse,
  ContentBlock,
  Message,
  Tool,
  ToolResultContentBlock,
} from '../../../shared/types/index.js';
import type { ReasoningSelection } from '../../../shared/types/reasoning.js';
import type {
  AiAssistantPart,
  AiEvent,
  AiInputPart,
  AiMessage,
  AiReasoningItem,
  AiRequest,
} from '../ai/contracts.js';
import type { AiGateway } from '../ai/contracts.js';
import { collectAiResult } from '../ai/result-reducer.js';
import {
  reasoningRequest,
  resolveEffectiveReasoning,
  type EffectiveReasoning,
} from '../ai/reasoning-policy.js';
import type { ArtifactStore } from '../execution/artifact-port.js';
import { classifyGatewayCallError } from '../execution/call-error.js';
import type { ModelTarget } from '../execution/contracts.js';
import { formatModelTarget } from '../execution/model-target.js';
import { findCompiledTarget, type RuntimeSnapshotStore } from '../execution/runtime-snapshot.js';

export interface AgentInferenceBackoff {
  attempt: number;
  maxAttempts: number;
  errorType: AIErrorType;
  retryAt: number;
  errorMessage: string;
  diagnostics?: Record<string, unknown>;
}

export interface AgentInferenceOptions {
  requestId: string;
  logicalStartedAt: number;
  signal?: AbortSignal;
  onAttemptStart?: (info: { attempt: number; maxAttempts: number }) => void;
  onBackoff?: (info: AgentInferenceBackoff) => void;
  onVisibleDelta?: (delta: VisibleDelta) => void;
}

export interface VisibleDelta {
  runId: string;
  attempt: number;
  sequence: number;
  kind: 'think' | 'text';
  delta: string;
}

export interface AgentInferenceRequest {
  systemPrompt: string;
  messages: Message[];
  tools?: Tool[];
  maxTokens?: number;
  model: ModelTarget;
  reasoningOverride?: ReasoningSelection;
  promptCacheKey: string;
}

export interface AgentInferencePort {
  invoke(request: AgentInferenceRequest, options: AgentInferenceOptions): Promise<AIResponse>;
  resolveReasoning(target: ModelTarget, override?: ReasoningSelection): EffectiveReasoning;
  assertTarget(target: ModelTarget): void;
  /**
   * 模型上下文窗口（token）。**恒有值**：目录声明值与 `MIN_CONTEXT_WINDOW`
   * 取大。这不是缺失时的兜底，是准入下限——低于该量级的模型
   * 本项目跑不起来，模型编辑器在表单层就拒绝填入。
   */
  contextWindow(target: ModelTarget): number;
  /**
   * 请求前向 provider 问这份 payload 有多少输入 token（二级准入）。
   *
   * 返回 `undefined` 表示 driver **没有这个能力**（OpenAI 协议无 count 端点）；
   * 调用失败照常上抛，由调用方决定怎么处理——它不表示「用别的办法算一个出来」，
   * 本地没有分词器，算不出。
   */
  countInputTokens(
    request: AgentInferenceRequest,
    signal?: AbortSignal
  ): Promise<number | undefined>;
}

export class DefaultAgentInferencePort implements AgentInferencePort {
  constructor(
    private readonly gateway: AiGateway,
    private readonly snapshots: RuntimeSnapshotStore,
    private readonly artifacts: ArtifactStore
  ) {}

  async invoke(
    request: AgentInferenceRequest,
    options: AgentInferenceOptions
  ): Promise<AIResponse> {
    const signal = options.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const target = request.model;
    const effectiveReasoning = this.resolveReasoning(target, request.reasoningOverride);
    const mapped = await this.mapRequest(request, signal, effectiveReasoning.selection);
    const runId = `ai-${createUuid()}`;
    const traceId = `ai:${runId}`;
    const run = this.gateway.open(mapped, { runId, traceId, signal });
    const result = await collectAiResult(this.observeEvents(run.events, options), target, traceId);
    const durations = await run.statistics;
    const content: ContentBlock[] = [];
    for (const part of result.content) {
      if (part.kind === 'text') {
        if (part.text) content.push({ type: 'text', text: part.text });
      } else if (part.kind === 'reasoning') {
        content.push(mapReasoningItem(part.item));
      } else {
        content.push(mapToolCallPart(part));
      }
    }
    return {
      content,
      requestInfo: {
        version: 1,
        requestId: options.requestId,
        runId: result.runId,
        model: formatModelTarget(target),
        stopReason: result.stopReason,
        latencyMs: Date.now() - options.logicalStartedAt,
        ...durations,
        usage: {
          inputTokens: result.usage.totalInputTokens,
          outputTokens: result.usage.totalOutputTokens,
          cacheReadTokens: result.usage.cachedInputTokens,
          cacheWriteTokens: result.usage.cacheWriteTokens,
          reasoningTokens: result.usage.reasoningTokens,
        },
        effectiveReasoning,
      },
    };
  }

  resolveReasoning(target: ModelTarget, override?: ReasoningSelection): EffectiveReasoning {
    const snapshot = this.snapshots.capture();
    const compiled = snapshot && findCompiledTarget(snapshot, target);
    if (!compiled?.ai) {
      throw new Error(
        `Configured AI model target was not found: ${target.providerId}/${target.modelId}`
      );
    }
    return resolveEffectiveReasoning({
      profile: compiled.reasoning?.profile,
      modelDefault: compiled.reasoning?.modelDefault,
      agentOverride: override,
    });
  }

  assertTarget(target: ModelTarget): void {
    const snapshot = this.snapshots.capture();
    if (!snapshot || !findCompiledTarget(snapshot, target)?.ai) {
      throw new Error(
        `Configured AI model target was not found: ${target.providerId}/${target.modelId}`
      );
    }
  }

  contextWindow(target: ModelTarget): number {
    const snapshot = this.snapshots.capture();
    if (!snapshot) {
      throw new Error(
        `Configured AI model target was not found: ${target.providerId}/${target.modelId}`
      );
    }
    const compiled = findCompiledTarget(snapshot, target);
    if (!compiled?.ai) {
      throw new Error(
        `Configured AI model target was not found: ${target.providerId}/${target.modelId}`
      );
    }
    const declared =
      compiled.modelDefinition?.limits.contextWindow ??
      snapshot.catalogModels?.get(compiled.catalogId)?.limits.contextWindow;
    if (declared === undefined) {
      throw new Error(
        `Configured AI model target is missing limits.contextWindow: ${target.providerId}/${target.modelId}`
      );
    }
    return Math.max(declared, MIN_CONTEXT_WINDOW);
  }

  async countInputTokens(
    request: AgentInferenceRequest,
    signal?: AbortSignal
  ): Promise<number | undefined> {
    const snapshot = this.snapshots.capture();
    const count = snapshot && findCompiledTarget(snapshot, request.model)?.ai?.countInputTokens;
    if (!count) return undefined;
    const effectiveReasoning = this.resolveReasoning(request.model, request.reasoningOverride);
    const mapped = await this.mapRequest(
      request,
      signal ?? new AbortController().signal,
      effectiveReasoning.selection
    );
    return count(mapped, signal);
  }

  private async mapRequest(
    request: AgentInferenceRequest,
    signal: AbortSignal,
    effectiveReasoning: ReasoningSelection
  ): Promise<AiRequest> {
    const messages: AiMessage[] = [];
    if (request.systemPrompt) {
      messages.push({ role: 'system', content: [{ kind: 'text', text: request.systemPrompt }] });
    }
    for (const message of request.messages) {
      messages.push(...(await this.mapMessage(message, signal)));
    }
    const mappedReasoning = reasoningRequest(effectiveReasoning);
    return {
      model: request.model,
      messages,
      promptCacheKey: request.promptCacheKey,
      ...(request.tools?.length && {
        tools: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.input_schema,
        })),
      }),
      ...((request.maxTokens !== undefined || mappedReasoning !== undefined) && {
        generation: {
          ...(request.maxTokens !== undefined && { maxOutputTokens: request.maxTokens }),
          ...(mappedReasoning && { reasoning: mappedReasoning }),
        },
      }),
    };
  }

  private async mapMessage(message: Message, signal: AbortSignal): Promise<AiMessage[]> {
    if (typeof message.content === 'string') {
      return [{ role: message.role, content: [{ kind: 'text', text: message.content }] }];
    }
    if (message.role === 'assistant') {
      const content: Extract<AiMessage, { role: 'assistant' }>['content'][number][] = [];
      for (const block of message.content) {
        if (block.type === 'text' && block.text !== undefined)
          content.push({ kind: 'text', text: block.text });
        if (block.type === 'thinking') {
          content.push({
            kind: 'reasoning',
            item: block.signature
              ? {
                  protocol: 'anthropic-thinking',
                  text: block.thinking ?? '',
                  signature: block.signature,
                }
              : { protocol: 'openai-chat', text: block.thinking ?? '' },
          });
        }
        if (block.type === 'redacted_thinking' && block.data !== undefined) {
          content.push({
            kind: 'reasoning',
            item: { protocol: 'anthropic-redacted', data: block.data },
          });
        }
        if (block.type === 'openai_reasoning') {
          content.push({
            kind: 'reasoning',
            item: {
              protocol: 'openai-responses',
              ...(block.id && { id: block.id }),
              summary: block.summary?.map((part) => ({ ...part })) ?? [],
              ...(block.reasoning_content && {
                content: block.reasoning_content.map((part) => ({ ...part })),
              }),
              ...(block.encrypted_content && { encryptedContent: block.encrypted_content }),
              ...(block.status && { status: block.status }),
            },
          });
        }
        if (block.type === 'tool_use' && block.id && block.name) {
          content.push({
            kind: 'tool_call',
            callId: block.id,
            name: block.name,
            arguments:
              typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
            ...(block.provider_item_id && { providerItemId: block.provider_item_id }),
            ...(block.status && { status: block.status }),
          });
        }
      }
      return [{ role: 'assistant', content }];
    }

    const result: AiMessage[] = [];
    let userParts: AiInputPart[] = [];
    const flushUser = () => {
      if (userParts.length === 0) return;
      result.push({ role: 'user', content: userParts });
      userParts = [];
    };
    for (const block of message.content) {
      if (block.type === 'text' && block.text !== undefined) {
        userParts.push({ kind: 'text', text: block.text });
      } else if (block.type === 'image' && block.source) {
        userParts.push({
          kind: 'input_image',
          artifact: await this.storeBase64(block.source.data, block.source.media_type, signal),
        });
      } else if (block.type === 'tool_result' && block.tool_use_id) {
        flushUser();
        result.push({
          role: 'tool',
          toolCallId: block.tool_use_id,
          ...(block.is_error !== undefined && { isError: block.is_error }),
          content: await this.mapToolResult(block.content, signal),
        });
      }
    }
    flushUser();
    return result;
  }

  private async mapToolResult(
    content: string | ToolResultContentBlock[] | undefined,
    signal: AbortSignal
  ): Promise<Extract<AiMessage, { role: 'tool' }>['content']> {
    if (typeof content === 'string' || content === undefined) {
      return [{ kind: 'text', text: content ?? '' }];
    }
    return Promise.all(
      content.map(async (block) => {
        if (block.type === 'text') return { kind: 'text' as const, text: block.text ?? '' };
        if (!block.source) return { kind: 'text' as const, text: '' };
        return {
          kind: 'image' as const,
          artifact: await this.storeBase64(block.source.data, block.source.media_type, signal),
        };
      })
    );
  }

  private async storeBase64(data: string, mimeType: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const stored = await this.artifacts.write(
      {
        bytes: Buffer.from(data, 'base64'),
        mimeType,
      },
      signal
    );
    return stored.ref;
  }

  private async *observeEvents(
    events: AsyncIterable<AiEvent>,
    options: AgentInferenceOptions
  ): AsyncIterable<AiEvent> {
    const maxAttempts = Math.max(0, (this.snapshots.capture()?.policies.ai.maxAttempts ?? 1) - 1);
    let startedAttempt = 0;
    let visibleSequence = 0;
    for await (const event of events) {
      const logicalAttempt = Math.max(0, event.attempt - 1);
      if (event.kind === 'response.started') {
        safelyNotify(options.onAttemptStart, { attempt: 0, maxAttempts });
      } else if (logicalAttempt > startedAttempt && event.kind !== 'response.retrying') {
        startedAttempt = logicalAttempt;
        safelyNotify(options.onAttemptStart, { attempt: logicalAttempt, maxAttempts });
      }
      if (event.kind === 'response.retrying') {
        safelyNotify(options.onBackoff, {
          attempt: event.attempt,
          maxAttempts,
          errorType: classifyGatewayCallError(event.error),
          retryAt: event.retryAt,
          errorMessage: event.error.message,
          diagnostics: { ...event.error.toJSON() },
        });
      }
      if (event.kind === 'reasoning.delta' && event.text.length > 0) {
        safelyNotify(options.onVisibleDelta, {
          runId: event.runId,
          attempt: event.attempt,
          sequence: ++visibleSequence,
          kind: 'think',
          delta: event.text,
        });
      } else if (event.kind === 'text.delta' && event.text.length > 0) {
        safelyNotify(options.onVisibleDelta, {
          runId: event.runId,
          attempt: event.attempt,
          sequence: ++visibleSequence,
          kind: 'text',
          delta: event.text,
        });
      }
      yield event;
    }
  }
}

type NotificationListener = (...args: never[]) => unknown;

const failedNotificationListeners = new WeakSet<NotificationListener>();

function safelyNotify<T>(listener: ((value: T) => void) | undefined, value: T): void {
  if (!listener) return;
  try {
    listener(value);
  } catch (error) {
    if (failedNotificationListeners.has(listener)) return;
    failedNotificationListeners.add(listener);
    appLog.warn({
      event: 'inference.stream.listener.degraded',
      message: 'Inference stream listener failed',
      context: { scope: 'inference.stream' },
      error: error,
    });
  }
}

function mapReasoningItem(item: AiReasoningItem): ContentBlock {
  switch (item.protocol) {
    case 'openai-responses':
      return {
        type: 'openai_reasoning',
        ...(item.id && { id: item.id }),
        summary: item.summary.map((part) => ({ ...part })),
        ...(item.content && { reasoning_content: item.content.map((part) => ({ ...part })) }),
        ...(item.encryptedContent && { encrypted_content: item.encryptedContent }),
        ...(item.status && { status: item.status }),
      };
    case 'openai-chat':
      return { type: 'thinking', thinking: item.text, protocol: 'openai-chat' };
    case 'anthropic-thinking':
      return { type: 'thinking', thinking: item.text, signature: item.signature };
    case 'anthropic-redacted':
      return { type: 'redacted_thinking', data: item.data };
  }
}

function mapToolCallPart(part: Extract<AiAssistantPart, { kind: 'tool_call' }>): ContentBlock {
  let input: unknown = part.arguments;
  try {
    input = JSON.parse(part.arguments);
  } catch {
    // Keep malformed provider arguments available for diagnostics and replay.
  }
  return {
    type: 'tool_use',
    id: part.callId,
    name: part.name,
    input,
    ...(part.providerItemId && { provider_item_id: part.providerItemId }),
    ...(part.status && { status: part.status }),
  };
}
