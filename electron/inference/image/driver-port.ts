import type { GatewayCallErrorData } from '../execution/call-error.js';
import { GatewayCallError } from '../execution/call-error.js';
import type { AttemptContext } from '../execution/contracts.js';
import type { ImageArtifact, ImageJobRef, ImageRequest, ImageUsage } from './contracts.js';

export type ImageAttemptEvent =
  | {
      kind: 'job.accepted';
      upstreamJobId: string;
      resumable: boolean;
      position?: number;
      driverState?: unknown;
    }
  | { kind: 'progress'; value: number; message?: string }
  | { kind: 'preview'; artifact: ImageArtifact }
  | { kind: 'artifact'; artifact: ImageArtifact }
  | { kind: 'completed'; usage: ImageUsage };

export interface ImageResumeInput {
  job: ImageJobRef;
  request: ImageRequest;
  driverState?: unknown;
}

export interface CompiledImageTarget {
  mode: 'synchronous' | 'job';
  submit(request: ImageRequest, context: AttemptContext): AsyncIterable<ImageAttemptEvent>;
  resume?(input: ImageResumeInput, context: AttemptContext): AsyncIterable<ImageAttemptEvent>;
}

export type ImageSubmissionState = 'not_accepted' | 'rejected' | 'unknown';

export class ImageSubmissionError extends GatewayCallError {
  constructor(
    data: GatewayCallErrorData,
    readonly submissionState: ImageSubmissionState,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(data, options);
    this.name = 'ImageSubmissionError';
  }
}
