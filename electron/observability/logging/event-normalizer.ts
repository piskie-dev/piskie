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
const MAX_ERROR_CAUSE_DEPTH = 3;
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
    : normalizeLogError(record.error, knownSecrets);
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
  knownSecrets: readonly string[] = [],
  depth = 0,
): NormalizedLogError {
  if (depth >= MAX_ERROR_CAUSE_DEPTH) {
    return { name: 'Error', message: '[Cause depth exceeded]' };
  }
  if (!isObject(thrown)) {
    return {
      name: thrown === null ? 'null' : typeof thrown,
      message: normalizeString(safeString(thrown), knownSecrets),
    };
  }

  const name = normalizeString(safePropertyString(thrown, 'name') ?? 'Error', knownSecrets);
  const message = normalizeString(
    safePropertyString(thrown, 'message') ?? safeString(thrown),
    knownSecrets,
  );
  const stackValue = safePropertyString(thrown, 'stack');
  const codeValue = safePropertyString(thrown, 'code');
  const causeValue = safeProperty(thrown, 'cause');
  const fields = normalizeRecord(thrown, knownSecrets, MAX_CONTEXT_FIELDS, new WeakSet(), 0, new Set([
    'name', 'message', 'stack', 'code', 'cause',
  ]));

  return {
    name,
    message,
    ...(stackValue && { stack: redactLogString(stackValue, knownSecrets).slice(0, MAX_STACK_LENGTH) }),
    ...(codeValue && { code: normalizeString(codeValue, knownSecrets) }),
    ...(causeValue !== undefined && { cause: normalizeLogError(causeValue, knownSecrets, depth + 1) }),
    ...(Object.keys(fields).length > 0 && { fields }),
  };
}

function normalizeRecord(
  input: object,
  knownSecrets: readonly string[],
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
    if (isSensitiveLogKey(key)) {
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
  knownSecrets: readonly string[],
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
  if (depth > MAX_DEPTH) return '[Depth exceeded]';
  if (seen.has(value)) return '[Circular]';
  if (value instanceof Date) {
    try {
      return value.toISOString();
    } catch {
      return '[Invalid Date]';
    }
  }
  if (value instanceof Error) return normalizeLogError(value, knownSecrets) as unknown as JsonLogValue;
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
  const withoutContext: LogEvent = {
    ...event,
    context: { truncated: true },
    ...(event.error && {
      error: {
        name: event.error.name,
        message: event.error.message,
        ...(event.error.code && { code: event.error.code }),
        ...(event.error.stack && { stack: event.error.stack.slice(0, 2_048) }),
      },
    }),
  };
  if (Buffer.byteLength(JSON.stringify(withoutContext), 'utf8') <= MAX_LOG_EVENT_BYTES) {
    return withoutContext;
  }
  return {
    id: event.id,
    timestamp: event.timestamp,
    level: event.level,
    event: event.event,
    message: event.message,
    ...(event.scope && { scope: event.scope }),
    origin: event.origin,
    context: { truncated: true },
  };
}

function normalizeString(value: string, knownSecrets: readonly string[]): string {
  const redacted = redactLogString(value, knownSecrets);
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
