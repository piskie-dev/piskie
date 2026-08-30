import type { ComfyWorkflow } from '../../control/workflow-assets.js';
import type { ArtifactPayload } from '../../execution/artifact-port.js';
import { GatewayCallError } from '../../execution/call-error.js';
import type { AttemptContext, ModelTarget } from '../../execution/contracts.js';
import { ImageSubmissionError } from '../../image/driver-port.js';

export interface ComfyConnection {
  baseUrl: string;
  headers: Readonly<Record<string, string>>;
}

export interface ComfyCallContext {
  target: ModelTarget;
  attempt: Pick<AttemptContext, 'attempt' | 'traceId' | 'signal'>;
}

export interface ComfyPromptReceipt {
  promptId: string;
  position?: number;
  body: unknown;
}

export interface ComfyFileReference {
  filename: string;
  subfolder: string;
  type: string;
}

export class ComfyHttpClient {
  constructor(
    private readonly connection: ComfyConnection,
    private readonly fetch: typeof globalThis.fetch,
  ) {}

  socketUrl(clientId: string): string {
    const url = new URL(`${this.connection.baseUrl}/ws`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('clientId', clientId);
    return url.toString();
  }

  socketHeaders(): Readonly<Record<string, string>> {
    return this.connection.headers;
  }

  async upload(
    payload: ArtifactPayload,
    fileName: string,
    context: ComfyCallContext,
  ): Promise<string> {
    const form = new FormData();
    const uploadBytes = Uint8Array.from(payload.bytes).buffer as ArrayBuffer;
    form.append('image', new Blob([uploadBytes], { type: payload.mimeType }), fileName);
    form.append('type', 'input');
    form.append('overwrite', 'false');
    const response = await this.request('/upload/image', {
      method: 'POST',
      body: form,
      signal: context.attempt.signal,
    }, 'upload', 'pre_prompt', context);
    const body = await readBody(response);
    if (!response.ok) throw responseError(response, body, 'upload', 'pre_prompt', context);
    if (!isRecord(body) || typeof body.name !== 'string') {
      throw invalidResponseError(response, body, 'upload', 'pre_prompt', context, 'ComfyUI upload response has no filename');
    }
    const subfolder = typeof body.subfolder === 'string' ? normalizeSubfolder(body.subfolder) : '';
    return subfolder ? `${subfolder}/${body.name}` : body.name;
  }

  async submit(
    workflow: ComfyWorkflow,
    clientId: string,
    context: ComfyCallContext,
  ): Promise<ComfyPromptReceipt> {
    const response = await this.request('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: clientId }),
      signal: context.attempt.signal,
    }, 'submit', 'prompt', context);
    const body = await readBody(response);
    if (!response.ok) throw responseError(response, body, 'submit', 'prompt', context);
    if (!isRecord(body) || typeof body.prompt_id !== 'string' || body.prompt_id.length === 0) {
      throw invalidResponseError(response, body, 'submit', 'prompt', context, 'ComfyUI prompt response has no prompt_id');
    }
    return {
      promptId: body.prompt_id,
      ...(typeof body.number === 'number' && { position: body.number }),
      body,
    };
  }

  async history(promptId: string, context: ComfyCallContext): Promise<unknown> {
    const response = await this.request(`/history/${encodeURIComponent(promptId)}`, {
      signal: context.attempt.signal,
    }, 'history', 'accepted', context);
    const body = await readBody(response);
    if (!response.ok) throw responseError(response, body, 'history', 'accepted', context);
    return body;
  }

  async download(reference: ComfyFileReference, context: ComfyCallContext): Promise<ArtifactPayload> {
    const query = new URLSearchParams({
      filename: reference.filename,
      subfolder: reference.subfolder,
      type: reference.type,
    });
    const response = await this.request(`/view?${query.toString()}`, {
      signal: context.attempt.signal,
    }, 'artifact_download', 'accepted', context);
    if (!response.ok) {
      const body = await readBody(response);
      throw responseError(response, body, 'artifact_download', 'accepted', context);
    }
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      mimeType: response.headers.get('content-type')?.split(';', 1)[0]?.trim() || 'application/octet-stream',
      fileName: reference.filename,
    };
  }

  async systemStats(signal: AbortSignal, context: ComfyCallContext): Promise<unknown> {
    const response = await this.request('/system_stats', { signal }, 'probe', 'accepted', context);
    const body = await readBody(response);
    if (!response.ok) throw responseError(response, body, 'probe', 'accepted', context);
    return body;
  }

  private async request(
    path: string,
    init: RequestInit,
    stage: string,
    phase: SubmissionPhase,
    context: ComfyCallContext,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(this.connection.headers)) {
      if (!headers.has(name)) headers.set(name, value);
    }
    try {
      return await this.fetch(`${this.connection.baseUrl}${path}`, { ...init, headers });
    } catch (cause) {
      throw transportError(cause, stage, phase, context);
    }
  }
}

