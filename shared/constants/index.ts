/**
 * PISKIE 共享常量定义
 */

import type { AppSettings } from '../types/index.js';
import { APP_BG_MASK_DEFAULT } from './theme-background.js';

// ============================================================
// Agent 配置常量
// ============================================================

/**
 * stalled 看门狗阈值（替代 heartbeat）：
 * worker 首次空闲超过该时长时请求一次任务状态确认；确认后再次超过门限才上报 stalled。
 */
export const STALLED_CONFIG = {
  /** 默认 stalled 判定阈值（毫秒）：10 分钟 */
  defaultStalledAfterMs: 10 * 60 * 1000,
};

/**
 * 上下文压缩配置
 *
 * 设计原则（参照 Claude Code）：
 * - 触发压缩后，所有消息都压缩成摘要
 * - 不保留任何历史消息，依靠摘要恢复上下文
 */
export const CONTEXT_COMPACTION_CONFIG = {
  /** 触发压缩的 token 使用率阈值 (0-1)，达到此阈值自动触发压缩 */
  triggerThreshold: 0.85,
};

/**
 * AI 重试配置
 * AI 错误类型枚举
 */
export enum AIErrorType {
  /** 速率限制（需要等待） */
  RATE_LIMIT = 'rate_limit',
  /** 超时（可能需要减少请求大小） */
  TIMEOUT = 'timeout',
  /** 网络错误（可重试） */
  NETWORK = 'network',
  /** API 错误（可能不可重试） */
  API_ERROR = 'api_error',
  /**
   * 空完成响应：provider 报告流正常完成（finishReason 已收到）
   * 但内容块为零。最多保护性重试一次（固定策略，不受 provider maxRetries 配置覆盖）。
   */
  EMPTY_COMPLETED_RESPONSE = 'empty_completed_response',
  /**
   * 上下文超出模型窗口。它**不进** `canRetryAiAttempt`——
   * 那里是「原样重试」，而这里必须先压缩再重发，是不同的动作。
   */
  CONTEXT_OVERFLOW = 'context_overflow',
  /** 未知错误 */
  UNKNOWN = 'unknown',
}

// ============================================================
// 默认配置
// ============================================================

export const DEFAULT_SETTINGS = {
  theme: 'auto',
  language: 'en-US',
  navEdgeDockEnabled: true,
  navPrismEnabled: true,
  navPrismSpot: null,
  backgroundImage: null,
  backgroundMaskOpacity: APP_BG_MASK_DEFAULT,
} satisfies AppSettings;
