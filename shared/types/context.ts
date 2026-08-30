/**
 * 上下文压缩相关类型定义
 */

import type { Message, MessageSubtype, AIStopReason } from './index.js';
import type { ReasoningSelection } from './reasoning.js';

// ============================================================
// 增强消息类型
// ============================================================

/**
 * 增强的消息类型，包含压缩相关元数据
 */
/** 一次已成功结算的 Agent 逻辑 AI 请求。 */
export interface AIRequestInfo {
  version: 1;
  /** 逻辑推理请求 ID；retry/overflow 重发保持不变。 */
  requestId: string;
  /** 最终成功的 Gateway run。 */
  runId: string;
  model: string;
  stopReason: AIStopReason;
  /** 整个逻辑请求耗时，包含 retry、backoff 与 overflow recovery。 */
  latencyMs: number;
  /** 最终成功 Provider attempt 到首个非空 Think/正文 delta。 */
  firstVisibleContentLatencyMs?: number;
  /** 首个非空 Think/正文 delta 到 response.completed。 */
  generationDurationMs?: number;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    /** 明细，已包含在 inputTokens 中。 */
    cacheReadTokens?: number;
    /** 明细，已包含在 inputTokens 中。 */
    cacheWriteTokens?: number;
    /** 明细，已包含在 outputTokens 中。 */
    reasoningTokens?: number;
  };
  effectiveReasoning?: {
    selection: ReasoningSelection;
    source: 'agent' | 'model' | 'catalog' | 'provider-default';
    nativeParameters: Record<string, unknown>;
  };
}

export interface EnhancedMessage extends Message {
  /** 消息唯一 ID */
  id: string;
  /** 消息时间戳 */
  timestamp: number;
  /** 是否已持久化到 conversation.jsonl（flush 脏标记） */
  persisted?: boolean;
  /** Persisted only for user-role tool_result messages. */
  toolResultOk?: boolean;
}

/**
 * 上下文摘要
 */
export interface ContextSummary {
  /** 摘要唯一 ID */
  id: string;
  /** 直接注入模型并交给 UI 渲染的 Markdown 原文 */
  markdown: string;
  /** 被压缩的消息数量 */
  compressedCount: number;
  /** 压缩前那一轮 provider 实报的输入 token（精确值） */
  originalTokens: number;
  /** 创建时间戳 */
  createdAt: number;
  /** 原始消息文件路径（临时文件，用于 UI 展示） */
  originalMessagesFile?: string;
}

/** Renderer-facing compaction metadata. Storage paths stay in the main process. */
export interface CompactionSummaryView {
  id: string;
  markdown: string;
  compressedCount: number;
  originalTokens: number;
  createdAt: number;
  hasOriginalMessages: boolean;
}

export interface CompactionHistoryView {
  summaries: CompactionSummaryView[];
  stats: {
    totalCompactions: number;
  };
}

export interface CompactionMessageView {
  role: 'user' | 'assistant';
  content: Message['content'];
  timestamp: number;
  subtype?: MessageSubtype;
}

export interface CompactionMessagePage {
  items: CompactionMessageView[];
  total: number;
  nextOffset?: number;
}

// ============================================================
// 增强的 AI 上下文
// ============================================================

/**
 * 增强的 AI 上下文
 */
export interface EnhancedAIContext {
  /** 历史摘要列表（按时间顺序） */
  summaries: ContextSummary[];
  /** 完整消息历史 */
  fullMessages: EnhancedMessage[];
}

// ============================================================
// 压缩结果
// ============================================================

/**
 * 压缩操作结果
 */
export interface CompactionResult {
  /** 是否成功 */
  success: boolean;
  /** 失败原因 */
  reason?: string;
  /** 生成的摘要 */
  summary?: ContextSummary;
  /** 被压缩的消息数量 */
  compressedCount?: number;
}
