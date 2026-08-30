import type { GatewayCallError } from '../execution/call-error.js';
import type { ArtifactRef, ModelTarget, RunContext } from '../execution/contracts.js';
import type { AIStopReason, ToolInputSchema } from '../../../shared/types/index.js';
import type { AiRunStatistics } from './request-info-collector.js';

export type ImageDetail = 'auto' | 'low' | 'high';

export type AiInputPart =
  | { kind: 'text'; text: string }
  | { kind: 'input_image'; artifact: ArtifactRef; detail?: ImageDetail };

export type AiReasoningItem =
  | {
      protocol: 'openai-responses';
      id?: string;
      summary: readonly { type: 'summary_text'; text: string }[];
      content?: readonly { type: 'reasoning_text'; text: string }[];
      encryptedContent?: string;
      status?: 'in_progress' | 'completed' | 'incomplete';
    }
  | { protocol: 'openai-chat'; text: string }
  | { protocol: 'anthropic-thinking'; text: string; signature: string }
  | { protocol: 'anthropic-redacted'; data: string };

export type AiAssistantPart =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; item: AiReasoningItem }
  | {
      kind: 'tool_call';
      callId: string;
      name: string;
      arguments: string;
      providerItemId?: string;
      status?: 'in_progress' | 'completed' | 'incomplete';
    };

export type AiToolResultPart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; artifact: ArtifactRef };

export type AiMessage =
  | { role: 'system' | 'user'; content: readonly AiInputPart[] }
  | { role: 'assistant'; content: readonly AiAssistantPart[] }
  | { role: 'tool'; toolCallId: string; isError?: boolean; content: readonly AiToolResultPart[] };

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}

export type ResponseFormat =
  | { kind: 'text' }
  | { kind: 'json_object' }
  | { kind: 'json_schema'; name: string; schema: Record<string, unknown>; strict?: boolean };

export type ReasoningRequest =
  | { kind: 'disabled' }
  | { kind: 'enabled' }
  | { kind: 'effort'; effort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' }
  | { kind: 'budget'; tokens: number };

export interface GenerationOptions {
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: readonly string[];
  reasoning?: ReasoningRequest;
}

export interface AiRequest {
  model: ModelTarget;
  promptCacheKey?: string;
  messages: readonly AiMessage[];
  tools?: readonly ToolDefinition[];
  responseFormat?: ResponseFormat;
  generation?: GenerationOptions;
  extensions?: Readonly<Record<string, unknown>>;
}

/**
 * 归一化后的用量。只由 `usage-normalizer.ts` 的 `normalizeUsage` 产出，
 * 上层直接用，**不要再对任何两个字段做加法**。
 */
export interface AiUsage {
  /** 模型本次实际处理的全部输入 token（缓存读写已按 provider 语义并入或已含其中） */
  totalInputTokens?: number;
  /** 本次全部输出 token（含 reasoning / thinking） */
  totalOutputTokens?: number;

  // —— 以下均为上面两项的「其中」，仅供观察，任何情况下都不参与求和 ——
  /** 命中缓存读取的部分，已含于 totalInputTokens */
  cachedInputTokens?: number;
  /** 写入缓存的部分，已含于 totalInputTokens */
  cacheWriteTokens?: number;
  /** 思考 token，已含于 totalOutputTokens */
  reasoningTokens?: number;
}

export type AiStopReason = AIStopReason;

interface AiEventBase {
  runId: string;
  sequence: number;
  attempt: number;
  emittedAt: number;
}

export type AiEvent =
  | (AiEventBase & {
      kind: 'response.started';
      model: ModelTarget;
      configRevision: number;
    })
  | (AiEventBase & { kind: 'response.retrying'; retryAt: number; error: GatewayCallError })
  | (AiEventBase & { kind: 'text.delta'; text: string })
  | (AiEventBase & { kind: 'reasoning.delta'; text: string })
  | (AiEventBase & { kind: 'reasoning.signature'; signature: string })
  | (AiEventBase & { kind: 'reasoning.item'; item: AiReasoningItem })
  | (AiEventBase & {
      kind: 'tool.started';
      callId: string;
      name: string;
      providerItemId?: string;
      status?: 'in_progress' | 'completed' | 'incomplete';
    })
  | (AiEventBase & { kind: 'tool.arguments.delta'; callId: string; delta: string })
  | (AiEventBase & { kind: 'tool.completed'; callId: string })
  | (AiEventBase & { kind: 'usage.updated'; usage: AiUsage })
  | (AiEventBase & { kind: 'response.completed'; stopReason: AiStopReason })
  | (AiEventBase & { kind: 'response.failed'; error: GatewayCallError })
  | (AiEventBase & { kind: 'response.cancelled'; reason?: string });

export type AiAttemptEvent =
  | { kind: 'text.delta'; text: string }
  | { kind: 'reasoning.delta'; text: string }
  | { kind: 'reasoning.signature'; signature: string }
  | { kind: 'reasoning.item'; item: AiReasoningItem }
  | {
      kind: 'tool.started';
      callId: string;
      name: string;
      providerItemId?: string;
      status?: 'in_progress' | 'completed' | 'incomplete';
    }
  | { kind: 'tool.arguments.delta'; callId: string; delta: string }
  | { kind: 'tool.completed'; callId: string }
  | { kind: 'usage.updated'; usage: AiUsage }
  | { kind: 'response.completed'; stopReason: AiStopReason };

export interface AiToolCallResult {
  callId: string;
  name: string;
  argumentsText: string;
  arguments?: unknown;
  providerItemId?: string;
  status?: 'in_progress' | 'completed' | 'incomplete';
}

export interface AiResult {
  runId: string;
  model: ModelTarget;
  configRevision: number;
  text: string;
  reasoning: string;
  reasoningSignature?: string;
  content: readonly AiAssistantPart[];
  reasoningItems: readonly AiReasoningItem[];
  toolCalls: readonly AiToolCallResult[];
  usage: AiUsage;
  stopReason: AiStopReason;
}

export interface AiRunHandle {
  events: AsyncIterable<AiEvent>;
  statistics: Promise<AiRunStatistics>;
}

export interface AiGateway {
  open(request: AiRequest, context: RunContext): AiRunHandle;
  complete(request: AiRequest, context: RunContext): Promise<AiResult>;
}
