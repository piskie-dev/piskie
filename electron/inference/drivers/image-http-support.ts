import type { ArtifactStore } from '../execution/artifact-port.js';
import { GatewayCallError, localCallError } from '../execution/call-error.js';
import type { AttemptContext, ModelTarget } from '../execution/contracts.js';
import { toImageArtifact } from '../image/artifact-store.js';
import type { ImageArtifact, ImageRequest } from '../image/contracts.js';
import { ImageSubmissionError } from '../image/driver-port.js';
import type { PlainAuth } from '../control/config-schema.js';

export interface ImageHttpCallContext {
  driverId: string;
  target: ModelTarget;
  attempt: AttemptContext;
  stage: string;
}

export interface ImagePayloadSource {
  base64?: string;
  url?: string;
  bytes?: Uint8Array;
  mimeType?: string;
  revisedPrompt?: string;
}

export function configuredHeaders(
  auth: PlainAuth,
  configured: Readonly<Record<string, string>>,
  initial: HeadersInit = {},
): Headers {
  const headers = new Headers(initial);
  headers.delete('authorization');
  if (auth.kind === 'bearer') headers.set('authorization', `Bearer ${auth.value}`);
  if (auth.kind === 'api_key') headers.set(auth.header, auth.value);
  if (auth.kind === 'basic') {
    headers.set('authorization', `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`);
  }
  for (const [name, value] of Object.entries(configured)) headers.set(name, value);
  return headers;
}

export async function requestJson<T>(
  fetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  context: ImageHttpCallContext,
  submission = false,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    throw imageHttpError({
      context,
      source: 'transport',
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
      submission,
      submissionState: 'unknown',
    });
  }

  const body = await readBody(response);
  if (!response.ok) {
    const fields = upstreamFields(body);
    throw imageHttpError({
      context,
      source: 'provider',
      message: fields.message ?? `Image provider returned HTTP ${response.status}`,
      status: response.status,
      requestId: response.headers.get('x-request-id')
        ?? response.headers.get('request-id')
        ?? fields.requestId,
      code: fields.code,
      type: fields.type,
      body,
      submission,
      submissionState: 'rejected',
    });
  }
  return body as T;
}

export function imageProviderResponseError(
  body: unknown,
  context: ImageHttpCallContext,
  options: { submission?: boolean; status?: number; fallbackMessage?: string } = {},
): GatewayCallError {
  const fields = upstreamFields(body);
  return imageHttpError({
    context,
    source: 'provider',
    message: fields.message ?? options.fallbackMessage ?? 'Image provider rejected the request',
    status: options.status,
    requestId: fields.requestId,
    code: fields.code,
    type: fields.type,
    body,
    submission: options.submission ?? false,
    submissionState: 'rejected',
  });
}

export async function storeImagePayload(
  source: ImagePayloadSource,
  input: {
    artifacts: ArtifactStore;
    fetch: typeof globalThis.fetch;
    context: ImageHttpCallContext;
    request: ImageRequest;
    index: number;
    fileNamePrefix: string;
  },
): Promise<ImageArtifact> {
  const payload = await resolvePayload(source, input.fetch, input.context);
  if (payload.bytes.byteLength === 0) {
    throw localCallError({
      gateway: 'image',
      target: input.context.target,
      driverId: input.context.driverId,
      stage: 'response',
      attempt: input.context.attempt.attempt,
      traceId: input.context.attempt.traceId,
      localCode: 'IMAGE_PAYLOAD_EMPTY',
      message: 'Image provider returned an empty image payload',
    });
  }
  const dimensions = requestDimensions(input.request);
  const stored = await input.artifacts.write({
    bytes: payload.bytes,
    mimeType: payload.mimeType,
    fileName: `${input.fileNamePrefix}-${input.index}.${extensionForMime(payload.mimeType)}`,
    metadata: {
      ...dimensions,
      ...(source.revisedPrompt && { revisedPrompt: source.revisedPrompt }),
    },
  }, input.context.attempt.signal);
  return toImageArtifact(stored);
}

