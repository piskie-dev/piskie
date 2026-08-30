import type { ComfyFileReference } from './http-client.js';

export type ComfySocketProjection =
  | { kind: 'ignore' }
  | { kind: 'progress'; value: number; message?: string }
  | { kind: 'terminal' }
  | { kind: 'failure'; message: string; body: unknown; type?: string };

export type ComfyHistoryState =
  | { kind: 'pending' }
  | { kind: 'completed'; files: readonly ComfyFileReference[]; body: unknown }
  | { kind: 'failure'; message: string; body: unknown; type?: string };

export interface ComfyPreviewPayload {
  bytes: Uint8Array;
  declaredMimeType?: string;
}

export function projectComfySocketMessage(value: unknown, promptId: string): ComfySocketProjection {
  if (!isRecord(value) || typeof value.type !== 'string' || !isRecord(value.data)) return { kind: 'ignore' };
  const data = value.data;
  if (typeof data.prompt_id === 'string' && data.prompt_id !== promptId) return { kind: 'ignore' };

  switch (value.type) {
    case 'progress': {
      if (typeof data.value !== 'number' || typeof data.max !== 'number' || data.max <= 0) return { kind: 'ignore' };
      return {
        kind: 'progress',
        value: Math.max(0, Math.min(1, data.value / data.max)),
        ...(typeof data.node === 'string' && { message: `Executing node ${data.node}` }),
      };
    }
    case 'executing':
      return data.node === null
        ? { kind: 'terminal' }
        : {
            kind: 'progress',
            value: 0,
            ...(typeof data.node === 'string' && { message: `Executing node ${data.node}` }),
          };
    case 'execution_start':
      return { kind: 'progress', value: 0, message: 'Execution started' };
    case 'execution_cached':
      return { kind: 'progress', value: 0, message: 'Using cached nodes' };
    case 'execution_success':
      return { kind: 'terminal' };
    case 'execution_error':
    case 'execution_interrupted':
      return {
        kind: 'failure',
        message: failureMessage(data, `ComfyUI ${value.type}`),
        body: structuredClone(data),
        ...(typeof data.exception_type === 'string' && { type: data.exception_type }),
      };
    case 'status': {
      const status = isRecord(data.status) ? data.status : undefined;
      const execution = status && isRecord(status.exec_info) ? status.exec_info : undefined;
      if (typeof execution?.queue_remaining !== 'number') return { kind: 'ignore' };
      return {
        kind: 'progress',
        value: 0,
        message: `Queue remaining: ${execution.queue_remaining}`,
      };
    }
    default:
      return { kind: 'ignore' };
  }
}

export function projectComfyPreview(bytes: Uint8Array): ComfyPreviewPayload | undefined {
  if (bytes.byteLength <= 8) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== 1) return undefined;
  const imageType = view.getUint32(4, false);
  return {
    bytes: bytes.slice(8),
    ...(imageType === 1 && { declaredMimeType: 'image/jpeg' }),
    ...(imageType === 2 && { declaredMimeType: 'image/png' }),
  };
}

export function projectComfyHistory(
  body: unknown,
  promptId: string,
  outputNodeIds: readonly string[],
): ComfyHistoryState {
  if (!isRecord(body)) return { kind: 'pending' };
  const entry = body[promptId];
  if (!isRecord(entry)) return { kind: 'pending' };
  const status = isRecord(entry.status) ? entry.status : undefined;
  const failure = historyFailure(status);
  if (failure) return { ...failure, body: structuredClone(body) };

  const completed = status?.completed === true || status?.status_str === 'success';
  if (!completed) return { kind: 'pending' };
  const outputs = isRecord(entry.outputs) ? entry.outputs : {};
  const files: ComfyFileReference[] = [];
  for (const nodeId of outputNodeIds) {
    const output = outputs[nodeId];
    if (!isRecord(output) || !Array.isArray(output.images)) continue;
    for (const candidate of output.images) {
      if (!isRecord(candidate) || typeof candidate.filename !== 'string') continue;
      files.push({
        filename: candidate.filename,
        subfolder: typeof candidate.subfolder === 'string' ? candidate.subfolder : '',
        type: typeof candidate.type === 'string' ? candidate.type : 'output',
      });
    }
  }
  if (files.length === 0) {
    return {
      kind: 'failure',
      message: `ComfyUI history completed without images from output nodes: ${outputNodeIds.join(', ')}`,
      body: structuredClone(body),
    };
  }
  return { kind: 'completed', files, body: structuredClone(body) };
}

function historyFailure(status: Record<string, unknown> | undefined):
  | { kind: 'failure'; message: string; type?: string }
  | undefined {
  if (!status) return undefined;
  if (Array.isArray(status.messages)) {
    for (const message of status.messages) {
      if (!Array.isArray(message) || typeof message[0] !== 'string' || !isRecord(message[1])) continue;
      if (message[0] !== 'execution_error' && message[0] !== 'execution_interrupted') continue;
      return {
        kind: 'failure',
        message: failureMessage(message[1], `ComfyUI ${message[0]}`),
        ...(typeof message[1].exception_type === 'string' && { type: message[1].exception_type }),
      };
    }
  }
  if (status.status_str === 'error') return { kind: 'failure', message: 'ComfyUI history reports an execution error' };
  return undefined;
}

function failureMessage(body: Record<string, unknown>, fallback: string): string {
  if (typeof body.exception_message === 'string') return body.exception_message;
  if (typeof body.message === 'string') return body.message;
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

