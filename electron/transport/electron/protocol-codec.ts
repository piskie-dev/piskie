import type {
  CapabilityId,
  ClientFrame,
  ConnectHello,
  HostFrame,
} from '../../../shared/electron-contracts/protocol.js';
import { ELECTRON_PROTOCOL_VERSION } from '../../../shared/electron-contracts/protocol.js';
import type {
  PublicFault,
  PublicFaultCode,
} from '../../../shared/electron-contracts/public-fault.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ROUTE_PATTERN = /^[a-z][A-Za-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9-]*)+$/;
const CAPABILITIES = new Set([
  'account',
  'agent-runs',
  'agents',
  'capabilities',
  'configuration',
  'desktop',
  'inference',
  'messaging',
  'modes',
  'observability',
  'pilot',
  'runtime',
  'task-definitions',
  'updates',
]);
const FAULT_CODES = new Set<PublicFaultCode>([
  'aborted',
  'conflict',
  'deadline-exceeded',
  'forbidden',
  'internal',
  'invalid-input',
  'not-found',
  'not-ready',
  'protocol-mismatch',
  'unavailable',
  'unsupported',
]);

export class ProtocolDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolDecodeError';
  }
}

export function decodeConnectHello(value: unknown): ConnectHello {
  const record = requireProtocolRecord(value, 'Connect hello must be an object');
  if (record.protocolVersion !== ELECTRON_PROTOCOL_VERSION) {
    throw new ProtocolDecodeError('Unsupported protocol version');
  }
  if (typeof record.rendererBuildId !== 'string' || !ID_PATTERN.test(record.rendererBuildId)) {
    throw new ProtocolDecodeError('Invalid renderer build id');
  }
  if (typeof record.windowNonce !== 'string' || !ID_PATTERN.test(record.windowNonce)) {
    throw new ProtocolDecodeError('Invalid window nonce');
  }
  return {
    protocolVersion: ELECTRON_PROTOCOL_VERSION,
    rendererBuildId: record.rendererBuildId,
    windowNonce: record.windowNonce,
  };
}

export function decodeClientFrame(value: unknown): ClientFrame {
  const record = requireProtocolRecord(value, 'Protocol frame must be an object');
  switch (record.kind) {
    case 'request': {
      const id = decodeId(record.id);
      if (typeof record.operation !== 'string' || !ROUTE_PATTERN.test(record.operation)) {
        throw new ProtocolDecodeError('Invalid operation id');
      }
      if (record.deadlineAt !== undefined && (
        typeof record.deadlineAt !== 'number'
        || !Number.isFinite(record.deadlineAt)
        || record.deadlineAt <= 0
      )) {
        throw new ProtocolDecodeError('Invalid request deadline');
      }
      return {
        kind: 'request',
        id,
        operation: record.operation,
        payload: record.payload,
        ...(record.deadlineAt !== undefined && { deadlineAt: record.deadlineAt }),
      };
    }
    case 'cancel':
      return { kind: 'cancel', id: decodeId(record.id) };
    case 'subscribe': {
      const id = decodeId(record.id);
      if (typeof record.topic !== 'string' || !ROUTE_PATTERN.test(record.topic)) {
        throw new ProtocolDecodeError('Invalid topic id');
      }
      if (record.cursor !== undefined && typeof record.cursor !== 'string') {
        throw new ProtocolDecodeError('Invalid subscription cursor');
      }
      return {
        kind: 'subscribe',
        id,
        topic: record.topic,
        payload: record.payload,
        ...(record.cursor !== undefined && { cursor: record.cursor }),
      };
    }
    case 'unsubscribe':
      return { kind: 'unsubscribe', subscriptionId: decodeId(record.subscriptionId) };
    default:
      throw new ProtocolDecodeError('Unknown protocol frame kind');
  }
}

