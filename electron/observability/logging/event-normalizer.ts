import { createUuid } from '@shared/utils/identifiers.js';
import type {
  JsonLogValue,
  LogEvent,
  LogFields,
  LogLevel,
  LogOrigin,
  LogRecordInput,
  NormalizedLogError,
} from './contracts.js';
import { isSensitiveLogKey, redactLogString, REDACTED } from './sensitive-fields.js';

export const LOG_EVENT_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,4}$/;
export const MAX_LOG_EVENT_BYTES = 16 * 1024;

const MAX_MESSAGE_LENGTH = 80;
const MAX_CONTEXT_FIELDS = 12;
const MAX_ARRAY_ITEMS = 20;
const MAX_STRING_LENGTH = 256;
const MAX_DEPTH = 6;
const MAX_ERROR_CAUSE_DEPTH = 16;
const MAX_STACK_LENGTH = 8 * 1024;

interface NormalizeOptions {
  readonly origin: LogOrigin;
  readonly inheritedContext?: LogFields;
  readonly knownSecrets?: readonly string[];
  readonly now?: () => Date;
  readonly createId?: () => string;
}

export function assertValidLogRecord(record: LogRecordInput): void {
  if (!LOG_EVENT_PATTERN.test(record.event)) {
    throw new Error(`Invalid log event name: ${record.event}`);
  }
  if (!isAscii(record.message) || record.message.length === 0 || record.message.length > MAX_MESSAGE_LENGTH) {
    throw new Error('Log message must contain 1-80 ASCII characters');
  }
  if (record.message.includes('\n') || /%[sdifoOj%]/.test(record.message) || /^\[[^\]]+\]/.test(record.message)) {
    throw new Error('Log message must be a short static summary');
  }
}

export function normalizeLogEvent(
  level: LogLevel,
  record: LogRecordInput,
  options: NormalizeOptions,
): LogEvent {
  assertValidLogRecord(record);
  const knownSecrets = options.knownSecrets ?? [];
  const mergedContext = {
    ...(options.inheritedContext ?? {}),
    ...(record.context ?? {}),
  };
  const scope = typeof mergedContext.scope === 'string'
    ? redactLogString(mergedContext.scope, knownSecrets).slice(0, MAX_STRING_LENGTH)
    : undefined;
  delete (mergedContext as Record<string, unknown>).scope;

  const normalizedContext = normalizeRecord(mergedContext, knownSecrets, MAX_CONTEXT_FIELDS);
  const normalizedError = record.error === undefined
    ? undefined
    : normalizeLogError(record.error);
  const event: LogEvent = {
    id: (options.createId ?? createUuid)(),
    timestamp: (options.now ?? (() => new Date()))().toISOString(),
    level,
    event: record.event,
    message: redactLogString(record.message, knownSecrets),
    ...(scope && { scope }),
    origin: options.origin,
    ...(Object.keys(normalizedContext).length > 0 && { context: normalizedContext }),
    ...(normalizedError && { error: normalizedError }),
  };
  return enforceEventBudget(event);
}

export function normalizeLogError(
  thrown: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): NormalizedLogError {
  if (depth >= MAX_ERROR_CAUSE_DEPTH) {
    return { name: 'Error', message: '[Cause depth exceeded]' };
  }
  if (!isObject(thrown)) {
    return {
      name: thrown === null ? 'null' : typeof thrown,
      message: normalizeString(safeString(thrown)),
    };
  }
  if (seen.has(thrown)) return { name: 'Error', message: '[Circular]' };

  const name = normalizeString(safePropertyString(thrown, 'name') ?? 'Error');
  const message = normalizeString(
    safePropertyString(thrown, 'message') ?? safeString(thrown),
  );
  const stackValue = safePropertyString(thrown, 'stack');
  const codeValue = safePropertyString(thrown, 'code');
  const causeValue = safeProperty(thrown, 'cause');
  // AggregateError.errors is non-enumerable and contains per-address connection failures.
  const errorsValue = thrown instanceof AggregateError ? safeProperty(thrown, 'errors') : undefined;
  const aggregateErrors = Array.isArray(errorsValue) ? errorsValue : undefined;
  const fields = normalizeRecord(thrown, undefined, MAX_CONTEXT_FIELDS, seen, depth, new Set([
    'name', 'message', 'stack', 'code', 'cause', ...(aggregateErrors ? ['errors'] : []),
  ]));

  seen.add(thrown);
  const errors = aggregateErrors?.slice(0, MAX_ARRAY_ITEMS)
    .map((error) => normalizeLogError(error, depth + 1, seen));
  if (errors && aggregateErrors && aggregateErrors.length > errors.length) {
    errors.push({ name: 'Error', message: `[${aggregateErrors.length - errors.length} additional errors omitted]` });
  }
  const result: NormalizedLogError = {
    name,
    message,
    ...(stackValue && { stack: stackValue.slice(0, MAX_STACK_LENGTH) }),
    ...(codeValue && { code: normalizeString(codeValue) }),
    ...(causeValue !== undefined && { cause: normalizeLogError(causeValue, depth + 1, seen) }),
    ...(errors && { errors }),
    ...(Object.keys(fields).length > 0 && { fields }),
  };
  seen.delete(thrown);
  return result;
}

