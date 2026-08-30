/**
 * AI 请求失败的规整形态与记录凭据。
 *
 * RecordedAIRequestError 是"该失败已写入唯一一条最终 AgentIncident"的**类型凭据**：
 * 只能在写入事实之后创建（callAI 的 catch 是 turn 链路唯一写入点），消费方
 * （handlePumpFailure）只认类型、不比实例。凭据由错误类型承载——违约 provider
 * throw string / frozen Error 也能经 normalize 规整（symbol 属性在 primitive/
 * frozen 对象上打不上，类型凭据没有这个问题）。
 */

import type { AIErrorType } from '../../../shared/constants/index.js';
import { AIErrorType as ErrorType } from '../../../shared/constants/index.js';
import { classifyGatewayCallError, isGatewayCallError } from '../../inference/execution/call-error.js';

/** 规整后的 AI 请求失败信息（展示/记录用） */
export interface AIRequestFailure {
  /** 展示用错误消息（已脱敏规整） */
  message: string;
  /** 分类后的错误类型码 */
  errorType: AIErrorType;
  /** 安全的 provider 底层错误诊断信息 */
  diagnostics?: Record<string, unknown>;
}

/** 把任意 throw 物（含 string / frozen Error）规整为可记录的失败形态 */
export function normalizeAIRequestFailure(error: unknown): AIRequestFailure {
  if (isGatewayCallError(error)) {
    return {
      message: error.message,
      errorType: classifyGatewayCallError(error),
      diagnostics: { ...error.toJSON() },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    message,
    errorType: ErrorType.UNKNOWN,
    ...(error instanceof Error && {
      diagnostics: { name: error.name, message: error.message },
    }),
  };
}

export class RecordedAIRequestError extends Error {
  readonly failure: AIRequestFailure;

  constructor(failure: AIRequestFailure, cause: unknown) {
    super(failure.message, { cause });
    this.name = 'RecordedAIRequestError';
    this.failure = failure;
  }
}
