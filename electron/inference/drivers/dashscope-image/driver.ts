import { z } from 'zod';
import type { ArtifactReader, ArtifactStore } from '../../execution/artifact-port.js';
import { isGatewayCallError, localCallError } from '../../execution/call-error.js';
import type { AttemptContext } from '../../execution/contracts.js';
import type { ImageRequest } from '../../image/contracts.js';
import {
  ImageSubmissionError,
  type ImageAttemptEvent,
  type ImageResumeInput,
} from '../../image/driver-port.js';
import type {
  DriverCompileInput,
  DriverValidationIssue,
  InferenceDriver,
  ProbeReceipt,
  ProviderConnectivityProbeInput,
} from '../contracts.js';
import {
  configuredHeaders,
  imageProviderResponseError,
  requestJson,
  storeImagePayload,
  type ImagePayloadSource,
} from '../image-http-support.js';

const DRIVER_ID = 'dashscope-image';
const providerOptionsSchema = z.object({
  pollIntervalMs: z.number().int().min(100).max(30_000).default(1_000)
    .describe('Interval between DashScope asynchronous task status requests.'),
}).strip();
const modelOptionsSchema = z.object({}).strip();

interface DashScopeResponse {
  output?: {
    task_id?: string;
    task_status?: string;
    choices?: Array<{
      message?: {
        content?: Array<{ image?: string; url?: string; text?: string }>;
      };
    }>;
    results?: Array<{ url?: string; image?: string; b64_image?: string }>;
    result_url?: string;
  };
  usage?: {
    image_count?: number;
  };
  request_id?: string;
  code?: string;
  message?: string;
}