export function decodeHostFrame(value: unknown): HostFrame {
  const record = requireProtocolRecord(value, 'Host frame must be an object');
  switch (record.kind) {
    case 'welcome': {
      const welcome = requireProtocolRecord(record.welcome, 'Welcome payload must be an object');
      if (welcome.protocolVersion !== ELECTRON_PROTOCOL_VERSION) {
        throw new ProtocolDecodeError('Unsupported host protocol version');
      }
      const runtime = requireProtocolRecord(welcome.runtime, 'Runtime snapshot must be an object');
      if (runtime.phase !== 'ready' && runtime.phase !== 'stopping') {
        throw new ProtocolDecodeError('Invalid runtime phase');
      }
      if (!isFiniteNumber(runtime.startedAt)) {
        throw new ProtocolDecodeError('Invalid runtime start time');
      }
      if (!Array.isArray(runtime.degraded) || runtime.degraded.length > 128) {
        throw new ProtocolDecodeError('Invalid degraded capability list');
      }
      const degraded = runtime.degraded.map((item) => {
        const entry = requireProtocolRecord(item, 'Invalid degraded capability');
        if (typeof entry.componentId !== 'string' || !ID_PATTERN.test(entry.componentId)) {
          throw new ProtocolDecodeError('Invalid degraded component id');
        }
        if (typeof entry.reason !== 'string' || entry.reason.length > 512) {
          throw new ProtocolDecodeError('Invalid degraded capability reason');
        }
        return { componentId: entry.componentId, reason: entry.reason };
      });
      if (!Array.isArray(welcome.capabilities) || welcome.capabilities.some((item) => (
        typeof item !== 'string' || !CAPABILITIES.has(item)
      ))) {
        throw new ProtocolDecodeError('Invalid capability list');
      }
      return {
        kind: 'welcome',
        welcome: {
          protocolVersion: ELECTRON_PROTOCOL_VERSION,
          generation: decodeId(welcome.generation),
          connectionId: decodeId(welcome.connectionId),
          runtime: {
            phase: runtime.phase,
            startedAt: runtime.startedAt,
            degraded,
          },
          capabilities: welcome.capabilities as CapabilityId[],
        },
      };
    }
    case 'result':
      return { kind: 'result', id: decodeId(record.id), value: record.value };
    case 'stream':
      return {
        kind: 'stream',
        id: decodeId(record.id),
        ...(record.metadata !== undefined && { metadata: record.metadata }),
      };
    case 'fault':
      return { kind: 'fault', id: decodeId(record.id), fault: decodeFault(record.fault) };
    case 'subscribed':
      return {
        kind: 'subscribed',
        id: decodeId(record.id),
        subscriptionId: decodeId(record.subscriptionId),
        snapshot: record.snapshot,
        cursor: decodeCursor(record.cursor),
      };
    case 'change':
      if (!Number.isSafeInteger(record.sequence) || (record.sequence as number) <= 0) {
        throw new ProtocolDecodeError('Invalid subscription sequence');
      }
      return {
        kind: 'change',
        subscriptionId: decodeId(record.subscriptionId),
        sequence: record.sequence as number,
        value: record.value,
        cursor: decodeCursor(record.cursor),
      };
    case 'closed':
      if (typeof record.reason !== 'string' || record.reason.length < 1 || record.reason.length > 512) {
        throw new ProtocolDecodeError('Invalid connection close reason');
      }
      return { kind: 'closed', reason: record.reason };
    default:
      throw new ProtocolDecodeError('Unknown host frame kind');
  }
}

function decodeId(value: unknown): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new ProtocolDecodeError('Invalid protocol id');
  }
  return value;
}

function decodeCursor(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512) {
    throw new ProtocolDecodeError('Invalid subscription cursor');
  }
  return value;
}

function decodeFault(value: unknown): PublicFault {
  const record = requireProtocolRecord(value, 'Public fault must be an object');
  if (typeof record.code !== 'string' || !FAULT_CODES.has(record.code as PublicFaultCode)) {
    throw new ProtocolDecodeError('Invalid public fault code');
  }
  if (typeof record.message !== 'string' || record.message.length > 512) {
    throw new ProtocolDecodeError('Invalid public fault message');
  }
  if (typeof record.correlationId !== 'string' || !ID_PATTERN.test(record.correlationId)) {
    throw new ProtocolDecodeError('Invalid fault correlation id');
  }
  if (typeof record.retryable !== 'boolean') {
    throw new ProtocolDecodeError('Invalid public fault retry flag');
  }
  if (record.details !== undefined) requireProtocolRecord(record.details, 'Invalid public fault details');
  return {
    code: record.code as PublicFaultCode,
    message: record.message,
    correlationId: record.correlationId,
    retryable: record.retryable,
    ...(record.details !== undefined && {
      details: record.details as Readonly<Record<string, unknown>>,
    }),
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function requireProtocolRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolDecodeError(message);
  }
  return value as Record<string, unknown>;
}
