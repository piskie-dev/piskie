import { describe, expect, it } from 'vitest';
import { PublicOperationError, toPublicFault } from '../public-errors.js';

const CORRELATION_ID = '00000000-0000-4000-8000-000000000001';

describe('public operation faults', () => {
  it('preserves local error messages and structured details without generic rewriting', () => {
    const message = 'Driver failed at /local/config.json with token=diagnostic-value';
    const details = {
      path: '/local/config.json',
      credentialName: 'diagnostic-value',
      issues: ['first', 'second'],
    };

    const fault = toPublicFault(new PublicOperationError('conflict', message, {
      details,
    }), CORRELATION_ID);

    expect(fault).toMatchObject({
      code: 'conflict',
      message,
      correlationId: CORRELATION_ID,
      retryable: false,
      details,
    });
  });

  it('returns an internal error message in the local Electron trust domain', () => {
    const fault = toPublicFault(new Error('Local driver failed'), CORRELATION_ID);
    expect(fault).toMatchObject({
      code: 'internal',
      message: 'Local driver failed',
      correlationId: CORRELATION_ID,
      retryable: false,
    });
  });

  it('bounds messages to the transport contract limit', () => {
    const fault = toPublicFault(
      new PublicOperationError('unavailable', 'x'.repeat(600)),
      CORRELATION_ID,
    );
    expect(fault.message).toHaveLength(512);
  });
});
