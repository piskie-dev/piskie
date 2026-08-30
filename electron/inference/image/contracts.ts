import type { GatewayCallError } from '../execution/call-error.js';
import type { ArtifactRef, ModelTarget, RunContext } from '../execution/contracts.js';

export interface ImageOutputSpec {
  width?: number;
  height?: number;
  aspectRatio?: string;
  quality?: string;
  format?: 'png' | 'jpeg' | 'webp';
  background?: 'transparent' | 'opaque' | 'auto';
}

export type ImageOperation =
  | {
      kind: 'generate';
      prompt: string;
      count?: number;
      output?: ImageOutputSpec;
    }
  | {
      kind: 'edit';
      prompt: string;
      sources: readonly ArtifactRef[];
      mask?: ArtifactRef;
      count?: number;
      output?: ImageOutputSpec;
    };

export interface ImageRequest {
  model: ModelTarget;
  operation: ImageOperation;
  extensions?: Readonly<Record<string, unknown>>;
}

export interface ImageArtifact {
  artifactId: string;
  mimeType: string;
  width?: number;
  height?: number;
  byteLength?: number;
  sha256?: string;
  revisedPrompt?: string;
  seed?: number;
}

export interface ImageUsage {
  imageCount?: number;
  providerUnits?: number;
  estimatedCost?: number;
  currency?: string;
}

export interface ImageJobRef {
  journalId: string;
  providerId: string;
  modelId: string;
  driverId: string;
  configRevision: number;
  upstreamJobId: string;
  resumable: boolean;
}

interface ImageEventBase {
  runId: string;
  sequence: number;
  emittedAt: number;
}

export type ImageEvent =
  | (ImageEventBase & {
      kind: 'image.submitting';
      attempt: number;
      model: ModelTarget;
      configRevision: number;
    })
  | (ImageEventBase & { kind: 'image.queued'; job: ImageJobRef; position?: number })
  | (ImageEventBase & { kind: 'image.progress'; job: ImageJobRef; value: number; message?: string })
  | (ImageEventBase & { kind: 'image.preview'; job: ImageJobRef; artifact: ImageArtifact })
  | (ImageEventBase & { kind: 'image.artifact'; job?: ImageJobRef; artifact: ImageArtifact })
  | (ImageEventBase & { kind: 'image.completed'; artifacts: readonly ImageArtifact[]; usage: ImageUsage })
  | (ImageEventBase & { kind: 'image.failed'; error: GatewayCallError; artifacts: readonly ImageArtifact[] })
  | (ImageEventBase & { kind: 'image.cancelled'; artifacts: readonly ImageArtifact[]; upstreamMayContinue: boolean });

export interface ImageResult {
  runId: string;
  model: ModelTarget;
  configRevision: number;
  artifacts: readonly ImageArtifact[];
  usage: ImageUsage;
  job?: ImageJobRef;
}

export interface ImageGateway {
  run(request: ImageRequest, context: RunContext): AsyncIterable<ImageEvent>;
  complete(request: ImageRequest, context: RunContext): Promise<ImageResult>;
  resume(job: ImageJobRef, context: RunContext): AsyncIterable<ImageEvent>;
}
