import { localCallError } from '../execution/call-error.js';
import type { RunContext } from '../execution/contracts.js';
import {
  findCompiledTarget,
  type InferenceRuntimeSnapshot,
  type RuntimeSnapshotStore,
} from '../execution/runtime-snapshot.js';
import type { ImageEvent, ImageGateway, ImageJobRef, ImageRequest, ImageResult } from './contracts.js';
import { ImageJobJournal } from './job-journal.js';
import { collectImageResult } from './result-reducer.js';
import {
  executeImageResume,
  executeImageRun,
  type ImageRunDependencies,
} from './run-machine.js';

export class DefaultImageGateway implements ImageGateway {
  private readonly dependencies: ImageRunDependencies;

  constructor(
    private readonly snapshots: RuntimeSnapshotStore,
    journal: ImageJobJournal,
    dependencies: Partial<Omit<ImageRunDependencies, 'journal'>> = {},
  ) {
    this.dependencies = {
      journal,
      now: dependencies.now ?? (() => Date.now()),
      sleep: dependencies.sleep ?? abortableDelay,
    };
  }

  run(request: ImageRequest, context: RunContext): AsyncIterable<ImageEvent> {
    const snapshot = this.snapshots.capture();
    return this.execute(request, context, snapshot);
  }

  complete(request: ImageRequest, context: RunContext): Promise<ImageResult> {
    return collectImageResult(this.run(request, context), request.model, context.traceId);
  }

  resume(job: ImageJobRef, context: RunContext): AsyncIterable<ImageEvent> {
    return this.executeResume(job, context);
  }

  private async *execute(
    request: ImageRequest,
    context: RunContext,
    snapshot: InferenceRuntimeSnapshot | undefined,
  ): AsyncIterable<ImageEvent> {
    const target = snapshot && findCompiledTarget(snapshot, request.model);
    if (!snapshot || !target) {
      yield missingTargetEvent(request, context, snapshot?.configRevision);
      return;
    }
    yield* executeImageRun({ request, context, target, policy: snapshot.policies.image, dependencies: this.dependencies });
  }

  private async *executeResume(job: ImageJobRef, context: RunContext): AsyncIterable<ImageEvent> {
    const snapshot = this.snapshots.captureRevision(job.configRevision);
    const target = snapshot && findCompiledTarget(snapshot, {
      providerId: job.providerId,
      modelId: job.modelId,
    });
    if (!snapshot || !target || target.configRevision !== job.configRevision || target.driverId !== job.driverId) {
      yield {
        runId: context.runId,
        sequence: 1,
        emittedAt: Date.now(),
        kind: 'image.failed',
        artifacts: [],
        error: localCallError({
          gateway: 'image',
          target: { providerId: job.providerId, modelId: job.modelId },
          driverId: job.driverId,
          stage: 'resume',
          attempt: 0,
          traceId: context.traceId,
          localCode: 'IMAGE_JOB_SNAPSHOT_UNAVAILABLE',
          message: `Runtime snapshot ${job.configRevision} is unavailable for image job ${job.journalId}`,
        }),
      };
      return;
    }
    const record = await this.dependencies.journal.read(job.journalId);
    if (!sameJob(record.job, job)) {
      yield {
        runId: context.runId,
        sequence: 1,
        emittedAt: Date.now(),
        kind: 'image.failed',
        artifacts: record.artifacts,
        error: localCallError({
          gateway: 'image',
          target: target.ref,
          driverId: target.driverId,
          stage: 'resume',
          attempt: 0,
          traceId: context.traceId,
          localCode: 'IMAGE_JOB_REFERENCE_MISMATCH',
          message: `Image job reference does not match journal ${job.journalId}`,
        }),
      };
      return;
    }
    yield* executeImageResume({
      record,
      context,
      target,
      policy: snapshot.policies.image,
      dependencies: this.dependencies,
    });
  }
}

function missingTargetEvent(
  request: ImageRequest,
  context: RunContext,
  configRevision: number | undefined,
): ImageEvent {
  return {
    runId: context.runId,
    sequence: 1,
    emittedAt: Date.now(),
    kind: 'image.failed',
    artifacts: [],
    error: localCallError({
      gateway: 'image',
      target: request.model,
      driverId: 'inference-core',
      stage: 'reference',
      attempt: 0,
      traceId: context.traceId,
      localCode: 'MODEL_TARGET_NOT_FOUND',
      message: configRevision === undefined
        ? 'Inference runtime is not configured'
        : `Image model target not found: ${request.model.providerId}/${request.model.modelId}`,
    }),
  };
}

function sameJob(left: ImageJobRef, right: ImageJobRef): boolean {
  return left.journalId === right.journalId
    && left.providerId === right.providerId
    && left.modelId === right.modelId
    && left.driverId === right.driverId
    && left.configRevision === right.configRevision
    && left.upstreamJobId === right.upstreamJobId
    && left.resumable === right.resumable;
}

async function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
