import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appLog } from '../../observability/logging/app-log.js';
import { normalizeSearchError } from '../errors.js';

vi.mock('../../observability/logging/app-log.js', () => ({ appLog: { warn: vi.fn() } }));
beforeEach(() => vi.clearAllMocks());

describe('search failure diagnostics', () => {
  it('classifies address timeouts inside fetch and aggregate errors as a timeout', () => {
    const error = new TypeError('fetch failed', { cause: new AggregateError([
      Object.assign(new Error('Connection attempt failed'), { code: 'ETIMEDOUT' }),
      Object.assign(new Error('Address unavailable'), { code: 'ENETUNREACH' }),
    ]) });
    expect(normalizeSearchError(error, new AbortController().signal).failure)
      .toMatchObject({ code: 'timeout', message: '搜索请求超时，请稍后重试。' });
    expect(appLog.warn).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ code: 'timeout' }),
    }));
  });

  it('recognizes the HTTP connector timeout through an SDK wrapper', () => {
    const error = new Error('Connection failed', { cause: new TypeError('fetch failed', {
      cause: Object.assign(new Error('Connection attempt failed'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
    }) });
    expect(normalizeSearchError(error, new AbortController().signal).failure.code).toBe('timeout');
  });

  it('keeps the network cause chain in logs and redacts the current credential', () => {
    const network = Object.assign(new Error('Connection closed for fake-access-value'), { code: 'ECONNRESET' });
    const error = new Error('Version negotiation probe failed: fetch failed', {
      cause: new TypeError('fetch failed', { cause: new AggregateError([network]) }),
    });
    const failure = normalizeSearchError(error, new AbortController().signal, ['fake-access-value']);
    expect(failure.failure.code).toBe('upstream_error');
    expect(appLog.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'search.request.failed', context: expect.objectContaining({ causes: expect.arrayContaining([
        expect.objectContaining({ code: 'ECONNRESET', message: 'Connection closed for [redacted]' }),
      ]) }),
    }));
    expect(JSON.stringify(vi.mocked(appLog.warn).mock.calls)).not.toContain('fake-access-value');
    expect(failure.message).not.toContain('ECONNRESET');
  });

  it('preserves caller cancellation without logging it as a search failure', () => {
    const controller = new AbortController();
    const reason = new Error('Sample cancellation');
    controller.abort(reason);
    expect(() => normalizeSearchError(new Error('Transport closed'), controller.signal)).toThrow(reason);
    expect(appLog.warn).not.toHaveBeenCalled();
  });
});
