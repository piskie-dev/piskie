export type PublicFaultCode =
  | 'aborted'
  | 'conflict'
  | 'deadline-exceeded'
  | 'forbidden'
  | 'internal'
  | 'invalid-input'
  | 'not-found'
  | 'not-ready'
  | 'protocol-mismatch'
  | 'unavailable'
  | 'unsupported';

export interface PublicFault {
  readonly code: PublicFaultCode;
  readonly message: string;
  readonly correlationId: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class PiskieFault extends Error {
  readonly code: PublicFaultCode;
  readonly correlationId: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(fault: PublicFault) {
    super(fault.message);
    this.name = 'PiskieFault';
    this.code = fault.code;
    this.correlationId = fault.correlationId;
    this.retryable = fault.retryable;
    this.details = fault.details;
  }
}
