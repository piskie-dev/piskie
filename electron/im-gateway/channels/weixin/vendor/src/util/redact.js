const DEFAULT_BODY_MAX_LEN = 200;
const DEFAULT_TOKEN_PREFIX_LEN = 6;
/**
 * Truncate a string, appending a length indicator when trimmed.
 * Returns `""` for empty/undefined input.
 */
export function truncate(s, max) {
    if (!s)
        return "";
    if (s.length <= max)
        return s;
    return `${s.slice(0, max)}…(len=${s.length})`;
}
/**
 * Redact a token/secret: show only the first few chars + total length.
 * Returns `"(none)"` when absent.
 */
export function redactToken(token, prefixLen = DEFAULT_TOKEN_PREFIX_LEN) {
    if (!token)
        return "(none)";
    if (token.length <= prefixLen)
        return `****(len=${token.length})`;
    return `${token.slice(0, prefixLen)}…(len=${token.length})`;
}
/** Field names whose values should be masked in logged JSON bodies. */
const SENSITIVE_STRING_FIELDS = "context_token|bot_token|token|authorization|Authorization|aeskey|aes_key|qrcode|verify_code|run_id|tool_call_id|toolCallId";
/**
 * Truncate a JSON body string to `maxLen` chars for safe logging.
 * Redacts known sensitive fields before truncating.
 */
export function redactBody(body, maxLen = DEFAULT_BODY_MAX_LEN) {
    if (!body)
        return "(empty)";
    // Mask values of known sensitive JSON keys: "key":"value" → "key":"<redacted>"
    const stringPattern = new RegExp(`"(${SENSITIVE_STRING_FIELDS})"\\s*:\\s*"[^"]*"`, "g");
    const redacted = body
        .replace(stringPattern, '"$1":"<redacted>"')
        .replace(/"local_token_list"\s*:\s*\[[^\]]*\]/g, '"local_token_list":["<redacted>"]');
    if (redacted.length <= maxLen)
        return redacted;
    return `${redacted.slice(0, maxLen)}…(truncated, totalLen=${redacted.length})`;
}
/**
 * Strip query string (which often contains signatures/tokens) from a URL,
 * keeping only origin + pathname.
 */
export function redactUrl(rawUrl) {
    try {
        const u = new URL(rawUrl);
        const base = `${u.origin}${u.pathname}`;
        return u.search ? `${base}?<redacted>` : base;
    }
    catch {
        return truncate(rawUrl, 80);
    }
}
