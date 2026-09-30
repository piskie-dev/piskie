import type { GatewayCallError } from '../execution/call-error.js';

const AUTHORIZATION_ERROR_CODES: ReadonlySet<string> = new Set([
  'invalid_api_key',
  'authentication_error',
  'permission_error',
  'permission_denied',
]);
const NON_RETRYABLE_PROVIDER_STATUSES: ReadonlySet<number> = new Set([401, 403]);

export function canRetryAiAttempt(error: GatewayCallError): boolean {
  if (error.source === 'local' || error.source === 'cancelled') return false;

  const upstream = error.upstream;
  if (upstream) {
    if (upstream.status !== undefined && NON_RETRYABLE_PROVIDER_STATUSES.has(upstream.status)) return false;
    if (upstream.code === 'context_length_exceeded') return false;
    if (upstream.code && AUTHORIZATION_ERROR_CODES.has(upstream.code)) return false;
    if (upstream.type && AUTHORIZATION_ERROR_CODES.has(upstream.type)) return false;
  }

  return true;
}

export function retryDelayMs(baseDelayMs: number, failedAttempt: number): number {
  return Math.min(baseDelayMs * 2 ** Math.max(0, failedAttempt - 1), 30_000);
}
