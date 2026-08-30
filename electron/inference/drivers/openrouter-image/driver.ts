import OpenAI from 'openai';
import { z } from 'zod';
import type { ArtifactReader, ArtifactStore } from '../../execution/artifact-port.js';
import { isGatewayCallError, localCallError } from '../../execution/call-error.js';
import type { AttemptContext } from '../../execution/contracts.js';
import { createAttemptFetchObserver, type FetchFailureObservation } from '../../execution/observed-fetch.js';
import type { ImageRequest } from '../../image/contracts.js';
import { ImageSubmissionError, type ImageAttemptEvent } from '../../image/driver-port.js';
import type {
  DriverCompileInput,
  DriverValidationIssue,
  InferenceDriver,
  ProbeReceipt,
  ProviderConnectivityProbeInput,
} from '../contracts.js';
import { configuredHeaders, storeImagePayload, type ImagePayloadSource } from '../image-http-support.js';
import { mapOpenRouterImageRequest } from './request-mapper.js';

const DRIVER_ID = 'openrouter-image';
const providerOptionsSchema = z.object({
  sdkTimeoutMs: z.number().int().positive().default(600_000)
    .describe('Maximum milliseconds allowed for one OpenRouter image request attempt.'),
}).strip();
const modelOptionsSchema = z.object({}).strip();

export interface OpenRouterImageDriverDependencies {
  fetch?: typeof globalThis.fetch;
  resolveFetch?: (proxyId: string | null, fallback: typeof globalThis.fetch) => typeof globalThis.fetch;
  artifacts?: ArtifactReader;
  imageArtifacts?: ArtifactStore;
  now?: () => Date;
}

export function createOpenRouterImageDriver(
  dependencies: OpenRouterImageDriverDependencies = {},
): InferenceDriver {
  const baseFetch = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? (() => new Date());
  return {
    manifest: {
      id: DRIVER_ID,
      supportedGateways: ['image'],
      acceptedAuth: ['none', 'bearer', 'api_key', 'basic'],
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
  dependencies: OpenRouterImageDriverDependencies,
  baseFetch: typeof globalThis.fetch,
) {
  if (input.catalogModel.kind !== 'image') throw new Error('OpenRouter image Driver requires an Image model');
  if (!dependencies.imageArtifacts) throw new Error('OpenRouter image Driver requires an Artifact Store');
  providerOptionsSchema.parse(input.provider.driverOptions);
  modelOptionsSchema.parse(input.binding.options);
  const target = { providerId: input.providerId, modelId: input.modelId };
  const fetch = dependencies.resolveFetch?.(input.provider.connection.proxyId, baseFetch) ?? baseFetch;
  const compiled = {
    target,
    upstreamModel: input.binding.upstreamId,
    outputModalities: [...input.catalogModel.outputModalities],
    connection: {
      baseUrl: trimTrailingSlash(input.provider.connection.baseUrl),
      auth: structuredClone(input.provider.connection.auth),
      headers: { ...input.provider.connection.headers },
      sdkTimeoutMs: providerOptionsSchema.parse(input.provider.driverOptions).sdkTimeoutMs,
    },
    artifacts: dependencies.artifacts,
    imageArtifacts: dependencies.imageArtifacts,
    fetch,
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
  compiled: {
    target: { providerId: string; modelId: string };
    upstreamModel: string;
    outputModalities: string[];
    connection: {
      baseUrl: string;
      auth: DriverCompileInput['provider']['connection']['auth'];
      headers: Record<string, string>;
      sdkTimeoutMs: number;
    };
    artifacts?: ArtifactReader;
    imageArtifacts: ArtifactStore;
    fetch: typeof globalThis.fetch;
  },
  request: ImageRequest,
  context: AttemptContext,
): AsyncIterable<ImageAttemptEvent> {
  const observer = createAttemptFetchObserver(compiled.fetch);
  const client = createClient(compiled.connection, observer.fetch);
  try {
    const params = await mapOpenRouterImageRequest(
      request,
      compiled.upstreamModel,
      compiled.outputModalities,
      compiled.artifacts,
      context.signal,
    );
    const response = await client.chat.completions.create(params, { signal: context.signal });
    const payloads = imagePayloads(response);
    if (payloads.length === 0) {
      throw localCallError({
        gateway: 'image',
        target: compiled.target,
        driverId: DRIVER_ID,
        stage: 'response',
        attempt: context.attempt,
        traceId: context.traceId,
        localCode: 'OPENROUTER_IMAGE_RESPONSE_EMPTY',
        message: 'OpenRouter response did not contain an image',
      });
    }
    for (const [index, payload] of payloads.entries()) {
      yield {
        kind: 'artifact',
        artifact: await storeImagePayload(payload, {
          artifacts: compiled.imageArtifacts,
          fetch: compiled.fetch,
          context: { driverId: DRIVER_ID, target: compiled.target, attempt: context, stage: 'response' },
          request,
          index,
          fileNamePrefix: 'openrouter-image',
        }),
      };
    }
    yield { kind: 'completed', usage: { imageCount: payloads.length } };
  } catch (cause) {
    if (isGatewayCallError(cause)) throw cause;
    throw sdkError(cause, observer.failure(), compiled.target, context);
  }
}

function createClient(
  connection: {
    baseUrl: string;
    auth: DriverCompileInput['provider']['connection']['auth'];
    headers: Record<string, string>;
    sdkTimeoutMs: number;
  },
  fetch: typeof globalThis.fetch,
): OpenAI {
  return new OpenAI({
    apiKey: 'piskie-openrouter-image-key',
    baseURL: connection.baseUrl,
    timeout: connection.sdkTimeoutMs,
    maxRetries: 0,
    fetch: async (request, init) => fetch(request, {
      ...init,
      headers: configuredHeaders(
        connection.auth,
        { 'HTTP-Referer': 'https://piskie.dev', 'X-Title': 'Piskie', ...connection.headers },
        init?.headers ?? (request instanceof Request ? request.headers : undefined),
      ),
    }),
  });
}

function imagePayloads(response: OpenAI.Chat.Completions.ChatCompletion): ImagePayloadSource[] {
  const message = response.choices[0]?.message as unknown as Record<string, unknown> | undefined;
  if (!message) return [];
  const urls: string[] = [];
  if (Array.isArray(message.images)) {
    for (const image of message.images) {
      if (!isRecord(image)) continue;
      const nested = isRecord(image.image_url) ? image.image_url.url : undefined;
      const url = typeof nested === 'string' ? nested : typeof image.url === 'string' ? image.url : undefined;
      if (url) urls.push(url);
    }
  }
  if (typeof message.content === 'string') {
    urls.push(...message.content.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g) ?? []);
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!isRecord(part)) continue;
      const nested = isRecord(part.image_url) ? part.image_url.url : undefined;
      if (typeof nested === 'string') urls.push(nested);
      else if (typeof part.url === 'string') urls.push(part.url);
    }
  }
  return [...new Set(urls)].map((url) => ({ url }));
}

