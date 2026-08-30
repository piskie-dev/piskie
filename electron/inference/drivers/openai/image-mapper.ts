import OpenAI, { toFile } from 'openai';
import type { ImageRequest } from '../../image/contracts.js';
import type { ArtifactReader } from '../../execution/artifact-port.js';
import { OpenAiSerializationError } from './request-mapper.js';

export interface OpenAiImageModelOptions {
  imageResponseFormat: 'omit' | 'b64_json' | 'url';
}

const RESERVED_FIELDS = new Set([
  'model',
  'prompt',
  'image',
  'mask',
  'n',
  'size',
  'quality',
  'output_format',
  'background',
  'response_format',
  'stream',
]);

export async function mapOpenAiImageRequest(
  request: ImageRequest,
  upstreamModel: string,
  options: OpenAiImageModelOptions,
  artifacts: ArtifactReader | undefined,
  signal: AbortSignal,
): Promise<
  | { kind: 'generate'; params: OpenAI.Images.ImageGenerateParamsNonStreaming }
  | { kind: 'edit'; params: OpenAI.Images.ImageEditParamsNonStreaming }
> {
  const extension = request.extensions?.openai;
  if (extension !== undefined && !isRecord(extension)) {
    throw new OpenAiSerializationError('OPENAI_IMAGE_EXTENSION_INVALID', 'extensions.openai must be an object');
  }
  if (extension) {
    for (const field of Object.keys(extension)) {
      if (RESERVED_FIELDS.has(field)) {
        throw new OpenAiSerializationError(
          'OPENAI_IMAGE_EXTENSION_RESERVED',
          `extensions.openai cannot replace ${field}`,
        );
      }
    }
  }

  const operation = request.operation;
  const common: Record<string, unknown> = {
    ...extension,
    model: upstreamModel,
    prompt: operation.prompt,
    ...(operation.count !== undefined && { n: operation.count }),
    ...mapOutput(operation.output),
    ...(options.imageResponseFormat !== 'omit' && { response_format: options.imageResponseFormat }),
  };
  if (operation.kind === 'generate') {
    return {
      kind: 'generate',
      params: common as unknown as OpenAI.Images.ImageGenerateParamsNonStreaming,
    };
  }
  if (!artifacts) {
    throw new OpenAiSerializationError(
      'ARTIFACT_READER_MISSING',
      'An artifact reader is required for OpenAI image edits',
    );
  }
  const images = await Promise.all(operation.sources.map(async (ref, index) => {
    const artifact = await artifacts.read(ref, signal);
    return toFile(artifact.bytes, artifact.fileName ?? `source-${index}.${extensionForMime(artifact.mimeType)}`, {
      type: artifact.mimeType,
    });
  }));
  const mask = operation.mask
    ? await artifacts.read(operation.mask, signal).then((artifact) =>
      toFile(artifact.bytes, artifact.fileName ?? `mask.${extensionForMime(artifact.mimeType)}`, {
        type: artifact.mimeType,
      }))
    : undefined;
  return {
    kind: 'edit',
    params: {
      ...common,
      image: images.length === 1 ? images[0]! : images,
      ...(mask && { mask }),
    } as unknown as OpenAI.Images.ImageEditParamsNonStreaming,
  };
}

function mapOutput(output: ImageRequest['operation']['output']): Record<string, unknown> {
  if (!output) return {};
  const size = output.width !== undefined && output.height !== undefined
    ? `${output.width}x${output.height}`
    : output.aspectRatio;
  return {
    ...(size && { size }),
    ...(output.quality && { quality: output.quality }),
    ...(output.format && { output_format: output.format }),
    ...(output.background && { background: output.background }),
  };
}

function extensionForMime(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/gif') return 'gif';
  return 'png';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
