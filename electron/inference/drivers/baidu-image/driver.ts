import { z } from 'zod';
import type { ArtifactReader, ArtifactStore } from '../../execution/artifact-port.js';
import { isGatewayCallError, localCallError } from '../../execution/call-error.js';
import type { AttemptContext } from '../../execution/contracts.js';
import type { ImageRequest } from '../../image/contracts.js';
import { ImageSubmissionError, type ImageAttemptEvent } from '../../image/driver-port.js';
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

const DRIVER_ID = 'baidu-image';
const providerOptionsSchema = z.object({}).strip();
const modelOptionsSchema = z.object({}).strip();

interface BaiduImageResponse {
  id?: string;
  data?: Array<{
    url?: string;
    b64_json?: string;
    revised_prompt?: string;
  }>;
  code?: string;
  message?: string;
  type?: string;
}

export interface BaiduImageDriverDependencies {
  fetch?: typeof globalThis.fetch;
  resolveFetch?: (proxyId: string | null, fallback: typeof globalThis.fetch) => typeof globalThis.fetch;
  artifacts?: ArtifactReader;
  imageArtifacts?: ArtifactStore;
  now?: () => Date;
}

export function createBaiduImageDriver(
  dependencies: BaiduImageDriverDependencies = {},
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
  dependencies: BaiduImageDriverDependencies,
  baseFetch: typeof globalThis.fetch,
) {
  if (input.catalogModel.kind !== 'image') throw new Error('Baidu image Driver requires an Image model');
  if (!dependencies.imageArtifacts) throw new Error('Baidu image Driver requires an Artifact Store');
  providerOptionsSchema.parse(input.provider.driverOptions);
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
  };
  return {
    ref: target,
    driverId: DRIVER_ID,
    upstreamModel: input.binding.upstreamId,
    catalogId: input.binding.catalogId,
    configRevision: input.configRevision,
    image: {
      mode: 'synchronous' as const,
      submit: (request: ImageRequest, context: AttemptContext) => submit(compiled, request, context),
    },
  };
}

async function* submit(
  compiled: CompiledBaiduTarget,
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
      localCode: 'BAIDU_IMAGE_SERIALIZATION_FAILED',
    }, 'not_accepted', false, { cause });
  }

  const endpoint = request.operation.kind === 'generate' ? '/images/generations' : '/images/edits';
  const callContext = { driverId: DRIVER_ID, target: compiled.target, attempt: context, stage: 'request' };
  const response = await requestJson<BaiduImageResponse>(
    compiled.fetch,
    apiUrl(compiled.baseUrl, endpoint),
    {
      method: 'POST',
      headers: configuredHeaders(compiled.auth, compiled.headers, { 'content-type': 'application/json' }),
      body: JSON.stringify(body),
      signal: context.signal,
    },
    callContext,
    true,
  );
  if (response.code) throw imageProviderResponseError(response, callContext, { submission: true });
  const payloads = baiduPayloads(response);
  if (payloads.length === 0) {
    throw localCallError({
      gateway: 'image',
      target: compiled.target,
      driverId: DRIVER_ID,
      stage: 'response',
      attempt: context.attempt,
      traceId: context.traceId,
      localCode: 'BAIDU_IMAGE_RESPONSE_EMPTY',
      message: 'Baidu image response did not contain an image',
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
        fileNamePrefix: 'baidu-image',
      }),
    };
  }
  yield { kind: 'completed', usage: { imageCount: payloads.length } };
}

interface CompiledBaiduTarget {
  target: { providerId: string; modelId: string };
  upstreamModel: string;
  baseUrl: string;
  auth: DriverCompileInput['provider']['connection']['auth'];
  headers: Record<string, string>;
  artifacts?: ArtifactReader;
  imageArtifacts: ArtifactStore;
  fetch: typeof globalThis.fetch;
}

async function mapRequest(
  compiled: CompiledBaiduTarget,
  request: ImageRequest,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const operation = request.operation;
  const output = operation.output;
  const common = {
    model: compiled.upstreamModel,
    prompt: operation.prompt,
    ...(operation.count !== undefined && { n: operation.count }),
    ...(output?.width !== undefined && output.height !== undefined && {
      size: `${output.width}x${output.height}`,
    }),
  };
  if (operation.kind === 'generate') return common;
  if (!compiled.artifacts) throw new Error('Baidu image edits require an Artifact Reader');
  const images = await Promise.all(operation.sources.map((source) => (
    artifactDataUrl(compiled.artifacts!, source, signal)
  )));
  const mask = operation.mask
    ? await artifactDataUrl(compiled.artifacts, operation.mask, signal)
    : undefined;
  return {
    ...common,
    image: images.length === 1 ? images[0] : images,
    ...(mask && { mask }),
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

function baiduPayloads(response: BaiduImageResponse): ImagePayloadSource[] {
  return (response.data ?? []).flatMap((item): ImagePayloadSource[] => {
    if (item.b64_json) return [{ base64: item.b64_json, revisedPrompt: item.revised_prompt }];
    if (item.url) return [{ url: item.url, revisedPrompt: item.revised_prompt }];
    return [];
  });
}

async function probeConnectivity(
  input: ProviderConnectivityProbeInput,
  dependencies: BaiduImageDriverDependencies,
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
      localCode: 'BAIDU_CONNECTIVITY_FAILED',
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
  return /\/v2$/i.test(baseUrl) ? `${baseUrl}${path}` : `${baseUrl}/v2${path}`;
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

function zodIssues(result: z.ZodSafeParseResult<unknown>): readonly DriverValidationIssue[] {
  if (result.success) return [];
  return result.error.issues.map((issue) => ({
    path: issue.path.length ? `/${issue.path.map(String).join('/')}` : '',
    code: 'BAIDU_IMAGE_OPTIONS_INVALID',
    message: issue.message,
  }));
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