function normalizeRecord(
  input: object,
  knownSecrets: readonly string[] | undefined,
  maxFields: number,
  seen = new WeakSet<object>(),
  depth = 0,
  excluded = new Set<string>(),
): Record<string, JsonLogValue> {
  if (seen.has(input)) return { value: '[Circular]' };
  seen.add(input);
  let keys: string[];
  try {
    keys = Object.keys(input).filter((key) => !excluded.has(key));
  } catch {
    return { value: '[Uninspectable object]' };
  }
  const selected = keys.slice(0, maxFields);
  const result: Record<string, JsonLogValue> = {};
  for (const key of selected) {
    if (knownSecrets !== undefined && isSensitiveLogKey(key)) {
      result[key] = REDACTED;
      continue;
    }
    const value = safeProperty(input, key);
    result[key] = value === UNREADABLE
      ? '[Unreadable property]'
      : normalizeValue(value, knownSecrets, seen, depth + 1);
  }
  if (keys.length > selected.length) result._omittedFieldCount = keys.length - selected.length;
  seen.delete(input);
  return result;
}

function normalizeValue(
  value: unknown,
  knownSecrets: readonly string[] | undefined,
  seen: WeakSet<object>,
  depth: number,
): JsonLogValue {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return normalizeString(value, knownSecrets);
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return { type: 'bigint', value: value.toString(10) };
  if (typeof value === 'undefined') return '[undefined]';
  if (typeof value === 'function') return `[Function${value.name ? `: ${value.name}` : ''}]`;
  if (typeof value === 'symbol') return `[Symbol: ${value.description ?? ''}]`;
  if (!isObject(value)) return normalizeString(safeString(value), knownSecrets);
  if (seen.has(value)) return '[Circular]';
  if (value instanceof Error) return normalizeLogError(value, depth, seen) as unknown as JsonLogValue;
  if (depth > MAX_DEPTH) return '[Depth exceeded]';
  if (value instanceof Date) {
    try {
      return value.toISOString();
    } catch {
      return '[Invalid Date]';
    }
  }
  if (ArrayBuffer.isView(value)) {
    return { type: value.constructor.name, byteLength: value.byteLength };
  }
  if (value instanceof ArrayBuffer) return { type: 'ArrayBuffer', byteLength: value.byteLength };
  if (Array.isArray(value)) {
    seen.add(value);
    const items = value.slice(0, MAX_ARRAY_ITEMS)
      .map((item) => normalizeValue(item, knownSecrets, seen, depth + 1));
    seen.delete(value);
    if (value.length > items.length) {
      items.push({ omittedItemCount: value.length - items.length });
    }
    return items;
  }
  if (value instanceof Map) {
    return normalizeValue([...value.entries()], knownSecrets, seen, depth + 1);
  }
  if (value instanceof Set) {
    return normalizeValue([...value.values()], knownSecrets, seen, depth + 1);
  }
  return normalizeRecord(value, knownSecrets, MAX_ARRAY_ITEMS, seen, depth);
}

function enforceEventBudget(event: LogEvent): LogEvent {
  if (Buffer.byteLength(JSON.stringify(event), 'utf8') <= MAX_LOG_EVENT_BYTES) return event;
  // Repeated wrapper stacks can exceed the budget before the transport cause is reached.
  const compacted: LogEvent = {
    ...event,
    context: { ...event.context, truncated: true },
    ...(event.error && { error: compactLogError(event.error) }),
  };
  if (Buffer.byteLength(JSON.stringify(compacted), 'utf8') <= MAX_LOG_EVENT_BYTES) return compacted;

  const withoutContext: LogEvent = {
    ...compacted,
    context: { truncated: true },
  };
  if (Buffer.byteLength(JSON.stringify(withoutContext), 'utf8') <= MAX_LOG_EVENT_BYTES) {
    return withoutContext;
  }
  const withoutFields: LogEvent = {
    ...withoutContext,
    ...(event.error && { error: compactLogError(event.error, false) }),
  };
  if (Buffer.byteLength(JSON.stringify(withoutFields), 'utf8') <= MAX_LOG_EVENT_BYTES) {
    return withoutFields;
  }
  let root = event.error;
  while (root?.cause) root = root.cause;
  return {
    id: event.id,
    timestamp: event.timestamp,
    level: event.level,
    event: event.event,
    message: event.message,
    ...(event.scope && { scope: event.scope }),
    origin: event.origin,
    context: { truncated: true },
    ...(root && { error: errorSummary(root) }),
  };
}

function errorSummary(error: NormalizedLogError): NormalizedLogError {
  return {
    name: error.name,
    message: error.message,
    ...(error.code && { code: error.code }),
  };
}

function compactLogError(error: NormalizedLogError, keepFields = true): NormalizedLogError {
  const fields = keepFields && error.fields
    ? Object.fromEntries(Object.entries(error.fields).filter(([, value]) => value === null || typeof value !== 'object'))
    : {};
  return {
    ...errorSummary(error),
    ...(error.cause && { cause: compactLogError(error.cause, keepFields) }),
    ...(error.errors && { errors: error.errors.map((item) => compactLogError(item, keepFields)) }),
    ...(Object.keys(fields).length > 0 && { fields }),
  };
}

function normalizeString(value: string, knownSecrets?: readonly string[]): string {
  const redacted = knownSecrets === undefined ? value : redactLogString(value, knownSecrets);
  return redacted.length > MAX_STRING_LENGTH
    ? `${redacted.slice(0, MAX_STRING_LENGTH)}[truncated]`
    : redacted;
}

function isAscii(value: string): boolean {
  return /^[\x20-\x7E]+$/.test(value);
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

const UNREADABLE = Symbol('unreadable');

function safeProperty(input: object, key: PropertyKey): unknown {
  try {
    return Reflect.get(input, key);
  } catch {
    return UNREADABLE;
  }
}

function safePropertyString(input: object, key: PropertyKey): string | undefined {
  const value = safeProperty(input, key);
  if (value === UNREADABLE || value === undefined) return undefined;
  return safeString(value);
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '[Unprintable value]';
  }
}
