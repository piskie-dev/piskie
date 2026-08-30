import { z } from 'zod';
import type { ArtifactReader, ArtifactStore } from '../../execution/artifact-port.js';
import { isGatewayCallError, localCallError } from '../../execution/call-error.js';
import type { AttemptContext } from '../../execution/contracts.js';
import type { ImageRequest } from '../../image/contracts.js';
import type { ImageAttemptEvent } from '../../image/driver-port.js';
import type {
  DriverCompileInput,
  DriverValidationIssue,
  InferenceDriver,
  ProbeReceipt,
  ProviderConnectivityProbeInput,
} from '../contracts.js';
import {
  configuredHeaders,
  requestJson,
  storeImagePayload,
  type ImagePayloadSource,
} from '../image-http-support.js';

const DRIVER_ID = 'gemini-image';
const providerOptionsSchema = z.object({}).strip();
const modelOptionsSchema = z.object({}).strip();

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
  inline_data?: { mime_type?: string; data?: string };
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
}

export interface GeminiImageDriverDependencies {
  fetch?: typeof globalThis.fetch;
  resolveFetch?: (proxyId: string | null, fallback: typeof globalThis.fetch) => typeof globalThis.fetch;
  artifacts?: ArtifactReader;
  imageArtifacts?: ArtifactStore;
  now?: () => Date;
}

export function createGeminiImageDriver(
  dependencies: GeminiImageDriverDependencies = {},
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
  dependencies: GeminiImageDriverDependencies,
  baseFetch: typeof globalThis.fetch,
) {
  if (input.catalogModel.kind !== 'image') throw new Error('Gemini image Driver requires an Image model');
  if (!dependencies.imageArtifacts) throw new Error('Gemini image Driver requires an Artifact Store');
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
  compiled: {
    target: { providerId: string; modelId: string };
    upstreamModel: string;
    baseUrl: string;
    auth: DriverCompileInput['provider']['connection']['auth'];
    headers: Record<string, string>;
    artifacts?: ArtifactReader;
    imageArtifacts: ArtifactStore;
    fetch: typeof globalThis.fetch;
  },
  request: ImageRequest,
  context: AttemptContext,
): AsyncIterable<ImageAttemptEvent> {
  const parts: Array<Record<string, unknown>> = [];
  try {
    if (request.operation.kind === 'edit') {
      if (!compiled.artifacts) throw new Error('Gemini image edits require an Artifact Reader');
      for (const source of request.operation.sources) {
        const payload = await compiled.artifacts.read(source, context.signal);
        parts.push({
          inlineData: {
            mimeType: payload.mimeType,
            data: Buffer.from(payload.bytes).toString('base64'),
          },
        });
      }
      if (request.operation.mask) {
        const mask = await compiled.artifacts.read(request.operation.mask, context.signal);
        parts.push({
          inlineData: {
            mimeType: mask.mimeType,
            data: Buffer.from(mask.bytes).toString('base64'),
          },
        });
      }
    }
    parts.push({ text: request.operation.prompt });
  } catch (cause) {
    throw localCallError({
      gateway: 'image',
      target: compiled.target,
      driverId: DRIVER_ID,
      stage: 'serialize',
      attempt: context.attempt,
      traceId: context.traceId,
      localCode: 'GEMINI_IMAGE_SERIALIZATION_FAILED',
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  }

  const aspectRatio = outputAspectRatio(request);
  const callContext = { driverId: DRIVER_ID, target: compiled.target, attempt: context, stage: 'request' };
  try {
    const response = await requestJson<GeminiResponse>(
      compiled.fetch,
      modelUrl(compiled.baseUrl, compiled.upstreamModel),
      {
        method: 'POST',
        headers: configuredHeaders(compiled.auth, compiled.headers, { 'content-type': 'application/json' }),
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            ...(aspectRatio && { imageConfig: { aspectRatio } }),
          },
        }),
        signal: context.signal,
      },
      callContext,
      true,
    );
    const payloads = geminiPayloads(response);
    if (payloads.length === 0) {
      throw localCallError({
        gateway: 'image',
        target: compiled.target,
        driverId: DRIVER_ID,
        stage: 'response',
        attempt: context.attempt,
        traceId: context.traceId,
        localCode: 'GEMINI_IMAGE_RESPONSE_EMPTY',
        message: 'Gemini response did not contain an image',
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
          fileNamePrefix: 'gemini-image',
        }),
      };
    }
    yield { kind: 'completed', usage: { imageCount: payloads.length } };
  } catch (cause) {
    if (isGatewayCallError(cause)) throw cause;
    throw cause;
  }
}

function geminiPayloads(response: GeminiResponse): ImagePayloadSource[] {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const revisedPrompt = parts.map((part) => part.text ?? '').join('').trim() || undefined;
  return parts.flatMap((part): ImagePayloadSource[] => {
    const data = part.inlineData?.data ?? part.inline_data?.data;
    if (!data) return [];
    return [{
      base64: data,
      mimeType: part.inlineData?.mimeType ?? part.inline_data?.mime_type ?? 'image/png',
      ...(revisedPrompt && { revisedPrompt }),
    }];
  });
}

async function probeConnectivity(
  input: ProviderConnectivityProbeInput,
  dependencies: GeminiImageDriverDependencies,
  baseFetch: typeof globalThis.fetch,
  now: () => Date,
): Promise<ProbeReceipt> {
  const startedAt = now().toISOString();
  const fetch = dependencies.resolveFetch?.(input.provider.connection.proxyId, baseFetch) ?? baseFetch;
  const context = probeAttempt(input);
  try {
    await requestJson(
      fetch,
      modelsUrl(trimTrailingSlash(input.provider.connection.baseUrl)),
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
      localCode: 'GEMINI_CONNECTIVITY_FAILED',
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

function modelUrl(baseUrl: string, model: string): string {
  const prefix = /\/v1beta$/i.test(baseUrl) ? baseUrl : `${baseUrl}/v1beta`;
  return `${prefix}/models/${encodeURIComponent(model)}:generateContent`;
}

function modelsUrl(baseUrl: string): string {
  const prefix = /\/v1beta$/i.test(baseUrl) ? baseUrl : `${baseUrl}/v1beta`;
  return `${prefix}/models?pageSize=1`;
}

function outputAspectRatio(request: ImageRequest): string | undefined {
  const output = request.operation.output;
  if (output?.aspectRatio) return output.aspectRatio;
  if (output?.width === undefined || output.height === undefined) return undefined;
  return `${output.width}:${output.height}`;
}

function zodIssues(result: z.ZodSafeParseResult<unknown>): readonly DriverValidationIssue[] {
  if (result.success) return [];
  return result.error.issues.map((issue) => ({
    path: issue.path.length ? `/${issue.path.map(String).join('/')}` : '',
    code: 'GEMINI_IMAGE_OPTIONS_INVALID',
    message: issue.message,
  }));
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
