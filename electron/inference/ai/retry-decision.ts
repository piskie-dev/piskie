import type { GatewayCallError } from '../execution/call-error.js';

type ProviderCodeRetryDecision = 'retry' | 'do_not_retry';

const PROVIDER_CODE_RETRY_DECISIONS: ReadonlyMap<string, ProviderCodeRetryDecision> = new Map([
  ['context_length_exceeded', 'do_not_retry'],
  ['server_is_overloaded', 'retry'],
]);
const RETRYABLE_PROVIDER_STATUSES: ReadonlySet<number> = new Set([408, 409, 425, 429]);

export function canRetryAiAttempt(error: GatewayCallError): boolean {
  if (error.source === 'transport' || error.source === 'timeout') return true;
  if (error.source !== 'provider') return false;

  const code = error.upstream?.code;
  const codeDecision = code ? PROVIDER_CODE_RETRY_DECISIONS.get(code) : undefined;
  if (codeDecision !== undefined) return codeDecision === 'retry';

  const status = error.upstream?.status;
  return status !== undefined && (RETRYABLE_PROVIDER_STATUSES.has(status) || status >= 500);
}

export function retryDelayMs(baseDelayMs: number, failedAttempt: number): number {
  return Math.min(baseDelayMs * 2 ** Math.max(0, failedAttempt - 1), 30_000);
}
