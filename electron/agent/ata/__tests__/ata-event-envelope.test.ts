import { describe, expect, it } from 'vitest';
import { isATAEventEnvelope } from '../ata-event-envelope.js';

describe('isATAEventEnvelope', () => {
  it('accepts only the current inline and file discriminators', () => {
    expect(isATAEventEnvelope({
      storage: 'inline',
      type: 'message',
      data: { type: 'message', message: 'hello' },
      originalSize: 5,
    })).toBe(true);
    expect(isATAEventEnvelope({
      storage: 'file',
      type: 'completed',
      summary: 'done',
      filePath: '/tmp/agent-runs/main-1/ata-events/done.md',
      originalSize: 1001,
    })).toBe(true);
  });
});