export interface DashScopeImageDriverDependencies {
  fetch?: typeof globalThis.fetch;
  resolveFetch?: (proxyId: string | null, fallback: typeof globalThis.fetch) => typeof globalThis.fetch;
  artifacts?: ArtifactReader;
  imageArtifacts?: ArtifactStore;
  now?: () => Date;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export function createDashScopeImageDriver(
  dependencies: DashScopeImageDriverDependencies = {},
): InferenceDriver {
  const baseFetch = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? (() => new Date());
  return {
    manifest: {
      id: DRIVER_ID,
      supportedGateways: ['image'],
      acceptedAuth: ['bearer'],
      providerConfigSchema: z.toJSONSchema(providerOptionsSchema) as Record<string, unknown>,
      modelOptionsSchema: z.toJSONSchema(modelOptionsSchema) as Record<string, unknown>,
    },
    validateProviderOptions: (options) => zodIssues(providerOptionsSchema.safeParse(options)),
    validateModelOptions: (options) => zodIssues(modelOptionsSchema.safeParse(options)),
    compile: (input) => compileTarget(input, dependencies, baseFetch),
    probeConnectivity: (input) => probeConnectivity(input, dependencies, baseFetch, now),
  };
}

function compileTarget(
  input: DriverCompileInput,
  dependencies: DashScopeImageDriverDependencies,
  baseFetch: typeof globalThis.fetch,
) {
  if (input.catalogModel.kind !== 'image') throw new Error('DashScope image Driver requires an Image model');
  if (!dependencies.imageArtifacts) throw new Error('DashScope image Driver requires an Artifact Store');
  const providerOptions = providerOptionsSchema.parse(input.provider.driverOptions);
  modelOptionsSchema.parse(input.binding.options);
  const target = { providerId: input.providerId, modelId: input.modelId };
  const compiled = {
    target,
    upstreamModel: input.binding.upstreamId,
    baseUrl: trimTrailingSlash(input.provider.connection.baseUrl),
    auth: structuredClone(input.provider.connection.auth),
    headers: { ...input.provider.connection.headers },
    artifacts: dependencies.artifacts,
    imageArtifacts: dependencies.imageArtifacts,
    fetch: dependencies.resolveFetch?.(input.provider.connection.proxyId, baseFetch) ?? baseFetch,
    pollIntervalMs: providerOptions.pollIntervalMs,
    sleep: dependencies.sleep ?? abortableDelay,
  };
  return {
    ref: target,
    driverId: DRIVER_ID,
    upstreamModel: input.binding.upstreamId,
    catalogId: input.binding.catalogId,
    configRevision: input.configRevision,
    image: {
      mode: 'job' as const,
      submit: (request: ImageRequest, context: AttemptContext) => submit(compiled, request, context),
      resume: (resumeInput: ImageResumeInput, context: AttemptContext) => observeTask(
        compiled,
        resumeInput.request,
        resumeInput.job.upstreamJobId,
        context,
      ),
    },
  };
}

async function* submit(
  compiled: CompiledDashScopeTarget,
  request: ImageRequest,
  context: AttemptContext,
): AsyncIterable<ImageAttemptEvent> {
  let body: Record<string, unknown>;
  try {
    body = await mapRequest(compiled, request, context.signal);
  } catch (cause) {
    throw new ImageSubmissionError({
      source: 'local',
      gateway: 'image',
      providerId: compiled.target.providerId,
      modelId: compiled.target.modelId,
      driverId: DRIVER_ID,
      stage: 'serialize',
      attempt: context.attempt,
      traceId: context.traceId,
      message: cause instanceof Error ? cause.message : String(cause),
      localCode: 'DASHSCOPE_IMAGE_SERIALIZATION_FAILED',
    }, 'not_accepted', false, { cause });
  }

  const callContext = { driverId: DRIVER_ID, target: compiled.target, attempt: context, stage: 'submit' };
  const response = await requestJson<DashScopeResponse>(
    compiled.fetch,
    apiUrl(compiled.baseUrl, '/services/aigc/image-generation/generation'),
    {
      method: 'POST',
      headers: configuredHeaders(compiled.auth, compiled.headers, {
        'content-type': 'application/json',
        'x-dashscope-async': 'enable',
      }),
      body: JSON.stringify(body),
      signal: context.signal,
    },
    callContext,
    true,
  );
  if (response.code) throw imageProviderResponseError(response, callContext, { submission: true });
  const taskId = response.output?.task_id;
  if (!taskId) {
    throw new ImageSubmissionError({
      source: 'provider',
      gateway: 'image',
      providerId: compiled.target.providerId,
      modelId: compiled.target.modelId,
      driverId: DRIVER_ID,
      stage: 'submit',
      attempt: context.attempt,
      traceId: context.traceId,
      message: 'DashScope response did not contain task_id',
      upstream: {
        message: 'DashScope response did not contain task_id',
        requestId: response.request_id,
        body: response,
      },
    }, 'unknown', false);
  }

  yield { kind: 'job.accepted', upstreamJobId: taskId, resumable: true };
  yield* observeTask(compiled, request, taskId, context);
}

async function* observeTask(
  compiled: CompiledDashScopeTarget,
  request: ImageRequest,
  taskId: string,
  context: AttemptContext,
): AsyncIterable<ImageAttemptEvent> {
  while (true) {
    await compiled.sleep(compiled.pollIntervalMs, context.signal);
    const callContext = { driverId: DRIVER_ID, target: compiled.target, attempt: context, stage: 'poll' };
    const response = await requestJson<DashScopeResponse>(
      compiled.fetch,
      apiUrl(compiled.baseUrl, `/tasks/${encodeURIComponent(taskId)}`),
      {
        headers: configuredHeaders(compiled.auth, compiled.headers),
        signal: context.signal,
      },
      callContext,
    );
    if (response.code) throw imageProviderResponseError(response, callContext);

    const status = response.output?.task_status?.toUpperCase();
    if (status === 'PENDING') {
      yield { kind: 'progress', value: 0, message: 'PENDING' };
      continue;
    }
    if (status === 'RUNNING') {
      yield { kind: 'progress', value: 0.5, message: 'RUNNING' };
      continue;
    }
    if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
      throw imageProviderResponseError(response, callContext, {
        fallbackMessage: `DashScope image task ${status.toLowerCase()}`,
      });
    }
    if (status !== 'SUCCEEDED') {
      throw localCallError({
        gateway: 'image',
        target: compiled.target,
        driverId: DRIVER_ID,
        stage: 'poll',
        attempt: context.attempt,
        traceId: context.traceId,
        localCode: 'DASHSCOPE_TASK_STATUS_INVALID',
        message: `DashScope returned an unknown task status: ${status ?? '<missing>'}`,
      });
    }

    const payloads = dashScopePayloads(response);
    if (payloads.length === 0) {
      throw localCallError({
        gateway: 'image',
        target: compiled.target,
        driverId: DRIVER_ID,
        stage: 'response',
        attempt: context.attempt,
        traceId: context.traceId,
        localCode: 'DASHSCOPE_IMAGE_RESPONSE_EMPTY',
        message: 'DashScope image task succeeded without an image',
      });
    }
    for (const [index, payload] of payloads.entries()) {
      yield {
        kind: 'artifact',
        artifact: await storeImagePayload(payload, {
          artifacts: compiled.imageArtifacts,
          fetch: compiled.fetch,
          context: { ...callContext, stage: 'response' },
          request,
          index,
          fileNamePrefix: 'dashscope-image',
        }),
      };
    }
    yield {
      kind: 'completed',
      usage: { imageCount: response.usage?.image_count ?? payloads.length },
    };
    return;
  }
}

interface CompiledDashScopeTarget {
  target: { providerId: string; modelId: string };
  upstreamModel: string;
  baseUrl: string;
  auth: DriverCompileInput['provider']['connection']['auth'];
  headers: Record<string, string>;
  artifacts?: ArtifactReader;
  imageArtifacts: ArtifactStore;
  fetch: typeof globalThis.fetch;
  pollIntervalMs: number;
  sleep(delayMs: number, signal: AbortSignal): Promise<void>;
}

