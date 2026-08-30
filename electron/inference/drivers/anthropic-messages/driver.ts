import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { AiAttemptEvent, AiRequest } from '../../ai/contracts.js';
import type { ArtifactReader } from '../../execution/artifact-port.js';
import { GatewayCallError, localCallError } from '../../execution/call-error.js';
import type { AttemptContext } from '../../execution/contracts.js';
import { createAttemptFetchObserver, type FetchFailureObservation } from '../../execution/observed-fetch.js';
import type {
  DriverCompileInput,
  DriverValidationIssue,
  InferenceDriver,
  ProbeReceipt,
  ProviderConnectivityProbeInput,
} from '../contracts.js';
import { projectAnthropicMessagesStream } from './event-projector.js';
import {
  AnthropicSerializationError,
  mapAnthropicMessagesRequest,
  type AnthropicModelOptions,
} from './request-mapper.js';

const DRIVER_ID = 'anthropic-messages';

const providerOptionsSchema = z.object({
  sdkTimeoutMs: z.number().int().positive().default(600_000)
    .describe('Maximum milliseconds allowed for one Anthropic SDK request attempt.'),
}).strip();

const modelOptionsSchema = z.object({
  assistantReasoningReplay: z.enum(['omit', 'as_text']).default('omit')
    .describe('How prior assistant reasoning is represented when replaying conversation history.'),
  promptCaching: z.boolean().default(true).describe(
    'Defaults to true for every model using the Anthropic Messages protocol, including compatible endpoints; '
    + 'set false only when an endpoint does not accept Anthropic cache_control. '
    + 'Enabled requests use the 5-minute ephemeral policy for stable tools/system and growing conversation history.',
  ),
}).strip();

export interface AnthropicMessagesDriverDependencies {
  fetch?: typeof globalThis.fetch;
  resolveFetch?: (proxyId: string | null, fallback: typeof globalThis.fetch) => typeof globalThis.fetch;
  artifacts?: ArtifactReader;
  now?: () => Date;
}

export function createAnthropicMessagesDriver(
  dependencies: AnthropicMessagesDriverDependencies = {},
): InferenceDriver {
  const baseFetch = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? (() => new Date());

  return {
    manifest: {
      id: DRIVER_ID,
      supportedGateways: ['ai'],
      acceptedAuth: ['none', 'bearer', 'api_key', 'basic'],
      providerConfigSchema: z.toJSONSchema(providerOptionsSchema) as Record<string, unknown>,
      modelOptionsSchema: z.toJSONSchema(modelOptionsSchema, { io: 'input' }) as Record<string, unknown>,
    },
    validateProviderOptions: (options) => zodIssues(providerOptionsSchema.safeParse(options)),
    validateModelOptions: (options) => zodIssues(modelOptionsSchema.safeParse(options)),
    compile: (input) => compileTarget(
      input,
      dependencies.artifacts,
      resolveFetch(input.provider.connection.proxyId, baseFetch, dependencies.resolveFetch),
    ),
    probeConnectivity: (input) => probeConnectivity(
      input,
      resolveFetch(input.provider.connection.proxyId, baseFetch, dependencies.resolveFetch),
      now,
    ),
  };
}

function resolveFetch(
  proxyId: string | null,
  fallback: typeof globalThis.fetch,
  resolver: AnthropicMessagesDriverDependencies['resolveFetch'],
): typeof globalThis.fetch {
  return resolver?.(proxyId, fallback) ?? fallback;
}