async function resolvePayload(
  source: ImagePayloadSource,
  fetch: typeof globalThis.fetch,
  context: ImageHttpCallContext,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  if (source.bytes) {
    return { bytes: source.bytes, mimeType: source.mimeType ?? 'image/png' };
  }
  if (source.base64) {
    const parsed = parseDataUrl(source.base64);
    return {
      bytes: Buffer.from(parsed?.base64 ?? source.base64, 'base64'),
      mimeType: source.mimeType ?? parsed?.mimeType ?? 'image/png',
    };
  }
  if (!source.url) {
    throw localCallError({
      gateway: 'image',
      target: context.target,
      driverId: context.driverId,
      stage: 'response',
      attempt: context.attempt.attempt,
      traceId: context.attempt.traceId,
      localCode: 'IMAGE_PAYLOAD_MISSING',
      message: 'Image provider response contained no image bytes, base64, or URL',
    });
  }
  const dataUrl = parseDataUrl(source.url);
  if (dataUrl) {
    return { bytes: Buffer.from(dataUrl.base64, 'base64'), mimeType: dataUrl.mimeType };
  }

  let response: Response;
  try {
    response = await fetch(source.url, { signal: context.attempt.signal });
  } catch (cause) {
    throw new GatewayCallError({
      source: 'transport',
      gateway: 'image',
      providerId: context.target.providerId,
      modelId: context.target.modelId,
      driverId: context.driverId,
      stage: 'artifact_download',
      attempt: context.attempt.attempt,
      traceId: context.attempt.traceId,
      message: cause instanceof Error ? cause.message : String(cause),
    }, { cause });
  }
  if (!response.ok) {
    const body = await readBody(response);
    const fields = upstreamFields(body);
    const message = fields.message ?? `Image download failed with HTTP ${response.status}`;
    throw new GatewayCallError({
      source: 'provider',
      gateway: 'image',
      providerId: context.target.providerId,
      modelId: context.target.modelId,
      driverId: context.driverId,
      stage: 'artifact_download',
      attempt: context.attempt.attempt,
      traceId: context.attempt.traceId,
      message,
      upstream: {
        status: response.status,
        message,
        ...(fields.code && { code: fields.code }),
        ...(fields.type && { type: fields.type }),
        requestId: response.headers.get('x-request-id') ?? fields.requestId,
        body,
      },
    });
  }
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    mimeType: response.headers.get('content-type')?.split(';')[0] || source.mimeType || 'image/png',
  };
}

function imageHttpError(input: {
  context: ImageHttpCallContext;
  source: 'provider' | 'transport';
  message: string;
  cause?: unknown;
  status?: number;
  requestId?: string;
  code?: string;
  type?: string;
  body?: unknown;
  submission: boolean;
  submissionState: 'rejected' | 'unknown';
}): GatewayCallError {
  const data = {
    source: input.source,
    gateway: 'image' as const,
    providerId: input.context.target.providerId,
    modelId: input.context.target.modelId,
    driverId: input.context.driverId,
    stage: input.context.stage,
    attempt: input.context.attempt.attempt,
    traceId: input.context.attempt.traceId,
    message: input.message,
    ...(input.source === 'provider' && {
      upstream: {
        status: input.status,
        ...(input.code && { code: input.code }),
        ...(input.type && { type: input.type }),
        message: input.message,
        ...(input.requestId && { requestId: input.requestId }),
        body: input.body,
      },
    }),
  };
  if (input.submission) {
    return new ImageSubmissionError(
      data,
      input.submissionState,
      input.submissionState === 'rejected' && retryableStatus(input.status),
      { cause: input.cause },
    );
  }
  return new GatewayCallError(data, { cause: input.cause });
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function upstreamFields(body: unknown): {
  message?: string;
  code?: string;
  type?: string;
  requestId?: string;
} {
  if (!isRecord(body)) return typeof body === 'string' ? { message: body } : {};
  const nested = isRecord(body.error) ? body.error : undefined;
  return {
    message: stringField(nested, 'message')
      ?? stringField(body, 'message')
      ?? stringField(body, 'error_msg')
      ?? stringField(body, 'detail'),
    code: stringField(nested, 'code')
      ?? stringField(body, 'code')
      ?? numberField(body, 'error_code'),
    type: stringField(nested, 'type') ?? stringField(body, 'type'),
    requestId: stringField(body, 'request_id') ?? stringField(body, 'requestId'),
  };
}

function requestDimensions(request: ImageRequest): { width?: number; height?: number } {
  const output = request.operation.output;
  return {
    ...(output?.width !== undefined && { width: output.width }),
    ...(output?.height !== undefined && { height: output.height }),
  };
}

function parseDataUrl(value: string): { mimeType: string; base64: string } | undefined {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(value);
  return match ? { mimeType: match[1]!, base64: match[2]! } : undefined;
}

function extensionForMime(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/gif') return 'gif';
  return 'png';
}

function retryableStatus(status: number | undefined): boolean {
  return status !== undefined && ([408, 409, 425, 429].includes(status) || status >= 500);
}

function stringField(record: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = record?.[field];
  return typeof value === 'string' ? value : undefined;
}

function numberField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'number' ? String(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
