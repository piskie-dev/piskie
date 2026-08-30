/**
 * 上游：openclaw src/plugin-sdk/allow-from.ts（MIT，仅移植被消费的两个函数）
 * 消费方：feishu vendor messaging/inbound/handler.js（发送者白名单匹配）
 */

/** Lowercase and optionally strip prefixes from allowlist entries before sender comparisons. */
export function formatAllowFromLowercase(params: {
  allowFrom: Array<string | number>;
  stripPrefixRe?: RegExp;
}): string[] {
  return params.allowFrom
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .map((entry) => (params.stripPrefixRe ? entry.replace(params.stripPrefixRe, '') : entry))
    .map((entry) => entry.toLowerCase());
}

/** Check whether a sender id matches a simple normalized allowlist with wildcard support. */
export function isNormalizedSenderAllowed(params: {
  senderId: string | number;
  allowFrom: Array<string | number>;
  stripPrefixRe?: RegExp;
}): boolean {
  const normalizedAllow = formatAllowFromLowercase({
    allowFrom: params.allowFrom,
    stripPrefixRe: params.stripPrefixRe,
  });
  if (normalizedAllow.length === 0) {
    return false;
  }
  if (normalizedAllow.includes('*')) {
    return true;
  }
  const sender = String(params.senderId).trim().toLowerCase();
  return normalizedAllow.includes(sender);
}