function compileTarget(
  input: DriverCompileInput,
  artifacts: ArtifactReader | undefined,
  baseFetch: typeof globalThis.fetch,
) {
  if (input.catalogModel.kind !== 'ai') {
    throw new Error(`Anthropic Messages driver cannot compile catalog kind ${input.catalogModel.kind}`);
  }
  const providerOptions = providerOptionsSchema.parse(input.provider.driverOptions);
  const parsedModelOptions = modelOptionsSchema.parse(input.binding.options);
  const modelOptions: AnthropicModelOptions = {
    ...parsedModelOptions,
    reasoningProfile: input.catalogModel.reasoning,
  };
  const connection = {
    baseUrl: trimTrailingSlash(input.provider.connection.baseUrl),
    auth: structuredClone(input.provider.connection.auth),
    headers: { ...input.provider.connection.headers },
    sdkTimeoutMs: providerOptions.sdkTimeoutMs,
  };
  const target = { providerId: input.providerId, modelId: input.modelId };

  return {
    ref: target,
    driverId: DRIVER_ID,
    upstreamModel: input.binding.upstreamId,
    catalogId: input.binding.catalogId,
    configRevision: input.configRevision,
    ai: {
      openAttempt: (request: AiRequest, context: AttemptContext): AsyncIterable<AiAttemptEvent> =>
        anthropicAttempt({
          request,
          context,
          target,
          upstreamModel: input.binding.upstreamId,
          modelOptions,
          connection,
          artifacts,
          baseFetch,
        }),
      countInputTokens: (request: AiRequest, signal?: AbortSignal): Promise<number> =>
        anthropicCountInputTokens({
          request,
          upstreamModel: input.binding.upstreamId,
          modelOptions,
          connection,
          artifacts,
          baseFetch,
          signal,
        }),
    },
  };
}

interface AnthropicAttemptInput {
  request: AiRequest;
  context: AttemptContext;
  target: { providerId: string; modelId: string };
  upstreamModel: string;
  modelOptions: AnthropicModelOptions;
  connection: CompiledConnection;
  artifacts?: ArtifactReader;
  baseFetch: typeof globalThis.fetch;
}

interface CompiledConnection {
  baseUrl: string;
  auth: DriverCompileInput['provider']['connection']['auth'];
  headers: Record<string, string>;
  sdkTimeoutMs: number;
}

async function* anthropicAttempt(input: AnthropicAttemptInput): AsyncIterable<AiAttemptEvent> {
  const observer = createAttemptFetchObserver(input.baseFetch);
  const client = createClient(input.connection, observer.fetch);

  try {
    const params = await mapAnthropicMessagesRequest(
      input.request,
      input.upstreamModel,
      input.modelOptions,
      input.artifacts,
      input.context.signal,
    );
    const stream = await client.messages.create(params, { signal: input.context.signal });
    yield* projectAnthropicMessagesStream(stream);
  } catch (cause) {
    if (cause instanceof AnthropicSerializationError) {
      throw localCallError({
        gateway: 'ai',
        target: input.target,
        driverId: DRIVER_ID,
        stage: 'serialize',
        attempt: input.context.attempt,
        traceId: input.context.traceId,
        localCode: cause.code,
        message: cause.message,
        cause,
      });
    }
    throw anthropicCallError(cause, observer.failure(), input);
  }
}

interface AnthropicCountInput {
  request: AiRequest;
  upstreamModel: string;
  modelOptions: AnthropicModelOptions;
  connection: CompiledConnection;
  artifacts?: ArtifactReader;
  baseFetch: typeof globalThis.fetch;
  signal?: AbortSignal;
}

/**
 * 请求前精确计数（二级准入）。
 *
 * 走的是与真实请求完全相同的映射，因此量的就是即将发出的那份 payload；
 * `count_tokens` 端点不接受 `max_tokens`/`stream`，去掉这两项即可。
 */
async function anthropicCountInputTokens(input: AnthropicCountInput): Promise<number> {
  const client = createClient(input.connection, input.baseFetch);
  const params = await mapAnthropicMessagesRequest(
    input.request,
    input.upstreamModel,
    input.modelOptions,
    input.artifacts,
    input.signal,
  );
  const countable: Partial<typeof params> = { ...params };
  delete countable.max_tokens;
  delete countable.stream;
  const result = await client.messages.countTokens(
    countable as unknown as Anthropic.MessageCountTokensParams,
    { signal: input.signal },
  );
  return result.input_tokens;
}

