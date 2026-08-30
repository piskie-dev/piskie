import { describe, expect, it } from 'vitest';
import { DEFAULT_AI_RETRY_BASE_DELAY_MS } from '../../control/config-schema.js';
import { emptyInferenceConfig } from '../../control/bootstrap-config.js';
import { GatewayCallError } from '../../execution/call-error.js';
import { canRetryAiAttempt, retryDelayMs } from '../retry-decision.js';

describe('AI retry policy', () => {
  it('starts at three seconds, doubles, and retains the thirty-second cap', () => {
    expect(emptyInferenceConfig().policies.ai.retryBaseDelayMs).toBe(DEFAULT_AI_RETRY_BASE_DELAY_MS);
    expect([
      retryDelayMs(DEFAULT_AI_RETRY_BASE_DELAY_MS, 1),
      retryDelayMs(DEFAULT_AI_RETRY_BASE_DELAY_MS, 2),
      retryDelayMs(DEFAULT_AI_RETRY_BASE_DELAY_MS, 3),
      retryDelayMs(DEFAULT_AI_RETRY_BASE_DELAY_MS, 4),
      retryDelayMs(DEFAULT_AI_RETRY_BASE_DELAY_MS, 5),
    ]).toEqual([3_000, 6_000, 12_000, 24_000, 30_000]);
  });

  it('never retries a structured context overflow even with a retryable HTTP status', () => {
    const error = new GatewayCallError({
      source: 'provider',
      gateway: 'ai',
      providerId: 'provider',
      modelId: 'model',
      driverId: 'openai',
      stage: 'stream',
      attempt: 1,
      traceId: 'trace-overflow',
      message: 'provider-specific text',
      upstream: {
        status: 429,
        code: 'context_length_exceeded',
        message: 'provider-specific text',
      },
    });

    expect(canRetryAiAttempt(error)).toBe(false);
  });

  it('retries a structured provider overload without an HTTP status', () => {
    const error = new GatewayCallError({
      source: 'provider',
      gateway: 'ai',
      providerId: 'provider',
      modelId: 'model',
      driverId: 'openai',
      stage: 'request',
      attempt: 1,
      traceId: 'trace-overload',
      message: 'Our servers are currently overloaded. Please try again later.',
      upstream: {
        code: 'server_is_overloaded',
        type: 'service_unavailable_error',
        message: 'Our servers are currently overloaded. Please try again later.',
      },
    });

    expect(canRetryAiAttempt(error)).toBe(true);
  });
});
