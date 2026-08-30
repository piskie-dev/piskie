import OpenAI from 'openai';
import { z } from 'zod';
import { DEFAULT_OPENAI_WIRE_API } from '../../../../shared/types/inference.js';
import type { AiAttemptEvent, AiRequest } from '../../ai/contracts.js';
import type { ArtifactReader, ArtifactStore } from '../../execution/artifact-port.js';
import { GatewayCallError, isGatewayCallError, localCallError } from '../../execution/call-error.js';
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
import { projectOpenAiChatStream } from './event-projector.js';
import { mapOpenAiImageRequest } from './image-mapper.js';
import { projectOpenAiImagesResponse } from './image-projector.js';
import {
  mapOpenAiChatRequest,
  OpenAiSerializationError,
  type OpenAiModelOptions,
} from './request-mapper.js';
import {
  OpenAiResponsesStreamError,
  projectOpenAiResponsesStream,
} from './responses-event-projector.js';
import { mapOpenAiResponsesRequest } from './responses-request-mapper.js';

const wireApiSchema = z.union([
  z.literal('responses').meta({
    title: 'Responses',
    description: 'Preferred for Agent tools, reasoning, and current OpenAI models.',
  }),
  z.literal('chat_completions').meta({
    title: 'Chat Completions',
    description: 'Use for compatibility endpoints that do not implement the Responses API.',
  }),
])
  .default(DEFAULT_OPENAI_WIRE_API)
  .describe('Wire protocol shared by every AI model on this Provider.')
  .meta({
    'x-piskie': {
      scope: 'provider',
      changeImpact: 'Affects every AI model under this Provider.',
      applyMode: 'next-request',
      recommendedProbe: 'smoke',
      billableProbe: true,
    },
  });

const providerOptionsSchema = z.object({
  wireApi: wireApiSchema,
  organization: z.string().trim().min(1).optional()
    .describe('Optional OpenAI organization header value applied to Provider requests.'),
  project: z.string().trim().min(1).optional()
    .describe('Optional OpenAI project header value applied to Provider requests.'),
  sdkTimeoutMs: z.number().int().positive().default(600_000)
    .describe('Maximum milliseconds allowed for one OpenAI SDK request attempt.'),
}).strip();

const modelOptionsSchema = z.object({
  maxTokensField: z.enum(['max_completion_tokens', 'max_tokens'])
    .default('max_completion_tokens')
    .describe('OpenAI request field used to carry the configured maximum output token count.'),
  assistantReasoningReplay: z.enum(['omit', 'as_text', 'reasoning_content'])
    .default('omit')
    .describe('How prior assistant reasoning is represented when replaying conversation history.'),
  imageResponseFormat: z.enum(['omit', 'b64_json', 'url'])
    .default('omit')
    .describe('Optional response_format value sent to OpenAI-compatible image APIs.'),
}).strip();

export interface OpenAiDriverDependencies {
  fetch?: typeof globalThis.fetch;
  resolveFetch?: (proxyId: string | null, fallback: typeof globalThis.fetch) => typeof globalThis.fetch;
  artifacts?: ArtifactReader;
  imageArtifacts?: ArtifactStore;
  now?: () => Date;
}

export function createOpenAiDriver(dependencies: OpenAiDriverDependencies = {}): InferenceDriver {
  const baseFetch = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? (() => new Date());

  return {
    manifest: {
      id: 'openai',
      supportedGateways: ['ai', 'image'],
      acceptedAuth: ['none', 'bearer', 'api_key', 'basic'],
      providerConfigSchema: z.toJSONSchema(providerOptionsSchema) as Record<string, unknown>,
      modelOptionsSchema: z.toJSONSchema(modelOptionsSchema) as Record<string, unknown>,
    },
    validateProviderOptions: (options) => zodIssues(providerOptionsSchema.safeParse(options)),
    validateModelOptions: (options) => zodIssues(modelOptionsSchema.safeParse(options)),
    compile: (input) => compileTarget(
      input,
      dependencies.artifacts,
      dependencies.imageArtifacts,
      baseFetch,
      dependencies.resolveFetch,
    ),
    probeConnectivity: (input) => probeConnectivity(
      input,
      resolveFetch(input, baseFetch, dependencies.resolveFetch),
      now,
    ),
  };
}

