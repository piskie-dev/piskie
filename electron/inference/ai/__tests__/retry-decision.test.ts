import { describe, expect, it } from 'vitest';
import { DEFAULT_AI_RETRY_BASE_DELAY_MS } from '../../control/config-schema.js';
import { emptyInferenceConfig } from '../../control/bootstrap-config.js';
import { GatewayCallError, type GatewayErrorSource, type UpstreamErrorDetails } from '../../execution/call-error.js';
import { canRetryAiAttempt, retryDelayMs } from '../retry-decision.js';

function error(source: GatewayErrorSource, upstream?: Partial<UpstreamErrorDetails>): GatewayCallError {
  return new GatewayCallError({
    source,
    gateway: 'ai',
    providerId: 'provider',
    modelId: 'model',
    driverId: 'test-driver',
    stage: 'request',
    attempt: 1,
    traceId: 'trace-retry',
    message: 'Sample upstream failure',
    ...(upstream && { upstream: { message: 'Sample upstream failure', ...upstream } }),
  });
}

describe('AI retry policy', () => {
  it('defaults to three total attempts with exponential backoff capped at thirty seconds', () => {
    expect(emptyInferenceConfig().policies.ai.maxAttempts).toBe(3);
    expect(emptyInferenceConfig().policies.ai.retryBaseDelayMs).toBe(DEFAULT_AI_RETRY_BASE_DELAY_MS);
    expect([
      retryDelayMs(DEFAULT_AI_RETRY_BASE_DELAY_MS, 1),
      retryDelayMs(DEFAULT_AI_RETRY_BASE_DELAY_MS, 2),
      retryDelayMs(DEFAULT_AI_RETRY_BASE_DELAY_MS, 3),
      retryDelayMs(DEFAULT_AI_RETRY_BASE_DELAY_MS, 4),
      retryDelayMs(DEFAULT_AI_RETRY_BASE_DELAY_MS, 5),
    ]).toEqual([3_000, 6_000, 12_000, 24_000, 30_000]);
  });

  it.each([
    { code: 'sample_unknown_error' },
    { code: 'sample_unknown_error', status: 400 },
    { code: 'sample_unknown_error', status: 422 },
    { code: 'upstream_stream_read_error' },
    { code: 'stream_read_error' },
    { code: 'server_is_overloaded' },
    { status: 408 },
    { status: 409 },
    { status: 425 },
    { status: 429 },
    { status: 503 },
    {},
  ])('retries upstream failures by default: %j', (upstream) => {
    expect(canRetryAiAttempt(error('provider', upstream))).toBe(true);
  });

  it.each([
    { code: 'context_length_exceeded', status: 429 },
    { code: 'invalid_api_key' },
    { type: 'authentication_error' },
    { type: 'permission_error' },
    { code: 'permission_denied' },
    { status: 401, code: 'sample_unknown_error' },
    { status: 403, code: 'server_is_overloaded' },
  ])('stops for explicit unrecoverable upstream details: %j', (upstream) => {
    expect(canRetryAiAttempt(error('provider', upstream))).toBe(false);
  });

  it.each(['local', 'cancelled'] as const)('never retries %s failures', (source) => {
    expect(canRetryAiAttempt(error(source, { status: 503 }))).toBe(false);
  });

  it.each(['transport', 'timeout'] as const)('retries %s failures', (source) => {
    expect(canRetryAiAttempt(error(source))).toBe(true);
  });

  it.each([
    'invalid_api_key',
    'authentication_error',
    'permission_denied',
    'context_length_exceeded',
    'stream_read_error',
  ])('does not classify provider message text: %s', (message) => {
    expect(canRetryAiAttempt(error('provider', { message }))).toBe(true);
  });
});
