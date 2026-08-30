/**
 * Token 用量类型
 *
 * 全部数值都来自 provider——响应里的 `usage`，或请求前的 `countTokens`。
 * 本地没有分词器，因此不存在「估算值」这个类别，也就没有可信度分层。
 */

import type { Message, Tool } from './index.js';

/**
 * 当前上下文占用。
 *
 * `limit` 恒有值；`tokens` / `percentage` 同在同无——为空表示
 * **当前模型这把尺子还没量过**（首轮请求前、刚切模型、或该 provider 不报用量），
 * 界面显示「—」，不拿别的尺子的读数充数。
 */
export interface ContextUsage {
  tokens?: number;
  limit: number;
  percentage?: number;
}

/** Provider-measured input total for one completed request, anchored to its assistant response. */
export interface ContextRequestTokenCheckpoint {
  readonly messageIndex: number;
  readonly inputTokens: number;
}

/** 查询时刻从模型请求边界投影出的当前有效上下文。不会持久化。 */
export interface ContextSnapshot {
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly messages: readonly Message[];
  readonly requestTokenCheckpoints: readonly ContextRequestTokenCheckpoint[];
  readonly usage: ContextUsage;
}