function compileTarget(
  input: DriverCompileInput,
  artifacts: ArtifactReader | undefined,
  imageArtifacts: ArtifactStore | undefined,
  baseFetch: typeof globalThis.fetch,
  fetchResolver: OpenAiDriverDependencies['resolveFetch'],
) {
  const providerOptions = providerOptionsSchema.parse(input.provider.driverOptions);
  const modelOptions = {
    ...modelOptionsSchema.parse(input.binding.options),
    wireApi: providerOptions.wireApi,
    reasoningProfile: input.catalogModel.reasoning,
  };
  const compiledConnection = {
    baseUrl: trimTrailingSlash(input.provider.connection.baseUrl),
    auth: structuredClone(input.provider.connection.auth),
    headers: { ...input.provider.connection.headers },
    organization: providerOptions.organization,
    project: providerOptions.project,
    sdkTimeoutMs: providerOptions.sdkTimeoutMs,
  };
  const target = { providerId: input.providerId, modelId: input.modelId };
  const providerFetch = resolveFetch(input, baseFetch, fetchResolver);

  const base = {
    ref: target,
    driverId: 'openai',
    upstreamModel: input.binding.upstreamId,
    catalogId: input.binding.catalogId,
    configRevision: input.configRevision,
  };
  if (input.catalogModel.kind === 'ai') {
    return {
      ...base,
      ai: {
      openAttempt: (request: AiRequest, context: AttemptContext): AsyncIterable<AiAttemptEvent> => openAiAttempt({
        request,
        context,
        target,
        upstreamModel: input.binding.upstreamId,
        modelOptions,
        connection: compiledConnection,
        artifacts,
        baseFetch: providerFetch,
      }),
      },
    };
  }
  if (!imageArtifacts) {
    throw new Error('OpenAI Images targets require an output Artifact Store');
  }
  return {
    ...base,
    image: {
      mode: 'synchronous' as const,
      submit: (request: ImageRequest, context: AttemptContext): AsyncIterable<ImageAttemptEvent> => openAiImageAttempt({
        request,
        context,
        target,
        upstreamModel: input.binding.upstreamId,
        modelOptions,
        connection: compiledConnection,
        artifacts,
        imageArtifacts,
        baseFetch: providerFetch,
      }),
    },
  };
}

function resolveFetch(
  input: Pick<DriverCompileInput, 'provider'> | ProviderConnectivityProbeInput,
  fallback: typeof globalThis.fetch,
  resolver: OpenAiDriverDependencies['resolveFetch'],
): typeof globalThis.fetch {
  return resolver?.(input.provider.connection.proxyId, fallback) ?? fallback;
}

interface OpenAiCompiledConnection {
  baseUrl: string;
  auth: DriverCompileInput['provider']['connection']['auth'];
  headers: Record<string, string>;
  organization?: string;
  project?: string;
  sdkTimeoutMs: number;
}

interface OpenAiAttemptInput {
  request: AiRequest;
  context: AttemptContext;
  target: { providerId: string; modelId: string };
  upstreamModel: string;
  modelOptions: OpenAiModelOptions;
  connection: OpenAiCompiledConnection;
  artifacts?: ArtifactReader;
  baseFetch: typeof globalThis.fetch;
}

async function* openAiAttempt(input: OpenAiAttemptInput): AsyncIterable<AiAttemptEvent> {
  const observer = createAttemptFetchObserver(input.baseFetch);
  const client = createClient(input.connection, observer.fetch);

  try {
    if (input.modelOptions.wireApi === 'responses') {
      const params = await mapOpenAiResponsesRequest(
        input.request,
        input.upstreamModel,
        input.modelOptions,
        input.artifacts,
      );
      const stream = await client.responses.create(params, { signal: input.context.signal });
      yield* projectOpenAiResponsesStream(stream);
    } else {
      const params = await mapOpenAiChatRequest(
        input.request,
        input.upstreamModel,
        input.modelOptions,
        input.artifacts,
      );
      const stream = await client.chat.completions.create(params, { signal: input.context.signal });
      yield* projectOpenAiChatStream(stream);
    }
  } catch (cause) {
    if (cause instanceof OpenAiSerializationError) {
      throw localCallError({
        gateway: 'ai',
        target: input.target,
        driverId: 'openai',
        stage: 'serialize',
        attempt: input.context.attempt,
        traceId: input.context.traceId,
        localCode: cause.code,
        message: cause.message,
        cause,
      });
    }
    throw openAiCallError(cause, observer.failure(), input);
  }
}

interface OpenAiImageAttemptInput {
  request: ImageRequest;
  context: AttemptContext;
  target: { providerId: string; modelId: string };
  upstreamModel: string;
  modelOptions: z.infer<typeof modelOptionsSchema>;
  connection: OpenAiCompiledConnection;
  artifacts?: ArtifactReader;
  imageArtifacts: ArtifactStore;
  baseFetch: typeof globalThis.fetch;
}

