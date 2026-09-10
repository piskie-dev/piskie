import { describe, expect, it } from 'vitest';
import { MAX_LOG_EVENT_BYTES, normalizeLogEvent } from '../event-normalizer.js';

describe('normalizeLogEvent', () => {
  it('normalizes complex values and redacts sensitive context fields', () => {
    const circular: Record<string, unknown> = { apiKey: 'secret-key', count: 2n };
    circular.self = circular;
    const cause = new Error('request failed');
    const error = new Error('operation failed', { cause }) as Error & { code: string };
    error.code = 'E_REQUEST';

    const event = normalizeLogEvent('error', {
      event: 'agent.runtime.execute.failed',
      message: 'Agent runtime execution failed',
      context: {
        scope: 'agent.runtime',
        authorization: 'Bearer secret-key',
        circular,
        values: new Set([1, 2]),
        bytes: Buffer.from('private bytes'),
      },
      error,
    }, {
      origin: 'main',
      knownSecrets: ['secret-key'],
      createId: () => 'event-1',
      now: () => new Date('2026-08-18T00:00:00.000Z'),
    });

    expect(event).toMatchObject({
      id: 'event-1',
      timestamp: '2026-08-18T00:00:00.000Z',
      scope: 'agent.runtime',
      origin: 'main',
      context: { authorization: '[REDACTED]' },
      error: { code: 'E_REQUEST' },
    });
    expect(JSON.stringify(event)).not.toContain('secret-key');
    expect(JSON.stringify(event.context)).toContain('[Circular]');
    expect(JSON.stringify(event.context)).toContain('bigint');
  });

  it.each(['normal', 'large-stacks', 'large-context'])('retains transport causes in %s events', (scenario) => {
    const root = Object.assign(new Error('connect ECONNREFUSED 192.0.2.10:443'), {
      code: 'ECONNREFUSED',
      syscall: 'connect',
      address: '192.0.2.10',
      port: 443,
    });
    let error: Error = new TypeError('fetch failed', { cause: root });
    for (const name of ['SdkRequestError', 'GatewayRequestError', 'AgentRequestError']) {
      error = Object.assign(new Error('Connection error.', { cause: error }), { name });
    }
    for (let current: Error | undefined = error; current; current = current.cause as Error | undefined) {
      current.stack = `${current.name}: ${current.message}\n${'    at request (transport.js:1:1)\n'.repeat(scenario === 'large-stacks' ? 300 : 1)}`;
    }

    const event = normalizeLogEvent('error', {
      event: 'agent.runtime.execute.failed',
      message: 'Agent runtime execution failed',
      context: {
        agentId: 'agent-example',
        ...(scenario === 'large-context' && {
          frames: Array.from({ length: 20 }, () => ({
            request: 'x'.repeat(1_000),
            response: 'x'.repeat(1_000),
            phase: 'x'.repeat(1_000),
            state: 'x'.repeat(1_000),
          })),
        }),
      },
      error,
    }, { origin: 'main' });

    expect(event.error?.cause?.cause?.cause).toMatchObject({
      name: 'TypeError',
      message: 'fetch failed',
      cause: {
        message: root.message,
        code: 'ECONNREFUSED',
      },
    });
    if (scenario === 'large-context') {
      expect(event.context?.truncated).toBe(true);
    } else {
      expect(event.context?.agentId).toBe('agent-example');
    }
    expect(event.error?.cause?.cause?.cause?.cause?.fields).toMatchObject({
      syscall: 'connect', address: '192.0.2.10', port: 443,
    });
    expect(Buffer.byteLength(JSON.stringify(event), 'utf8')).toBeLessThanOrEqual(MAX_LOG_EVENT_BYTES);
    if (scenario === 'normal') expect(event.error?.cause?.cause?.cause?.cause?.stack).toBe(root.stack);
  });

  it('records exception text and fields verbatim', () => {
    const message = 'Request failed?token=example-token';
    const cause = Object.assign(new Error(message), {
      code: 'example-token',
      stack: `Error: ${message}\n    at request (transport.js:1:1)`,
      authorization: 'Bearer example-token',
      request: { token: 'example-token', url: 'https://service.invalid/?key=example-token' },
    });
    const error = new Error('Bearer example-token', { cause });
    const event = normalizeLogEvent('error', {
      event: 'agent.runtime.execute.failed',
      message: 'Agent runtime execution failed',
      error,
    }, { origin: 'main', knownSecrets: ['example-token'] });

    expect(event.error).toMatchObject({
      message: error.message,
      cause: {
        message,
        code: cause.code,
        stack: cause.stack,
        fields: { authorization: cause.authorization, request: cause.request },
      },
    });
  });

  it('retains aggregate connection failures when stacks exceed the event budget', () => {
    const errors = ['192.0.2.10', '192.0.2.11'].map((address) => Object.assign(
      new Error(`connect ECONNREFUSED ${address}:443`),
      { code: 'ECONNREFUSED', address, port: 443, stack: 'connection stack\n'.repeat(1_000) },
    ));
    const aggregate = new AggregateError(errors, 'All connection attempts failed');
    const error = new TypeError('fetch failed', { cause: aggregate });
    const event = normalizeLogEvent('error', {
      event: 'agent.runtime.execute.failed',
      message: 'Agent runtime execution failed',
      error,
    }, { origin: 'main' });

    expect(event.error?.cause).toMatchObject({
      name: 'AggregateError',
      errors: errors.map((item) => ({
        message: item.message,
        code: item.code,
        fields: { address: item.address, port: item.port },
      })),
    });
    expect(Buffer.byteLength(JSON.stringify(event), 'utf8')).toBeLessThanOrEqual(MAX_LOG_EVENT_BYTES);
  });

  it('terminates circular error causes and fields', () => {
    const error = Object.assign(new Error('request failed'), { cause: undefined as unknown, related: undefined as unknown });
    const cause = new Error('connection failed', { cause: error });
    error.cause = cause;
    error.related = error;
    const event = normalizeLogEvent('error', {
      event: 'agent.runtime.execute.failed',
      message: 'Agent runtime execution failed',
      error,
    }, { origin: 'main' });

    expect(event.error?.cause).toMatchObject({
      message: 'connection failed',
      cause: { message: '[Circular]' },
    });
    expect(event.error?.fields?.related).toBe('[Circular]');
  });

  it('enforces the hard event budget while retaining identity fields', () => {
    const event = normalizeLogEvent('info', {
      event: 'desktop.runtime.start.completed',
      message: 'Desktop runtime started',
      context: Object.fromEntries(
        Array.from({ length: 20 }, (_, index) => [`field${index}`, 'x'.repeat(20_000)]),
      ),
    }, { origin: 'main', createId: () => 'event-2' });

    expect(Buffer.byteLength(JSON.stringify(event), 'utf8')).toBeLessThanOrEqual(MAX_LOG_EVENT_BYTES);
    expect(event.id).toBe('event-2');
    expect(event.event).toBe('desktop.runtime.start.completed');
  });

  it('rejects unstable event names and dynamic message formats', () => {
    expect(() => normalizeLogEvent('info', {
      event: 'Agent.Start',
      message: 'Agent started',
    }, { origin: 'main' })).toThrow('Invalid log event');
    expect(() => normalizeLogEvent('info', {
      event: 'agent.runtime.start.completed',
      message: '[Agent] started %s',
    }, { origin: 'main' })).toThrow('static summary');
  });
});
