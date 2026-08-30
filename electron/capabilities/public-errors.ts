import { createUuid } from '@shared/utils/identifiers.js';

import type {
  PublicFault,
  PublicFaultCode,
} from '../../shared/electron-contracts/public-fault.js';

export class PublicOperationError extends Error {
  constructor(
    readonly code: PublicFaultCode,
    message: string,
    readonly options: {
      retryable?: boolean;
      details?: Readonly<Record<string, unknown>>;
    } = {},
  ) {
    super(message);
    this.name = 'PublicOperationError';
  }
}

export function toPublicFault(error: unknown, correlationId = createUuid()): PublicFault {
  if (error instanceof PublicOperationError) {
    return Object.freeze({
      code: error.code,
      message: boundedMessage(error.message, 'The operation could not be completed'),
      correlationId,
      retryable: error.options.retryable ?? false,
      ...(error.options.details && { details: Object.freeze({ ...error.options.details }) }),
    });
  }
  if (isAbortError(error)) {
    return Object.freeze({
      code: 'aborted',
      message: 'The operation was cancelled',
      correlationId,
      retryable: false,
    });
  }
  return Object.freeze({
    code: 'internal',
    message: boundedMessage(errorMessage(error), 'The operation could not be completed'),
    correlationId,
    retryable: false,
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '';
}

function boundedMessage(message: string, fallback: string): string {
  return (message || fallback).slice(0, 512);
}
