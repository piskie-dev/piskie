import type {
  SubagentFailure,
  SubagentNotification,
} from '@shared/types/index.js';
import {
  isSubagentEventType,
  pickSubagentEventText,
  type SubagentEventType,
} from '@shared/subagent-events.js';

export type { SubagentEventType } from '@shared/subagent-events.js';

export interface NormalizedSubagentNotification {
  readonly type: SubagentEventType;
  readonly text: string;
  readonly data?: unknown;
  readonly failure?: SubagentFailure;
}

export interface SubagentEventMetadata {
  readonly errorType?: string;
  readonly origin?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly requestId?: string;
  readonly traceId?: string;
}

export function normalizeSubagentNotification(
  value: SubagentNotification | Record<string, unknown>,
): NormalizedSubagentNotification {
  const input = value as Record<string, unknown>;
  const type = eventType(input.type);
  const failure = type === 'failed' ? failureDetails(input.failure) : undefined;
  return {
    type,
    text: pickSubagentEventText(input, type) ?? `子流程事件：${type}`,
    ...(input.data !== undefined && { data: input.data }),
    ...(failure && { failure }),
  };
}

export function subagentEventMetadata(
  notification: NormalizedSubagentNotification,
): SubagentEventMetadata {
  const diagnostics = notification.failure?.diagnostics;
  const upstream = isRecord(diagnostics?.upstream) ? diagnostics.upstream : undefined;
  return {
    ...(notification.failure?.errorType && { errorType: notification.failure.errorType }),
    ...(stringField(notification.data, 'origin') && { origin: stringField(notification.data, 'origin') }),
    ...(stringField(diagnostics, 'providerId') && { providerId: stringField(diagnostics, 'providerId') }),
    ...(stringField(diagnostics, 'modelId') && { modelId: stringField(diagnostics, 'modelId') }),
    ...(stringField(upstream, 'requestId') && { requestId: stringField(upstream, 'requestId') }),
    ...(stringField(diagnostics, 'traceId') && { traceId: stringField(diagnostics, 'traceId') }),
  };
}

export function renderSubagentEventOpeningTag(
  subagentId: string,
  timestamp: string,
  notification: NormalizedSubagentNotification,
): string {
  const metadata = subagentEventMetadata(notification);
  const attributes: Record<string, string | undefined> = {
    id: subagentId,
    type: notification.type,
    ts: timestamp,
    error_type: metadata.errorType,
    origin: metadata.origin,
    provider: metadata.providerId,
    model: metadata.modelId,
    request_id: metadata.requestId,
    trace_id: metadata.traceId,
  };
  const serialized = Object.entries(attributes)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, value]) => `${key}="${escapeAttribute(value)}"`)
    .join(' ');
  return `<subagent_event ${serialized}>`;
}

function eventType(value: unknown): SubagentEventType {
  return isSubagentEventType(value) ? value : 'message';
}

function failureDetails(value: unknown): SubagentFailure | undefined {
  if (!isRecord(value) || typeof value.errorType !== 'string') return undefined;
  return {
    errorType: value.errorType as SubagentFailure['errorType'],
    ...(isRecord(value.diagnostics) && { diagnostics: value.diagnostics }),
  };
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", '&apos;');
}
