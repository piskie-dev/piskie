import {
  GatewayCallError,
  isGatewayCallError,
  localCallError,
} from '../execution/call-error.js';
import type { AttemptContext, RunContext } from '../execution/contracts.js';
import type { CompiledTarget, ImageExecutionPolicy } from '../execution/runtime-snapshot.js';
import type { ImageArtifact, ImageEvent, ImageJobRef, ImageRequest, ImageUsage } from './contracts.js';
import {
  ImageSubmissionError,
  type ImageResumeInput,
} from './driver-port.js';
import { ImageJobJournal, type ImageJobRecord } from './job-journal.js';
import {
  canSubmitImageAttempt,
  initialImageRunState,
  reduceImageRun,
} from './run-state.js';

export interface ImageRunDependencies {
  journal: ImageJobJournal;
  now(): number;
  sleep(delayMs: number, signal: AbortSignal): Promise<void>;
}

export interface ExecuteImageRunInput {
  request: ImageRequest;
  context: RunContext;
  target: CompiledTarget;
  policy: ImageExecutionPolicy;
  dependencies: ImageRunDependencies;
}

export async function* executeImageRun(input: ExecuteImageRunInput): AsyncIterable<ImageEvent> {
  const { dependencies } = input;
  let state = initialImageRunState();
  let sequence = 0;
  const artifacts: ImageArtifact[] = [];
  let usage: ImageUsage = {};
  let jobRecord: ImageJobRecord | undefined;
  const operationDeadline = minimumDeadline(
    input.context.deadlineAt,
    dependencies.now() + input.policy.operationTimeoutMs,
  );
  const eventBase = () => ({
    runId: input.context.runId,
    sequence: ++sequence,
    emittedAt: dependencies.now(),
  });

  if (input.context.signal.aborted) {
    yield { ...eventBase(), kind: 'image.cancelled', artifacts, upstreamMayContinue: false };
    return;
  }
  const runner = input.target.image;
  if (!runner) {
    yield {
      ...eventBase(),
      kind: 'image.failed',
      artifacts,
      error: localCallError({
        gateway: 'image',
        target: input.target.ref,
        driverId: input.target.driverId,
        stage: 'binding',
        attempt: 0,
        traceId: input.context.traceId,
        localCode: 'IMAGE_TARGET_NOT_COMPILED',
        message: `Target ${input.target.ref.providerId}/${input.target.ref.modelId} has no Image execution function`,
      }),
    };
    return;
  }

  while (canSubmitImageAttempt(state) && state.submitAttempt < input.policy.maxSubmitAttempts) {
    state = reduceImageRun(state, { kind: 'submit.started' });
    const attempt = state.submitAttempt;
    yield {
      ...eventBase(),
      kind: 'image.submitting',
      attempt,
      model: input.target.ref,
      configRevision: input.target.configRevision,
    };
    const attemptController = new AbortController();
    const detachParentAbort = forwardAbort(input.context.signal, attemptController);
    const attemptContext: AttemptContext = {
      ...input.context,
      signal: attemptController.signal,
      attempt,
      configRevision: input.target.configRevision,
      connectTimeoutMs: input.policy.submitTimeoutMs,
    };
    const submitDeadline = dependencies.now() + input.policy.submitTimeoutMs;

    try {
      const iterator = runner.submit(input.request, attemptContext)[Symbol.asyncIterator]();
      try {
        while (true) {
          const waitingForJobAcceptance = runner.mode === 'job' && !state.accepted;
          const phaseDeadline = waitingForJobAcceptance
            ? minimumDeadline(operationDeadline, submitDeadline)
            : operationDeadline;
          const next = await nextBeforeDeadline(
            iterator,
            phaseDeadline,
            dependencies.now,
            attemptController.signal,
            () => imageTimeoutError(
              input,
              attempt,
              waitingForJobAcceptance ? 'submit' : 'operation',
            ),
          );
          if (next.done) throw incompleteStreamError(input, attempt);

          state = reduceImageRun(state, { kind: 'attempt.event', event: next.value });
          switch (next.value.kind) {
            case 'job.accepted': {
              jobRecord = await dependencies.journal.create({
                providerId: input.target.ref.providerId,
                modelId: input.target.ref.modelId,
                driverId: input.target.driverId,
                configRevision: input.target.configRevision,
                upstreamJobId: next.value.upstreamJobId,
                resumable: next.value.resumable,
                request: input.request,
                driverState: next.value.driverState,
              });
              yield {
                ...eventBase(),
                kind: 'image.queued',
                job: jobRecord.job,
                ...(next.value.position !== undefined && { position: next.value.position }),
              };
              break;
            }
            case 'progress':
              yield {
                ...eventBase(),
                kind: 'image.progress',
                job: requireJob(jobRecord, input, attempt),
                value: next.value.value,
                ...(next.value.message && { message: next.value.message }),
              };
              break;
            case 'preview':
              yield {
                ...eventBase(),
                kind: 'image.preview',
                job: requireJob(jobRecord, input, attempt),
                artifact: next.value.artifact,
              };
              break;
            case 'artifact':
              artifacts.push(next.value.artifact);
              yield {
                ...eventBase(),
                kind: 'image.artifact',
                ...(jobRecord && { job: jobRecord.job }),
                artifact: next.value.artifact,
              };
              break;
            case 'completed':
              usage = { ...usage, ...next.value.usage };
              if (jobRecord) {
                await dependencies.journal.update(jobRecord.journalId, {
                  status: 'completed', artifacts, usage,
                });
              }
              yield { ...eventBase(), kind: 'image.completed', artifacts, usage };
              return;
          }
        }
      } catch (cause) {
        attemptController.abort(cause);
        throw cause;
      } finally {
        attemptController.abort();
        await iterator.return?.().catch(() => undefined);
      }
    } catch (cause) {
      if (input.context.signal.aborted) {
        const upstreamMayContinue = state.accepted || state.phase === 'submitting';
        state = reduceImageRun(state, { kind: 'run.cancelled' });
        if (jobRecord) {
          await dependencies.journal.update(jobRecord.journalId, { status: 'cancelled', artifacts, usage });
        }
        yield {
          ...eventBase(),
          kind: 'image.cancelled',
          artifacts,
          upstreamMayContinue,
        };
        return;
      }

      const error = normalizeImageError(cause, input, attempt);
      if (state.accepted) {
        state = reduceImageRun(state, { kind: 'observe.failed' });
        if (jobRecord) {
          await dependencies.journal.update(jobRecord.journalId, {
            status: 'failed', artifacts, usage, error: error.toJSON(),
          });
        }
        yield { ...eventBase(), kind: 'image.failed', error, artifacts };
        return;
      }

      const retry = attempt < input.policy.maxSubmitAttempts
        && isSafeSubmitRetry(error)
        && dependencies.now() < operationDeadline;
      state = reduceImageRun(state, { kind: 'submit.failed', retry });
      if (!retry) {
        yield { ...eventBase(), kind: 'image.failed', error, artifacts };
        return;
      }
      try {
        await dependencies.sleep(retryDelay(attempt), input.context.signal);
      } catch {
        state = reduceImageRun(state, { kind: 'run.cancelled' });
        yield { ...eventBase(), kind: 'image.cancelled', artifacts, upstreamMayContinue: false };
        return;
      }
      state = reduceImageRun(state, { kind: 'backoff.elapsed' });
    } finally {
      detachParentAbort();
      attemptController.abort();
    }
  }
}

