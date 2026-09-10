import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callSearchMcp } from '../mcp-client.js';
import { connectHttpMcpClient } from '../../mcp/client/connection.js';

vi.mock('../../mcp/client/connection.js', () => ({ connectHttpMcpClient: vi.fn() }));

const endpoint = { url: 'https://example.org/mcp', headers: {}, tool: 'search' };
const dependencies = { fetch: globalThis.fetch, auth: { kind: 'anonymous' as const } };

beforeEach(() => vi.resetAllMocks());

describe('search client cancellation and ownership', () => {
  it('passes the original signal to connection and call, closing after success', async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'Evidence' }] }));
    const close = vi.fn();
    vi.mocked(connectHttpMcpClient).mockResolvedValue({ client: { callTool }, close } as never);
    const signal = new AbortController().signal;
    await callSearchMcp(endpoint, dependencies, { query: 'example' }, signal);
    expect(vi.mocked(connectHttpMcpClient).mock.calls[0]?.[0].signal).toBe(signal);
    expect(callTool.mock.calls[0]?.[1].signal).toBe(signal);
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(['connect', 'call'] as const)('preserves the caller reason while cancelling %s', async (phase) => {
    const controller = new AbortController();
    const reason = new Error('sample interruption');
    const entered = Promise.withResolvers<void>();
    const pending = () => new Promise<never>((_resolve, reject) => {
      entered.resolve();
      controller.signal.addEventListener('abort', () => reject(new Error('SDK cancellation wrapper')), { once: true });
    });
    const close = vi.fn();
    if (phase === 'connect') vi.mocked(connectHttpMcpClient).mockImplementation(pending);
    else vi.mocked(connectHttpMcpClient).mockResolvedValue({ client: { callTool: pending }, close } as never);
    const call = callSearchMcp(endpoint, dependencies, {}, controller.signal);
    const rejected = expect(call).rejects.toBe(reason);
    await entered.promise;
    controller.abort(reason);
    await rejected;
    if (phase === 'call') expect(close).toHaveBeenCalledOnce();
  });

  it('closes the owned client after a timeout', async () => {
    const close = vi.fn();
    vi.mocked(connectHttpMcpClient).mockResolvedValue({ client: {
      callTool: () => Promise.reject(new DOMException('Request timed out', 'TimeoutError')),
    }, close } as never);
    await expect(callSearchMcp(endpoint, dependencies, {}, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: 'timeout' } });
    expect(close).toHaveBeenCalledOnce();
  });
});