async function probeConnectivity(
  input: ProviderConnectivityProbeInput,
  baseFetch: typeof globalThis.fetch,
  now: () => Date,
): Promise<ProbeReceipt> {
  const startedAt = now().toISOString();
  const observer = createAttemptFetchObserver(baseFetch);
  const options = providerOptionsSchema.parse(input.provider.driverOptions);
  const connection: CompiledConnection = {
    baseUrl: trimTrailingSlash(input.provider.connection.baseUrl),
    auth: input.provider.connection.auth,
    headers: input.provider.connection.headers,
    sdkTimeoutMs: options.sdkTimeoutMs,
  };
  const client = createClient(connection, observer.fetch);

  try {
    await client.models.list({ limit: 1 }, { signal: input.signal });
    return {
      driverId: DRIVER_ID,
      providerId: input.providerId,
      level: 'connectivity',
      success: true,
      startedAt,
      completedAt: now().toISOString(),
    };
  } catch (cause) {
    const error = anthropicCallError(cause, observer.failure(), {
      target: { providerId: input.providerId, modelId: 'connectivity' },
      context: { attempt: 1, traceId: `probe:${input.providerId}` },
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

function createClient(connection: CompiledConnection, observedFetch: typeof globalThis.fetch): Anthropic {
  return new Anthropic({
    apiKey: 'piskie-attempt-local-key',
    baseURL: connection.baseUrl,
    timeout: connection.sdkTimeoutMs,
    maxRetries: 0,
    fetch: configuredFetch(observedFetch, connection.auth, connection.headers),
  });
}

function anthropicCallError(
  cause: unknown,
  observation: FetchFailureObservation | undefined,
  input: Pick<AnthropicAttemptInput, 'target'> & {
    context: Pick<AttemptContext, 'attempt' | 'traceId'>;
  },
): GatewayCallError {
  const sdk = cause as {
    status?: unknown;
    type?: unknown;
    message?: unknown;
    requestID?: unknown;
    error?: unknown;
  };
  const status = observation?.kind === 'http'
    ? observation.status
    : typeof sdk.status === 'number' ? sdk.status : undefined;
  const body = observation?.kind === 'http' ? observation.body : sdk.error;
  const fields = upstreamFields(body);
  const message = fields.message
    ?? (typeof sdk.message === 'string' ? sdk.message : String(cause));
  const source = observation?.kind === 'transport' || status === undefined ? 'transport' : 'provider';

  return new GatewayCallError({
    source,
    gateway: 'ai',
    providerId: input.target.providerId,
    modelId: input.target.modelId,
    driverId: DRIVER_ID,
    stage: 'request',
    attempt: input.context.attempt,
    traceId: input.context.traceId,
    message,
    ...(source === 'provider' && {
      upstream: {
        status,
        ...(fields.code && { code: fields.code }),
        ...(fields.type ?? (typeof sdk.type === 'string' ? sdk.type : undefined)
          ? { type: fields.type ?? sdk.type as string }
          : {}),
        message,
        requestId: observation?.kind === 'http'
          ? observation.requestId ?? fields.requestId
          : fields.requestId ?? (typeof sdk.requestID === 'string' ? sdk.requestID : undefined),
        body,
      },
    }),
  }, { cause });
}

function configuredFetch(
  next: typeof globalThis.fetch,
  auth: DriverCompileInput['provider']['connection']['auth'],
  configuredHeaders: Readonly<Record<string, string>>,
): typeof globalThis.fetch {
  return async (request, init) => {
    const headers = new Headers(init?.headers ?? (request instanceof Request ? request.headers : undefined));
    headers.delete('authorization');
    headers.delete('x-api-key');
    if (auth.kind === 'bearer') headers.set('authorization', `Bearer ${auth.value}`);
    if (auth.kind === 'api_key') headers.set(auth.header, auth.value);
    if (auth.kind === 'basic') {
      headers.set('authorization', `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`);
    }
    for (const [name, value] of Object.entries(configuredHeaders)) headers.set(name, value);
    return next(request, { ...init, headers });
  };
}

interface UpstreamFields {
  code?: string;
  type?: string;
  message?: string;
  requestId?: string;
}

function upstreamFields(body: unknown): UpstreamFields {
  if (!isRecord(body)) return {};
  const nested = isRecord(body.error) ? body.error : undefined;
  return {
    code: stringField(nested, 'code') ?? stringField(body, 'code'),
    type: stringField(nested, 'type') ?? stringField(body, 'type'),
    message: stringField(nested, 'message') ?? stringField(body, 'message') ?? stringField(body, 'detail'),
    requestId: stringField(body, 'request_id') ?? stringField(body, 'requestId'),
  };
}

function stringField(record: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = record?.[field];
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function zodIssues(
  result: z.ZodSafeParseResult<unknown>,
): readonly DriverValidationIssue[] {
  if (result.success) return [];
  return result.error.issues.map((issue) => ({
    path: issue.path.length ? `/${issue.path.map(String).join('/')}` : '',
    code: 'ANTHROPIC_OPTIONS_INVALID',
    message: issue.message,
  }));
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
