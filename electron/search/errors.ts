import type { SearchCapabilities, SearchErrorCode } from '../../shared/types/web-search.js';
import { sanitizeMcpErrorText } from '../mcp/security/sanitize.js';
import { appLog } from '../observability/logging/app-log.js';
import { normalizeLogError } from '../observability/logging/event-normalizer.js';
import { SearchError } from './contracts.js';

const messages: Record<SearchErrorCode, string> = {
  disabled: '网页搜索已关闭，请在设置的工具中开启。',
  not_configured: '请选择已启用的网页搜索供应商。',
  auth_required: '搜索认证不可用，请在工具设置中补充 API Key 或重新登录。',
  rate_limited: '搜索请求受到供应商限流，请稍后重试或在工具设置中配置个人凭据。',
  quota_exhausted: '搜索额度已用完，请检查供应商账户额度。',
  timeout: '搜索请求超时，请稍后重试。',
  upstream_error: '搜索服务暂时不可用，请稍后重试。',
  invalid_response: '搜索服务返回了无法使用的结果。',
  unsupported_filter: '当前搜索配置不支持指定的筛选条件，请选择支持这些条件的供应商。',
};

export function searchError(code: SearchErrorCode): SearchError {
  return new SearchError({ code, message: messages[code] });
}

export function unsupportedSearchFilters(fields: readonly (keyof SearchCapabilities)[]): SearchError {
  return new SearchError({ code: 'unsupported_filter',
    message: `当前搜索配置不支持筛选参数：${fields.join('、')}。请在工具设置中选择支持这些条件的供应商。`,
  });
}

/** HTTP/SDK errors and MCP business failures enter the same public failure contract. */
export function normalizeSearchError(error: unknown, signal: AbortSignal, secrets: readonly string[] = []): SearchError {
  signal.throwIfAborted();
  if (error instanceof SearchError) return error;
  const record = error !== null && typeof error === 'object' ? error as Record<string, unknown> : {};
  const data = record.data !== null && typeof record.data === 'object' ? record.data as Record<string, unknown> : {};
  const status = record.status ?? record.statusCode ?? data.status ?? record.code;
  const message = sanitizeMcpErrorText(error, { additionalSecrets: secrets });
  const pending = [normalizeLogError(error)];
  const causes: Array<{ name: string; message: string; code?: string }> = [];
  while (pending.length) {
    const detail = pending.shift()!;
    const sanitize = (value: string) => sanitizeMcpErrorText(value, { additionalSecrets: secrets });
    causes.push({ name: sanitize(detail.name), message: sanitize(detail.message),
      ...(detail.code ? { code: sanitize(detail.code) } : {}) });
    if (detail.cause) pending.push(detail.cause);
    if (detail.errors) pending.push(...detail.errors);
  }
  let code: SearchErrorCode = 'upstream_error';
  if (status === 401 || status === 403 || record.name === 'UnauthorizedError' || /unauthorized|invalid.api.key|authentication required|invalid.token/i.test(message)) {
    code = 'auth_required';
  } else if (status === 402 || /quota.exhausted|insufficient.credits|payment.required|credits?.*(?:exhausted|depleted)/i.test(message)) {
    code = 'quota_exhausted';
  } else if (status === 429 || /rate.limit|too.many.requests/i.test(message)) {
    code = 'rate_limited';
  } else if (status === -32001 || causes.some((cause) => (
    cause.name === 'TimeoutError' || cause.code === 'ETIMEDOUT' || cause.code === 'UND_ERR_CONNECT_TIMEOUT'
    || /timed.out|timeout/i.test(cause.message)
  ))) {
    code = 'timeout';
  }
  appLog.warn({ event: 'search.request.failed', message: 'Search request failed',
    context: { scope: 'search', code, causes },
  });
  return searchError(code);
}