async function probeConnectivity(
  input: ProviderConnectivityProbeInput,
  dependencies: OpenRouterImageDriverDependencies,
  baseFetch: typeof globalThis.fetch,
  now: () => Date,
): Promise<ProbeReceipt> {
  const startedAt = now().toISOString();
  const fetch = dependencies.resolveFetch?.(input.provider.connection.proxyId, baseFetch) ?? baseFetch;
  const observer = createAttemptFetchObserver(fetch);
  const options = providerOptionsSchema.parse(input.provider.driverOptions);
  const client = createClient({
    baseUrl: trimTrailingSlash(input.provider.connection.baseUrl),
    auth: input.provider.connection.auth,
    headers: input.provider.connection.headers,
    sdkTimeoutMs: options.sdkTimeoutMs,
  }, observer.fetch);
  try {
    await client.models.list({ signal: input.signal });
    return {
      driverId: DRIVER_ID,
      providerId: input.providerId,
      level: 'connectivity',
      success: true,
      startedAt,
      completedAt: now().toISOString(),
    };
  } catch (cause) {
    const error = sdkError(cause, observer.failure(), {
      providerId: input.providerId,
      modelId: 'connectivity',
    }, { attempt: 1, traceId: `probe:${input.providerId}` } as AttemptContext);
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

function sdkError(
  cause: unknown,
  observation: FetchFailureObservation | undefined,
  target: { providerId: string; modelId: string },
  context: Pick<AttemptContext, 'attempt' | 'traceId'>,
): ImageSubmissionError {
  const sdk = cause as { status?: unknown; message?: unknown; error?: unknown; request_id?: unknown };
  const status = observation?.kind === 'http'
    ? observation.status
    : typeof sdk.status === 'number' ? sdk.status : undefined;
  const body = observation?.kind === 'http' ? observation.body : sdk.error;
  const message = upstreamMessage(body) ?? (typeof sdk.message === 'string' ? sdk.message : String(cause));
  const providerFailure = status !== undefined;
  return new ImageSubmissionError({
    source: providerFailure ? 'provider' : 'transport',
    gateway: 'image',
    providerId: target.providerId,
    modelId: target.modelId,
    driverId: DRIVER_ID,
    stage: 'request',
    attempt: context.attempt,
    traceId: context.traceId,
    message,
    ...(providerFailure && {
      upstream: {
        status,
        message,
        requestId: observation?.kind === 'http'
          ? observation.requestId
          : typeof sdk.request_id === 'string' ? sdk.request_id : undefined,
        body,
      },
    }),
  }, providerFailure ? 'rejected' : 'unknown', providerFailure && retryableStatus(status), { cause });
}

function zodIssues(result: z.ZodSafeParseResult<unknown>): readonly DriverValidationIssue[] {
  if (result.success) return [];
  return result.error.issues.map((issue) => ({
    path: issue.path.length ? `/${issue.path.map(String).join('/')}` : '',
    code: 'OPENROUTER_IMAGE_OPTIONS_INVALID',
    message: issue.message,
  }));
}

function upstreamMessage(body: unknown): string | undefined {
  if (typeof body === 'string') return body;
  if (!isRecord(body)) return undefined;
  if (typeof body.message === 'string') return body.message;
  if (isRecord(body.error) && typeof body.error.message === 'string') return body.error.message;
  return undefined;
}

function retryableStatus(status: number | undefined): boolean {
  return status !== undefined && ([408, 409, 425, 429].includes(status) || status >= 500);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
