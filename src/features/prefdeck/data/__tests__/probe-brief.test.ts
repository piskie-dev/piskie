import { describe, expect, it } from 'vitest';

import type { InferenceProbeReceipt } from '../../../../../shared/types/inference';
import { messageText, rawText } from '../../../../i18n/presentationText';
import { briefProbeFailure, probeElapsedMs } from '../probe-brief';

function receipt(overrides: Partial<InferenceProbeReceipt>): InferenceProbeReceipt {
  return {
    providerId: 'p1',
    modelId: 'm1',
    success: false,
    startedAt: '2026-08-20T00:00:00.000Z',
    completedAt: '2026-08-20T00:00:00.812Z',
    ...overrides,
  } as InferenceProbeReceipt;
}

describe('briefProbeFailure', () => {
  it('优先取 upstream.message,原文保留 body,状态字段齐备', () => {
    const brief = briefProbeFailure(receipt({
      status: 401,
      requestId: 'req-9',
      error: {
        message: '外层消息',
        upstream: {
          message: '密钥无效',
          code: 'invalid_api_key',
          type: 'auth_error',
          body: { error: { message: '密钥无效' } },
        },
      },
    }));
    expect(brief.headline).toEqual(rawText('密钥无效'));
    expect(brief.httpStatus).toBe(401);
    expect(brief.code).toBe('invalid_api_key');
    expect(brief.kind).toBe('auth_error');
    expect(brief.requestId).toBe('req-9');
    expect(brief.rawText).toContain('密钥无效');
  });

  it('无 upstream 时回落 error.message,再回落 body 常见字段,最后兜底文案', () => {
    expect(briefProbeFailure(receipt({ error: { message: '连接被拒绝' } })).headline)
      .toEqual(rawText('连接被拒绝'));
    expect(briefProbeFailure(receipt({
      error: { upstream: { body: { detail: '配额用尽' } } },
    })).headline).toEqual(rawText('配额用尽'));
    expect(briefProbeFailure(receipt({})).headline)
      .toEqual(messageText('settings.provider.upstreamRequestFailed'));
  });
});

describe('probeElapsedMs', () => {
  it('按时间戳求毫秒差;异常时间回落 0', () => {
    expect(probeElapsedMs(receipt({}))).toBe(812);
    expect(probeElapsedMs(receipt({ startedAt: '无效' }))).toBe(0);
  });
});
