import type OpenAI from 'openai';
import type { ArtifactStore } from '../../execution/artifact-port.js';
import { GatewayCallError, localCallError } from '../../execution/call-error.js';
import type { AttemptContext, ModelTarget } from '../../execution/contracts.js';
import { toImageArtifact } from '../../image/artifact-store.js';
import type { ImageRequest, ImageUsage } from '../../image/contracts.js';
import type { ImageAttemptEvent } from '../../image/driver-port.js';

interface ProjectOpenAiImagesInput {
  response: OpenAI.Images.ImagesResponse;
  request: ImageRequest;
  target: ModelTarget;
  context: AttemptContext;
  artifacts: ArtifactStore;
  fetch: typeof globalThis.fetch;
}

export async function* projectOpenAiImagesResponse(
  input: ProjectOpenAiImagesInput,
): AsyncIterable<ImageAttemptEvent> {
  const images = input.response.data ?? [];
  if (images.length === 0) {
    throw localCallError({
      gateway: 'image',
      target: input.target,
      driverId: 'openai',
      stage: 'response',
      attempt: input.context.attempt,
      traceId: input.context.traceId,
      localCode: 'OPENAI_IMAGE_RESPONSE_EMPTY',
      message: 'OpenAI Images response did not contain any images',
    });
  }

  for (const [index, image] of images.entries()) {
    const payload = image.b64_json
      ? {
          bytes: decodeBase64(image.b64_json, input, index),
          mimeType: responseMime(input.response.output_format ?? input.request.operation.output?.format),
        }
      : image.url
        ? await downloadImage(image.url, input)
        : undefined;
    if (!payload) {
      throw localCallError({
        gateway: 'image',
        target: input.target,
        driverId: 'openai',
        stage: 'response',
        attempt: input.context.attempt,
        traceId: input.context.traceId,
        localCode: 'OPENAI_IMAGE_DATA_INVALID',
        message: `OpenAI Images item ${index} has neither b64_json nor url`,
      });
    }
    const dimensions = responseDimensions(input.response.size, input.request);
    const stored = await input.artifacts.write({
      ...payload,
      fileName: `openai-image-${index}.${extensionForMime(payload.mimeType)}`,
      metadata: {
        ...dimensions,
        ...(image.revised_prompt && { revisedPrompt: image.revised_prompt }),
      },
    }, input.context.signal);
    yield { kind: 'artifact', artifact: toImageArtifact(stored) };
  }
  yield {
    kind: 'completed',
    usage: mapUsage(input.response.usage, images.length),
  };
}

async function downloadImage(
  url: string,
  input: ProjectOpenAiImagesInput,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  let response: Response;
  try {
    response = await input.fetch(url, { signal: input.context.signal });
  } catch (cause) {
    throw new GatewayCallError({
      source: 'transport',
      gateway: 'image',
      providerId: input.target.providerId,
      modelId: input.target.modelId,
      driverId: 'openai',
      stage: 'artifact_download',
      attempt: input.context.attempt,
      traceId: input.context.traceId,
      message: cause instanceof Error ? cause.message : String(cause),
    }, { cause });
  }
  if (!response.ok) {
    const body = await readResponseBody(response);
    const message = upstreamMessage(body) ?? `Image download failed with HTTP ${response.status}`;
    throw new GatewayCallError({
      source: 'provider',
      gateway: 'image',
      providerId: input.target.providerId,
      modelId: input.target.modelId,
      driverId: 'openai',
      stage: 'artifact_download',
      attempt: input.context.attempt,
      traceId: input.context.traceId,
      message,
      upstream: {
        status: response.status,
        message,
        requestId: response.headers.get('x-request-id') ?? undefined,
        body,
      },
    });
  }
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    mimeType: response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream',
  };
}

function decodeBase64(value: string, input: ProjectOpenAiImagesInput, index: number): Uint8Array {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.byteLength === 0) {
    throw localCallError({
      gateway: 'image',
      target: input.target,
      driverId: 'openai',
      stage: 'response',
      attempt: input.context.attempt,
      traceId: input.context.traceId,
      localCode: 'OPENAI_IMAGE_BASE64_EMPTY',
      message: `OpenAI Images item ${index} contains empty base64 data`,
    });
  }
  return bytes;
}

function mapUsage(usage: OpenAI.Images.ImagesResponse['usage'], imageCount: number): ImageUsage {
  return {
    imageCount,
    ...(typeof usage?.total_tokens === 'number' && { providerUnits: usage.total_tokens }),
  };
}

function responseDimensions(
  responseSize: string | undefined,
  request: ImageRequest,
): { width?: number; height?: number } {
  const parsed = responseSize && /^(\d+)x(\d+)$/.exec(responseSize);
  if (parsed) return { width: Number(parsed[1]), height: Number(parsed[2]) };
  const output = request.operation.output;
  return {
    ...(output?.width !== undefined && { width: output.width }),
    ...(output?.height !== undefined && { height: output.height }),
  };
}

function responseMime(format: string | undefined): string {
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'webp') return 'image/webp';
  return 'image/png';
}

function extensionForMime(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  return 'png';
}

async function readResponseBody(response: Response): Promise<unknown> {
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
  if (!body || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record.message === 'string') return record.message;
  if (record.error && typeof record.error === 'object') {
    const nested = record.error as Record<string, unknown>;
    if (typeof nested.message === 'string') return nested.message;
  }
  return undefined;
}