async function* openAiImageAttempt(input: OpenAiImageAttemptInput): AsyncIterable<ImageAttemptEvent> {
  let mapped: Awaited<ReturnType<typeof mapOpenAiImageRequest>>;
  try {
    mapped = await mapOpenAiImageRequest(
      input.request,
      input.upstreamModel,
      input.modelOptions,
      input.artifacts,
      input.context.signal,
    );
  } catch (cause) {
    const serialization = cause instanceof OpenAiSerializationError;
    throw new ImageSubmissionError({
      source: 'local',
      gateway: 'image',
      providerId: input.target.providerId,
      modelId: input.target.modelId,
      driverId: 'openai',
      stage: 'serialize',
      attempt: input.context.attempt,
      traceId: input.context.traceId,
      message: cause instanceof Error ? cause.message : String(cause),
      localCode: serialization ? cause.code : errorCode(cause, 'OPENAI_IMAGE_INPUT_READ_FAILED'),
    }, 'not_accepted', false, { cause });
  }

  const observer = createAttemptFetchObserver(input.baseFetch);
  const client = createClient(input.connection, observer.fetch);
  try {
    const response = mapped.kind === 'generate'
      ? await client.images.generate(mapped.params, { signal: input.context.signal })
      : await client.images.edit(mapped.params, { signal: input.context.signal });
    yield* projectOpenAiImagesResponse({
      response,
      request: input.request,
      target: input.target,
      context: input.context,
      artifacts: input.imageArtifacts,
      fetch: input.baseFetch,
    });
  } catch (cause) {
    if (isGatewayCallError(cause)) throw cause;
    const observation = observer.failure();
    if (!observation && errorCode(cause, '').startsWith('ARTIFACT_')) {
      throw localCallError({
        gateway: 'image',
        target: input.target,
        driverId: 'openai',
        stage: 'artifact_store',
        attempt: input.context.attempt,
        traceId: input.context.traceId,
        localCode: errorCode(cause, 'OPENAI_IMAGE_ARTIFACT_WRITE_FAILED'),
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });
    }
    throw openAiImageCallError(cause, observation, input);
  }
}

