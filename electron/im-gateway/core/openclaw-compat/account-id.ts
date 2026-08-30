/**
 * 上游：openclaw src/routing/session-key.ts（MIT）
 * 消费方：feishu vendor（core/accounts.js、channel/config-adapter.js 等）
 */

export const DEFAULT_ACCOUNT_ID = 'default';

/** 账号 ID 规整，保持与 OpenClaw canonicalizeAccountId 相同的兼容行为。 */
function canonicalizeVendorAccountKey(value: string): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return '';
  const lowered = trimmed.toLowerCase();
  if (/^[a-z0-9][a-z0-9_-]*$/.test(lowered)) return lowered;

  let encoded = '';
  for (let index = 0; index < lowered.length; index += 1) {
    const code = lowered.charCodeAt(index);
    const allowed = (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 45;
    encoded += allowed ? lowered[index] : '-';
  }

  let start = 0;
  let end = encoded.length;
  while (encoded[start] === '-') start += 1;
  while (end > start && encoded[end - 1] === '-') end -= 1;
  return encoded.slice(start, end).slice(0, 64);
}

export const normalizeAccountId = canonicalizeVendorAccountKey;
