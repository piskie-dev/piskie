import { describe, expect, it } from 'vitest';
import { MAX_LOG_EVENT_BYTES, normalizeLogEvent } from '../event-normalizer.js';

describe('normalizeLogEvent', () => {
  it('normalizes complex values, errors, and sensitive fields without throwing', () => {
    const circular: Record<string, unknown> = { apiKey: 'secret-key', count: 2n };
    circular.self = circular;
    const cause = new Error('request failed?token=secret-key');
    const error = new Error('Bearer secret-key', { cause }) as Error & { code: string };
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
