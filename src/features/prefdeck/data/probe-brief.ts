/**
 * 探测回执的失败呈现（重写）。
 *
 * 上游错误保持原始字段(Inference 层约定不清洗):这里只做"取阅"——
 * 摘要按 upstream.message → error.message → body 内常见字段的顺序取第一个,
 * 原文完整保留供复制;HTTP 状态/错误码/类型/requestId 有则带上。
 */

import type { InferenceProbeReceipt } from '../../../../shared/types/inference';
import {
  messageText,
  rawText as rawPresentationText,
  type PresentationText,
} from '../../../i18n/presentationText';
import { recordOf } from './record-shape';

export interface ProbeFailureBrief {
  readonly headline: PresentationText;
  readonly rawText: string;
  readonly httpStatus?: number;
  readonly code?: string;
  readonly kind?: string;
  readonly requestId?: string;
}

export function briefProbeFailure(
  receipt: InferenceProbeReceipt,
  fallbackHeadline: PresentationText = messageText('settings.provider.upstreamRequestFailed'),
): ProbeFailureBrief {
  const error = recordOf(receipt.error);
  const upstream = recordOf(error?.upstream);
  const body = upstream?.body;
  const httpStatus = pickNumber(receipt.status) ?? pickNumber(upstream?.status);
  const requestId = pickText(receipt.requestId) ?? pickText(upstream?.requestId);
  const code = pickText(upstream?.code);
  const kind = pickText(upstream?.type);
  const headlineFact = pickText(upstream?.message)
    ?? pickText(error?.message)
    ?? headlineFromBody(body);
  const headline = headlineFact ? rawPresentationText(headlineFact) : fallbackHeadline;

  return {
    headline,
    rawText: renderRaw(body !== undefined ? body : receipt.error ?? headlineFact ?? ''),
    ...(httpStatus !== undefined && { httpStatus }),
    ...(code && { code }),
    ...(kind && { kind }),
    ...(requestId && { requestId }),
  };
}

/** 探测耗时(毫秒);时间戳异常回落 0 */
export function probeElapsedMs(receipt: InferenceProbeReceipt): number {
  const from = Date.parse(receipt.startedAt);
  const to = Date.parse(receipt.completedAt);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, to - from);
}

function headlineFromBody(body: unknown): string | undefined {
  if (typeof body === 'string' && body) return body;
  const shape = recordOf(body);
  if (!shape) return undefined;
  return pickText(shape.message)
    ?? pickText(shape.detail)
    ?? pickText(shape.error)
    ?? pickText(recordOf(shape.error)?.message);
}

function renderRaw(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function pickText(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function pickNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
