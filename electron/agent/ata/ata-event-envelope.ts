import {
  isSubagentEventType,
  type SubagentEventType,
} from '@shared/subagent-events.js';

export type ATAEventPayload = Readonly<{
  type: SubagentEventType;
  message: string;
  summary?: string;
}>;

export type ATAEventEnvelope =
  | {
      storage: 'inline';
      type: SubagentEventType;
      data: ATAEventPayload;
      originalSize: number;
    }
  | {
      storage: 'file';
      type: SubagentEventType;
      summary: string;
      filePath: string;
      originalSize: number;
    };

export function isATAEventEnvelope(value: unknown): value is ATAEventEnvelope {
  if (!isRecord(value) || (value.storage !== 'inline' && value.storage !== 'file')) return false;
  if (!isSubagentEventType(value.type) || typeof value.originalSize !== 'number') return false;
  return value.storage === 'inline'
    ? isATAEventPayload(value.data)
    : typeof value.summary === 'string' && typeof value.filePath === 'string';
}

function isATAEventPayload(value: unknown): value is ATAEventPayload {
  if (!isRecord(value)) return false;
  return isSubagentEventType(value.type)
    && typeof value.message === 'string'
    && (value.summary === undefined || typeof value.summary === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