export interface ExecuteImageResumeInput {
  record: ImageJobRecord;
  context: RunContext;
  target: CompiledTarget;
  policy: ImageExecutionPolicy;
  dependencies: ImageRunDependencies;
}

export async function* executeImageResume(input: ExecuteImageResumeInput): AsyncIterable<ImageEvent> {
  const runner = input.target.image;
  let sequence = 0;
  const artifacts = [...input.record.artifacts];
  let usage = { ...input.record.usage };
  const eventBase = () => ({
    runId: input.context.runId,
    sequence: ++sequence,
    emittedAt: input.dependencies.now(),
  });
  if (!runner?.resume) {
    yield {
      ...eventBase(),
      kind: 'image.failed',
      artifacts,
      error: localCallError({
        gateway: 'image',
        target: input.target.ref,
        driverId: input.target.driverId,
        stage: 'resume',
        attempt: 0,
        traceId: input.context.traceId,
        localCode: 'IMAGE_JOB_NOT_RESUMABLE',
        message: `Driver ${input.target.driverId} cannot resume image jobs`,
      }),
    };
    return;
  }

  yield { ...eventBase(), kind: 'image.queued', job: input.record.job };
  const controller = new AbortController();
  const detach = forwardAbort(input.context.signal, controller);
  const context: AttemptContext = {
    ...input.context,
    signal: controller.signal,
    attempt: 0,
    configRevision: input.target.configRevision,
    connectTimeoutMs: input.policy.submitTimeoutMs,
  };
  const deadline = minimumDeadline(
    input.context.deadlineAt,
    input.dependencies.now() + input.policy.operationTimeoutMs,
  );
  const resumeInput: ImageResumeInput = {
    job: input.record.job,
    request: input.record.request,
    driverState: input.record.driverState,
  };

  try {
    const iterator = runner.resume(resumeInput, context)[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await nextBeforeDeadline(
          iterator,
          deadline,
          input.dependencies.now,
          controller.signal,
          () => imageTimeoutError({
            request: input.record.request,
            context: input.context,
            target: input.target,
          }, 0, 'operation'),
        );
        if (next.done) throw incompleteStreamError({
          request: input.record.request,
          context: input.context,
          target: input.target,
        }, 0);
        if (next.value.kind === 'job.accepted') {
          throw new Error('Image resume attempted to accept a second job');
        }
        if (next.value.kind === 'progress') {
          yield {
            ...eventBase(), kind: 'image.progress', job: input.record.job,
            value: next.value.value, ...(next.value.message && { message: next.value.message }),
          };
        } else if (next.value.kind === 'preview') {
          yield { ...eventBase(), kind: 'image.preview', job: input.record.job, artifact: next.value.artifact };
        } else if (next.value.kind === 'artifact') {
          artifacts.push(next.value.artifact);
          yield { ...eventBase(), kind: 'image.artifact', job: input.record.job, artifact: next.value.artifact };
        } else {
          usage = { ...usage, ...next.value.usage };
          await input.dependencies.journal.update(input.record.journalId, {
            status: 'completed', artifacts, usage,
          });
          yield { ...eventBase(), kind: 'image.completed', artifacts, usage };
          return;
        }
      }
    } catch (cause) {
      controller.abort(cause);
      throw cause;
    } finally {
      controller.abort();
      await iterator.return?.().catch(() => undefined);
    }
  } catch (cause) {
    if (input.context.signal.aborted) {
      await input.dependencies.journal.update(input.record.journalId, {
        status: 'cancelled', artifacts, usage,
      });
      yield { ...eventBase(), kind: 'image.cancelled', artifacts, upstreamMayContinue: true };
      return;
    }
    const error = normalizeImageError(cause, {
      request: input.record.request,
      context: input.context,
      target: input.target,
    }, 0);
    await input.dependencies.journal.update(input.record.journalId, {
      status: 'failed', artifacts, usage, error: error.toJSON(),
    });
    yield { ...eventBase(), kind: 'image.failed', error, artifacts };
  } finally {
    detach();
    controller.abort();
  }
}

