import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { RequestVM } from '../../data/vm';
import { AIRequestStatus } from '../AIRequestStatus';

function render(request: RequestVM): string {
  return renderToStaticMarkup(createElement(AIRequestStatus, { request }));
}

describe('AIRequestStatus', () => {
  it('shows retry progress using the compact MCP runtime treatment', () => {
    const markup = render({
      retrying: true,
      failed: false,
      backoff: false,
      attempt: 2,
      maxAttempts: 5,
      attemptStartedAt: Date.now(),
    });

    expect(markup).toContain('AI 请求重试中（2/5）');
    expect(markup).toContain('请求中');
    expect(markup).not.toContain('已重试 2 次');
  });

  it('derives the retry countdown from the absolute deadline', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);

    try {
      const markup = render({
        retrying: true,
        failed: false,
        backoff: true,
        attempt: 2,
        maxAttempts: 5,
        retryAt: Date.now() + 8_000,
      });

      expect(markup).toContain('8s 后重试');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the provider message unchanged and renders retry metadata separately', () => {
    const providerMessage = 'Your input exceeds the context window of this model.\nPlease adjust your input and try again.';
    const markup = render({
      retrying: false,
      failed: true,
      backoff: false,
      attempt: 5,
      maxAttempts: 5,
      errorCode: 'invalid_prompt',
      errorMessage: providerMessage,
    });

    expect(markup).toContain(providerMessage);
    expect(markup).toContain('已重试 5 次');
    expect(markup).toContain('invalid_prompt');
    expect(markup).not.toContain(`AI 请求失败（已重试 5 次）：${providerMessage}`);
  });

  it('shows compaction and resend without ordinary retry counters', () => {
    const compacting = render({
      retrying: false,
      failed: false,
      backoff: false,
      activity: 'compacting',
      attempt: 1,
      maxAttempts: 5,
    });
    const resending = render({
      retrying: false,
      failed: false,
      backoff: false,
      activity: 'resending',
      attempt: 1,
      maxAttempts: 5,
    });

    expect(compacting).toContain('正在压缩上下文');
    expect(resending).toContain('上下文已压缩，正在重新请求');
    expect(compacting).not.toContain('1/5');
    expect(resending).not.toContain('1/5');
  });
});
