import { createUuid } from '@shared/utils/identifiers.js';
import type { ArtifactStore } from '../execution/artifact-port.js';
import type { ModelTarget } from '../execution/contracts.js';
import { findCompiledTarget, type RuntimeSnapshotStore } from '../execution/runtime-snapshot.js';
import type {
  ImageGateway,
  ImageOperation,
  ImageOutputSpec,
} from '../image/contracts.js';

export interface ImageApplicationSource {
  bytes: Uint8Array;
  mimeType: string;
  fileName?: string;
}

export interface ImageApplicationRequest {
  model: ModelTarget;
  prompt: string;
  sources?: readonly ImageApplicationSource[];
  mask?: ImageApplicationSource;
  count?: number;
  size?: string;
  quality?: string;
  format?: ImageOutputSpec['format'];
  background?: ImageOutputSpec['background'];
  extensions?: Readonly<Record<string, unknown>>;
}

export interface ImageApplicationOutput extends ImageApplicationSource {
  artifactId: string;
  revisedPrompt?: string;
  width?: number;
  height?: number;
  sha256?: string;
}

export interface ImageApplicationResult {
  runId: string;
  model: ModelTarget;
  configRevision: number;
  images: readonly ImageApplicationOutput[];
}

export interface ImageApplicationPort {
  hasTarget(target: ModelTarget): boolean;
  execute(request: ImageApplicationRequest, options?: { signal?: AbortSignal }): Promise<ImageApplicationResult>;
}

export class DefaultImageApplicationPort implements ImageApplicationPort {
  constructor(
    private readonly gateway: ImageGateway,
    private readonly snapshots: RuntimeSnapshotStore,
    private readonly artifacts: ArtifactStore,
  ) {}

  hasTarget(target: ModelTarget): boolean {
    const snapshot = this.snapshots.capture();
    return snapshot !== undefined && findCompiledTarget(snapshot, target)?.image !== undefined;
  }

  async execute(
    request: ImageApplicationRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<ImageApplicationResult> {
    const controller = options.signal ? undefined : new AbortController();
    const signal = options.signal ?? controller!.signal;
    signal.throwIfAborted();

    const sources = await Promise.all(
      (request.sources ?? []).map((source) => this.storeInput(source, signal)),
    );
    const mask = request.mask ? await this.storeInput(request.mask, signal) : undefined;
    const operation = createOperation(request, sources, mask);
    const runId = `image-${createUuid()}`;
    const traceId = `image:${runId}`;
    const result = await this.gateway.complete(
      {
        model: request.model,
        operation,
        ...(request.extensions && { extensions: request.extensions }),
      },
      { runId, traceId, signal },
    );

    const images = await Promise.all(result.artifacts.map(async (artifact) => {
      const payload = await this.artifacts.read({ artifactId: artifact.artifactId }, signal);
      return {
        artifactId: artifact.artifactId,
        bytes: payload.bytes,
        mimeType: payload.mimeType,
        ...(payload.fileName && { fileName: payload.fileName }),
        ...(artifact.revisedPrompt && { revisedPrompt: artifact.revisedPrompt }),
        ...(artifact.width !== undefined && { width: artifact.width }),
        ...(artifact.height !== undefined && { height: artifact.height }),
        ...(artifact.sha256 && { sha256: artifact.sha256 }),
      };
    }));

    return {
      runId: result.runId,
      model: result.model,
      configRevision: result.configRevision,
      images,
    };
  }

  private async storeInput(source: ImageApplicationSource, signal: AbortSignal) {
    return (await this.artifacts.write({
      bytes: source.bytes,
      mimeType: source.mimeType,
      ...(source.fileName && { fileName: source.fileName }),
    }, signal)).ref;
  }
}

function createOperation(
  request: ImageApplicationRequest,
  sources: Awaited<ReturnType<DefaultImageApplicationPort['storeInput']>>[],
  mask: Awaited<ReturnType<DefaultImageApplicationPort['storeInput']>> | undefined,
): ImageOperation {
  const output = mapOutput(request);
  const common = {
    prompt: request.prompt,
    ...(request.count !== undefined && { count: request.count }),
    ...(output && { output }),
  };
  if (sources.length === 0) return { kind: 'generate', ...common };
  return {
    kind: 'edit',
    ...common,
    sources,
    ...(mask && { mask }),
  };
}

function mapOutput(request: ImageApplicationRequest): ImageOutputSpec | undefined {
  const dimensions = request.size && /^(\d+)x(\d+)$/.exec(request.size);
  const output: ImageOutputSpec = {
    ...(dimensions
      ? { width: Number(dimensions[1]), height: Number(dimensions[2]) }
      : request.size ? { aspectRatio: request.size } : {}),
    ...(request.quality && { quality: request.quality }),
    ...(request.format && { format: request.format }),
    ...(request.background && { background: request.background }),
  };
  return Object.keys(output).length > 0 ? output : undefined;
}