async function mapRequest(
  compiled: CompiledDashScopeTarget,
  request: ImageRequest,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const content: Array<{ text: string } | { image: string }> = [];
  if (request.operation.kind === 'edit') {
    if (!compiled.artifacts) throw new Error('DashScope image edits require an Artifact Reader');
    for (const source of request.operation.sources) {
      content.push({ image: await artifactDataUrl(compiled.artifacts, source, signal) });
    }
    if (request.operation.mask) {
      content.push({ image: await artifactDataUrl(compiled.artifacts, request.operation.mask, signal) });
    }
  }
  content.push({ text: request.operation.prompt });
  const output = request.operation.output;
  return {
    model: compiled.upstreamModel,
    input: { messages: [{ role: 'user', content }] },
    parameters: {
      ...(request.operation.count !== undefined && { n: request.operation.count }),
      ...(output?.width !== undefined && output.height !== undefined && {
        size: `${output.width}*${output.height}`,
      }),
    },
  };
}

async function artifactDataUrl(
  artifacts: ArtifactReader,
  ref: { artifactId: string },
  signal: AbortSignal,
): Promise<string> {
  const payload = await artifacts.read(ref, signal);
  return `data:${payload.mimeType};base64,${Buffer.from(payload.bytes).toString('base64')}`;
}

function dashScopePayloads(response: DashScopeResponse): ImagePayloadSource[] {
  const revisedPrompt = response.output?.choices
    ?.flatMap((choice) => choice.message?.content ?? [])
    .map((content) => content.text ?? '')
    .join('')
    .trim() || undefined;
  const urls = [
    ...(response.output?.choices ?? []).flatMap((choice) => (
      choice.message?.content?.flatMap((content) => content.image ?? content.url ?? []) ?? []
    )),
    ...(response.output?.results ?? []).flatMap((result) => result.url ?? result.image ?? []),
    ...(response.output?.result_url ? [response.output.result_url] : []),
  ];
  const base64 = (response.output?.results ?? []).flatMap((result) => result.b64_image ?? []);
  const payloads: ImagePayloadSource[] = [...new Set(urls)]
    .map((url) => ({ url, ...(revisedPrompt && { revisedPrompt }) }));
  payloads.push(...[...new Set(base64)]
    .map((value) => ({ base64: value, ...(revisedPrompt && { revisedPrompt }) })));
  return payloads;
}

async function probeConnectivity(
  input: ProviderConnectivityProbeInput,
  dependencies: DashScopeImageDriverDependencies,
  baseFetch: typeof globalThis.fetch,
  now: () => Date,
): Promise<ProbeReceipt> {
  const startedAt = now().toISOString();
  const context = probeAttempt(input);
  const fetch = dependencies.resolveFetch?.(input.provider.connection.proxyId, baseFetch) ?? baseFetch;
  try {
    await requestJson(
      fetch,
      apiUrl(trimTrailingSlash(input.provider.connection.baseUrl), '/models'),
      {
        headers: configuredHeaders(input.provider.connection.auth, input.provider.connection.headers),
        signal: input.signal,
      },
      { driverId: DRIVER_ID, target: { providerId: input.providerId, modelId: 'connectivity' }, attempt: context, stage: 'connectivity' },
    );
    return {
      driverId: DRIVER_ID,
      providerId: input.providerId,
      level: 'connectivity',
      success: true,
      startedAt,
      completedAt: now().toISOString(),
    };
  } catch (cause) {
    const error = isGatewayCallError(cause) ? cause : localCallError({
      gateway: 'image',
      target: { providerId: input.providerId, modelId: 'connectivity' },
      driverId: DRIVER_ID,
      stage: 'connectivity',
      attempt: 1,
      traceId: context.traceId,
      localCode: 'DASHSCOPE_CONNECTIVITY_FAILED',
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
    return {
      driverId: DRIVER_ID,
      providerId: input.providerId,
      level: 'connectivity',
      success: false,
      startedAt,
      completedAt: now().toISOString(),
      status: error.upstream?.status,
      requestId: error.upstream?.requestId,
      error: error.toJSON(),
    };
  }
}

function apiUrl(baseUrl: string, path: string): string {
  return /\/api\/v1$/i.test(baseUrl) ? `${baseUrl}${path}` : `${baseUrl}/api/v1${path}`;
}

function probeAttempt(input: ProviderConnectivityProbeInput): AttemptContext {
  return {
    runId: `probe:${input.providerId}`,
    traceId: `probe:${input.providerId}`,
    signal: input.signal,
    attempt: 1,
    configRevision: 0,
    connectTimeoutMs: 30_000,
  };
}

async function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

function zodIssues(result: z.ZodSafeParseResult<unknown>): readonly DriverValidationIssue[] {
  if (result.success) return [];
  return result.error.issues.map((issue) => ({
    path: issue.path.length ? `/${issue.path.map(String).join('/')}` : '',
    code: 'DASHSCOPE_IMAGE_OPTIONS_INVALID',
    message: issue.message,
  }));
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
