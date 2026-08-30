import {
  GatewayCallError,
  isGatewayCallError,
  localCallError,
} from '../execution/call-error.js';
import type { AttemptContext, RunContext } from '../execution/contracts.js';
import type { AiExecutionPolicy, CompiledTarget } from '../execution/runtime-snapshot.js';
import type { AiAttemptEvent, AiEvent, AiRequest } from './contracts.js';
import { canRetryAiAttempt, retryDelayMs } from './retry-decision.js';
import { initialAiRunState, reduceAiRun } from './run-state.js';

export interface AiRunDependencies {
  now(): number;
  sleep(delayMs: number, signal: AbortSignal): Promise<void>;
}

const DEFAULT_DEPENDENCIES: AiRunDependencies = {
  now: () => Date.now(),
  sleep: abortableDelay,
};

export interface ExecuteAiRunInput {
  request: AiRequest;
  context: RunContext;
  target: CompiledTarget;
  policy: AiExecutionPolicy;
  dependencies?: Partial<AiRunDependencies>;
  onAttemptStarted?: (at: number) => void;
}

export async function* executeAiRun(input: ExecuteAiRunInput): AsyncIterable<AiEvent> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...input.dependencies };
  let state = initialAiRunState();
  let sequence = 0;

  const base = (attempt: number) => ({
    runId: input.context.runId,
    sequence: ++sequence,
    attempt,
    emittedAt: dependencies.now(),
  });

  yield {
    ...base(1),
    kind: 'response.started',
    model: input.target.ref,
    configRevision: input.target.configRevision,
  };

  if (input.context.signal.aborted) {
    state = reduceAiRun(state, { kind: 'run.cancelled' });
    yield { ...base(0), kind: 'response.cancelled', reason: abortReason(input.context.signal) };
    return;
  }

  const runner = input.target.ai;
  if (!runner) {
    const error = localCallError({
      gateway: 'ai',
      target: input.target.ref,
      driverId: input.target.driverId,
      stage: 'binding',
      attempt: 0,
      traceId: input.context.traceId,
      localCode: 'AI_TARGET_NOT_COMPILED',
      message: `Target ${input.target.ref.providerId}/${input.target.ref.modelId} has no AI execution function`,
    });
    state = reduceAiRun(reduceAiRun(state, { kind: 'attempt.opened' }), { kind: 'attempt.failed', retry: false });
    yield { ...base(0), kind: 'response.failed', error };
    return;
  }
  const request = applyGenerationDefaults(input.request, runner.generationDefaults);

  while (state.attempt < input.policy.maxAttempts) {
    state = reduceAiRun(state, { kind: 'attempt.opened' });
    const attempt = state.attempt;
    input.onAttemptStarted?.(dependencies.now());
    const attemptController = new AbortController();
    const detachParentAbort = forwardAbort(input.context.signal, attemptController);
    const attemptContext: AttemptContext = {
      ...input.context,
      signal: attemptController.signal,
      attempt,
      configRevision: input.target.configRevision,
      connectTimeoutMs: input.policy.connectTimeoutMs,
    };

    try {
      const iterator = runner.openAttempt(request, attemptContext)[Symbol.asyncIterator]();

      try {
        while (true) {
          const next = await nextWithTimeout(
            iterator,
            input.policy.streamIdleTimeoutMs,
            input.context.deadlineAt,
            dependencies.now,
            attemptController.signal,
            () => timeoutError(input, attempt, 'stream_idle'),
            () => timeoutError(input, attempt, 'absolute_deadline'),
          );

          if (next.done) {
            throw localCallError({
              gateway: 'ai',
              target: input.target.ref,
              driverId: input.target.driverId,
              stage: 'stream',
              attempt,
              traceId: input.context.traceId,
              localCode: 'AI_STREAM_INCOMPLETE',
              message: 'AI driver stream ended without a terminal event',
            });
          }

          state = reduceAiRun(state, { kind: 'attempt.event', event: next.value });
          yield toPublicEvent(next.value, base(attempt));

          if (next.value.kind === 'response.completed') return;
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
        attemptController.abort(input.context.signal.reason);
        state = reduceAiRun(state, { kind: 'run.cancelled' });
        yield { ...base(attempt), kind: 'response.cancelled', reason: abortReason(input.context.signal) };
        return;
      }

      const error = normalizeAttemptError(cause, input, attempt);
      const retry = attempt < input.policy.maxAttempts
        && canRetryAiAttempt(error)
        && !deadlineReached(input.context.deadlineAt, dependencies.now());
      state = reduceAiRun(state, { kind: 'attempt.failed', retry });

      if (!retry) {
        yield { ...base(attempt), kind: 'response.failed', error };
        return;
      }

      const delayMs = retryDelayMs(input.policy.retryBaseDelayMs, attempt);
      const retryAt = dependencies.now() + delayMs;
      yield { ...base(attempt), kind: 'response.retrying', retryAt, error };

      try {
        await dependencies.sleep(delayMs, input.context.signal);
      } catch {
        state = reduceAiRun(state, { kind: 'run.cancelled' });
        yield { ...base(attempt), kind: 'response.cancelled', reason: abortReason(input.context.signal) };
        return;
      }
      state = reduceAiRun(state, { kind: 'backoff.elapsed' });
    } finally {
      detachParentAbort();
      attemptController.abort();
    }
  }
}

