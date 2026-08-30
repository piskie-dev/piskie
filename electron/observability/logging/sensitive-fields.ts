const SENSITIVE_KEYS = new Set([
  'authorization',
  'proxyauthorization',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'clientsecret',
  'password',
  'passwd',
  'cookie',
  'setcookie',
  'token',
  'secret',
]);

const REDACTED = '[REDACTED]';

export function isSensitiveLogKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.replace(/[-_]/g, '').toLowerCase());
}

export function redactLogString(value: string, knownSecrets: readonly string[]): string {
  let result = value
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [REDACTED]')
    .replace(/([?&](?:token|access_token|refresh_token|api_key|key|secret|password)=)[^&#\s]*/gi, '$1[REDACTED]');
  for (const secret of knownSecrets) {
    if (secret.length >= 4) result = result.replaceAll(secret, REDACTED);
  }
  return result;
}

export { REDACTED };