type ErrorInput = Pick<ExecuteImageRunInput, 'request' | 'context' | 'target'>;

function normalizeImageError(cause: unknown, input: ErrorInput, attempt: number): GatewayCallError {
  if (isGatewayCallError(cause)) return cause;
  return localCallError({
    gateway: 'image',
    target: input.target.ref,
    driverId: input.target.driverId,
    stage: 'driver',
    attempt,
    traceId: input.context.traceId,
    localCode: 'UNWRAPPED_IMAGE_DRIVER_ERROR',
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

function isSafeSubmitRetry(error: GatewayCallError): boolean {
  return error instanceof ImageSubmissionError
    && error.submissionState !== 'unknown'
    && error.retryable;
}

function requireJob(record: ImageJobRecord | undefined, input: ErrorInput, attempt: number): ImageJobRef {
  if (record) return record.job;
  throw localCallError({
    gateway: 'image',
    target: input.target.ref,
    driverId: input.target.driverId,
    stage: 'driver_contract',
    attempt,
    traceId: input.context.traceId,
    localCode: 'IMAGE_JOB_EVENT_BEFORE_ACCEPTANCE',
    message: 'Image Driver emitted a job event before accepting a job ID',
  });
}

function incompleteStreamError(input: ErrorInput, attempt: number): GatewayCallError {
  return localCallError({
    gateway: 'image',
    target: input.target.ref,
    driverId: input.target.driverId,
    stage: 'stream',
    attempt,
    traceId: input.context.traceId,
    localCode: 'IMAGE_STREAM_INCOMPLETE',
    message: 'Image Driver stream ended without a completion event',
  });
}

function imageTimeoutError(
  input: ErrorInput,
  attempt: number,
  stage: 'submit' | 'operation',
): ImageSubmissionError {
  return new ImageSubmissionError({
    source: 'timeout',
    gateway: 'image',
    providerId: input.target.ref.providerId,
    modelId: input.target.ref.modelId,
    driverId: input.target.driverId,
    stage,
    attempt,
    traceId: input.context.traceId,
    message: `Image request timed out during ${stage}`,
    localCode: `IMAGE_${stage.toUpperCase()}_TIMEOUT`,
  }, 'unknown', false);
}

async function nextBeforeDeadline<T>(
  iterator: AsyncIterator<T>,
  deadlineAt: number,
  now: () => number,
  signal: AbortSignal,
  timeoutError: () => Error,
): Promise<IteratorResult<T>> {
  signal.throwIfAborted();
  const remaining = deadlineAt - now();
  if (remaining <= 0) throw timeoutError();
  let timer: NodeJS.Timeout | undefined;
  let detachAbort: () => void = () => undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<T>>((_, reject) => {
        timer = setTimeout(() => reject(timeoutError()), remaining);
      }),
      new Promise<IteratorResult<T>>((_, reject) => {
        const abort = () => reject(abortError(signal));
        signal.addEventListener('abort', abort, { once: true });
        detachAbort = () => signal.removeEventListener('abort', abort);
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    detachAbort();
  }
}

function forwardAbort(parent: AbortSignal, child: AbortController): () => void {
  if (parent.aborted) {
    child.abort(parent.reason);
    return () => undefined;
  }
  const abort = () => child.abort(parent.reason);
  parent.addEventListener('abort', abort, { once: true });
  return () => parent.removeEventListener('abort', abort);
}

function minimumDeadline(left: number | undefined, right: number): number {
  return left === undefined ? right : Math.min(left, right);
}

function retryDelay(attempt: number): number {
  return Math.min(250 * 2 ** Math.max(0, attempt - 1), 5_000);
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new Error(signal.reason === undefined ? 'Image request aborted' : String(signal.reason));
}