function applyGenerationDefaults(
  request: AiRequest,
  defaults: NonNullable<CompiledTarget['ai']>['generationDefaults'],
): AiRequest {
  if (!defaults || Object.keys(defaults).length === 0) return request;
  return {
    ...request,
    generation: {
      ...defaults,
      ...request.generation,
    },
  };
}

function toPublicEvent(
  event: AiAttemptEvent,
  base: Pick<AiEvent, 'runId' | 'sequence' | 'attempt' | 'emittedAt'>,
): AiEvent {
  return { ...base, ...event } as AiEvent;
}

function normalizeAttemptError(cause: unknown, input: ExecuteAiRunInput, attempt: number): GatewayCallError {
  if (isGatewayCallError(cause)) return cause;
  return localCallError({
    gateway: 'ai',
    target: input.target.ref,
    driverId: input.target.driverId,
    stage: 'driver',
    attempt,
    traceId: input.context.traceId,
    localCode: 'UNWRAPPED_DRIVER_ERROR',
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

function timeoutError(
  input: ExecuteAiRunInput,
  attempt: number,
  stage: 'stream_idle' | 'absolute_deadline',
): GatewayCallError {
  return new GatewayCallError({
    source: 'timeout',
    gateway: 'ai',
    providerId: input.target.ref.providerId,
    modelId: input.target.ref.modelId,
    driverId: input.target.driverId,
    stage,
    attempt,
    traceId: input.context.traceId,
    message: `AI request timed out during ${stage}`,
    localCode: `AI_${stage.toUpperCase()}_TIMEOUT`,
  });
}

async function nextWithTimeout<T>(
  iterator: AsyncIterator<T>,
  idleTimeoutMs: number,
  deadlineAt: number | undefined,
  now: () => number,
  signal: AbortSignal,
  idleError: () => Error,
  deadlineError: () => Error,
): Promise<IteratorResult<T>> {
  signal.throwIfAborted();
  const deadlineRemaining = deadlineAt === undefined ? Number.POSITIVE_INFINITY : deadlineAt - now();
  const timeoutMs = Math.min(idleTimeoutMs, deadlineRemaining);
  const error = deadlineRemaining <= idleTimeoutMs ? deadlineError : idleError;
  if (timeoutMs <= 0) throw error();

  let timer: NodeJS.Timeout | undefined;
  let detachAbort: () => void = () => undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<T>>((_, reject) => {
        timer = setTimeout(() => reject(error()), timeoutMs);
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

function deadlineReached(deadlineAt: number | undefined, now: number): boolean {
  return deadlineAt !== undefined && deadlineAt <= now;
}

function abortReason(signal: AbortSignal): string | undefined {
  if (signal.reason instanceof Error) return signal.reason.message;
  return signal.reason === undefined ? undefined : String(signal.reason);
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
      reject(abortError(signal));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new Error(signal.reason === undefined ? 'AI attempt aborted' : String(signal.reason));
}