type SubmissionPhase = 'pre_prompt' | 'prompt' | 'accepted';

function transportError(
  cause: unknown,
  stage: string,
  phase: SubmissionPhase,
  context: ComfyCallContext,
): GatewayCallError {
  const data = {
    source: 'transport' as const,
    gateway: 'image' as const,
    providerId: context.target.providerId,
    modelId: context.target.modelId,
    driverId: 'comfyui-workflow',
    stage,
    attempt: context.attempt.attempt,
    traceId: context.attempt.traceId,
    message: cause instanceof Error ? cause.message : String(cause),
  };
  if (phase === 'accepted') return new GatewayCallError(data, { cause });
  if (phase === 'pre_prompt') return new ImageSubmissionError(data, 'not_accepted', true, { cause });
  return new ImageSubmissionError(data, 'unknown', false, { cause });
}

function responseError(
  response: Response,
  body: unknown,
  stage: string,
  phase: SubmissionPhase,
  context: ComfyCallContext,
): GatewayCallError {
  const message = upstreamMessage(body) ?? `ComfyUI request failed with HTTP ${response.status}`;
  const fields = upstreamFields(body);
  const data = {
    source: 'provider' as const,
    gateway: 'image' as const,
    providerId: context.target.providerId,
    modelId: context.target.modelId,
    driverId: 'comfyui-workflow',
    stage,
    attempt: context.attempt.attempt,
    traceId: context.attempt.traceId,
    message,
    upstream: {
      status: response.status,
      ...fields,
      message,
      requestId: response.headers.get('x-request-id') ?? undefined,
      body,
    },
  };
  if (phase === 'accepted') return new GatewayCallError(data);
  return new ImageSubmissionError(
    data,
    phase === 'pre_prompt' ? 'not_accepted' : 'rejected',
    isRetryableStatus(response.status),
  );
}

function invalidResponseError(
  response: Response,
  body: unknown,
  stage: string,
  phase: Exclude<SubmissionPhase, 'accepted'>,
  context: ComfyCallContext,
  message: string,
): ImageSubmissionError {
  return new ImageSubmissionError({
    source: 'provider',
    gateway: 'image',
    providerId: context.target.providerId,
    modelId: context.target.modelId,
    driverId: 'comfyui-workflow',
    stage,
    attempt: context.attempt.attempt,
    traceId: context.attempt.traceId,
    message,
    upstream: {
      status: response.status,
      message,
      requestId: response.headers.get('x-request-id') ?? undefined,
      body,
    },
  }, phase === 'pre_prompt' ? 'not_accepted' : 'unknown', false);
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

function upstreamMessage(body: unknown): string | undefined {
  if (typeof body === 'string') return body;
  if (!isRecord(body)) return undefined;
  if (typeof body.message === 'string') return body.message;
  if (typeof body.detail === 'string') return body.detail;
  if (typeof body.error === 'string') return body.error;
  if (isRecord(body.error) && typeof body.error.message === 'string') return body.error.message;
  if (typeof body.exception_message === 'string') return body.exception_message;
  return undefined;
}

function upstreamFields(body: unknown): { code?: string; type?: string } {
  if (!isRecord(body)) return {};
  const error = isRecord(body.error) ? body.error : body;
  return {
    ...(typeof error.code === 'string' && { code: error.code }),
    ...(typeof error.type === 'string' && { type: error.type }),
  };
}

function normalizeSubfolder(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
}

function isRetryableStatus(status: number): boolean {
  return [408, 409, 425, 429].includes(status) || status >= 500;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