async function probeConnectivity(
  input: ProviderConnectivityProbeInput,
  baseFetch: typeof globalThis.fetch,
  now: () => Date,
): Promise<ProbeReceipt> {
  const startedAt = now().toISOString();
  const observer = createAttemptFetchObserver(baseFetch);
  const options = providerOptionsSchema.parse(input.provider.driverOptions);
  const client = createClient({
    baseUrl: trimTrailingSlash(input.provider.connection.baseUrl),
    auth: input.provider.connection.auth,
    headers: input.provider.connection.headers,
    organization: options.organization,
    project: options.project,
    sdkTimeoutMs: options.sdkTimeoutMs,
  }, observer.fetch);

  try {
    await client.models.list({ signal: input.signal });
    const failure = observer.failure();
    return {
      driverId: 'openai',
      providerId: input.providerId,
      level: 'connectivity',
      success: true,
      startedAt,
      completedAt: now().toISOString(),
      ...(failure?.kind === 'http' && { status: failure.status, requestId: failure.requestId }),
    };
  } catch (cause) {
    const error = openAiCallError(cause, observer.failure(), {
      target: { providerId: input.providerId, modelId: 'connectivity' },
      context: { attempt: 1, traceId: `probe:${input.providerId}` },
    });
    return {
      driverId: 'openai',
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

function openAiImageCallError(
  cause: unknown,
  observation: FetchFailureObservation | undefined,
  input: Pick<OpenAiImageAttemptInput, 'target'> & {
    context: Pick<AttemptContext, 'attempt' | 'traceId'>;
  },
): ImageSubmissionError {
  const sdk = cause as {
    status?: unknown;
    code?: unknown;
    type?: unknown;
    message?: unknown;
    request_id?: unknown;
    error?: unknown;
  };
  const status = observation?.kind === 'http'
    ? observation.status
    : typeof sdk.status === 'number' ? sdk.status : undefined;
  const body = observation?.kind === 'http' ? observation.body : sdk.error;
  const message = upstreamMessage(body)
    ?? (typeof sdk.message === 'string' ? sdk.message : String(cause));
  const source = observation?.kind === 'transport' || status === undefined ? 'transport' : 'provider';
  const rejected = source === 'provider';

  return new ImageSubmissionError({
    source,
    gateway: 'image',
    providerId: input.target.providerId,
    modelId: input.target.modelId,
    driverId: 'openai',
    stage: 'request',
    attempt: input.context.attempt,
    traceId: input.context.traceId,
    message,
    ...(rejected && {
      upstream: {
        status,
        ...(typeof sdk.code === 'string' && { code: sdk.code }),
        ...(typeof sdk.type === 'string' && { type: sdk.type }),
        message,
        requestId: observation?.kind === 'http'
          ? observation.requestId
          : typeof sdk.request_id === 'string' ? sdk.request_id : undefined,
        body,
      },
    }),
  }, rejected ? 'rejected' : 'unknown', rejected && isRetryableImageStatus(status), { cause });
}

function createClient(connection: OpenAiCompiledConnection, nextFetch: typeof globalThis.fetch): OpenAI {
  return new OpenAI({
    apiKey: bearerValue(connection.auth) ?? 'piskie-no-bearer-auth',
    baseURL: connection.baseUrl,
    organization: connection.organization,
    project: connection.project,
    timeout: connection.sdkTimeoutMs,
    maxRetries: 0,
    fetch: configuredFetch(nextFetch, connection.auth, connection.headers),
  });
}

function isRetryableImageStatus(status: number | undefined): boolean {
  return status !== undefined && ([408, 409, 425, 429].includes(status) || status >= 500);
}

function errorCode(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return fallback;
}

function openAiCallError(
  cause: unknown,
  observation: FetchFailureObservation | undefined,
  input: Pick<OpenAiAttemptInput, 'target'> & { context: Pick<AttemptContext, 'attempt' | 'traceId'> },
): GatewayCallError {
  const streamError = cause instanceof OpenAiResponsesStreamError ? cause : undefined;
  const sdk = cause as {
    status?: unknown;
    code?: unknown;
    type?: unknown;
    param?: unknown;
    message?: unknown;
    requestID?: unknown;
    request_id?: unknown;
    error?: unknown;
  };
  // The SDK turns a top-level SSE `error` payload into APIError before either
  // Responses or Chat Completions projectors see it. That remains a provider
  // failure even though an already-open HTTP 200 stream has no error status.
  const sdkProviderError = cause instanceof OpenAI.APIError
    && !(cause instanceof OpenAI.APIConnectionError)
    && sdk.error !== undefined;
  const status = observation?.kind === 'http'
    ? observation.status
    : typeof sdk.status === 'number' ? sdk.status : undefined;
  const body = observation?.kind === 'http'
    ? observation.body
    : streamError?.body ?? sdk.error;
  const message = upstreamMessage(body)
    ?? (typeof sdk.message === 'string' ? sdk.message : String(cause));
  const source = observation?.kind === 'transport' || cause instanceof OpenAI.APIConnectionError
    ? 'transport'
    : observation?.kind === 'http' || streamError || sdkProviderError || status !== undefined
      ? 'provider'
      : 'transport';
  const code = streamError?.code ?? stringValue(sdk.code);
  const type = streamError?.eventType ?? stringValue(sdk.type);
  const param = streamError?.param ?? stringValue(sdk.param);
  const requestId = observation?.kind === 'http'
    ? observation.requestId
    : stringValue(sdk.requestID) ?? stringValue(sdk.request_id);

  return new GatewayCallError({
    source,
    gateway: 'ai',
    providerId: input.target.providerId,
    modelId: input.target.modelId,
    driverId: 'openai',
    stage: 'request',
    attempt: input.context.attempt,
    traceId: input.context.traceId,
    message,
    ...(source === 'provider' && {
      upstream: {
        status,
        ...(code && { code }),
        ...(type && { type }),
        ...(param && { param }),
        message,
        requestId,
        body,
      },
    }),
  }, { cause });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function configuredFetch(
  next: typeof globalThis.fetch,
  auth: DriverCompileInput['provider']['connection']['auth'],
  configuredHeaders: Readonly<Record<string, string>>,
): typeof globalThis.fetch {
  return async (request, init) => {
    const headers = new Headers(init?.headers ?? (request instanceof Request ? request.headers : undefined));
    headers.delete('authorization');
    if (auth.kind === 'bearer') headers.set('authorization', `Bearer ${auth.value}`);
    if (auth.kind === 'api_key') headers.set(auth.header, auth.value);
    if (auth.kind === 'basic') {
      headers.set('authorization', `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`);
    }
    for (const [name, value] of Object.entries(configuredHeaders)) headers.set(name, value);
    return next(request, { ...init, headers });
  };
}

function bearerValue(auth: DriverCompileInput['provider']['connection']['auth']): string | undefined {
  return auth.kind === 'bearer' ? auth.value : undefined;
}

function upstreamMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record.message === 'string') return record.message;
  if (record.error && typeof record.error === 'object') {
    const nested = record.error as Record<string, unknown>;
    if (typeof nested.message === 'string') return nested.message;
  }
  if (typeof record.detail === 'string') return record.detail;
  return undefined;
}

function zodIssues(result: z.ZodSafeParseResult<unknown>): readonly DriverValidationIssue[] {
  if (result.success) return [];
  return result.error.issues.map((issue) => ({
    path: issue.path.length ? `/${issue.path.map(String).join('/')}` : '',
    code: 'OPENAI_OPTIONS_INVALID',
    message: issue.message,
  }));
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
