import { appLog } from '@electron/observability/logging/app-log.js';
import { localCallError } from '../execution/call-error.js';
import type { RunContext } from '../execution/contracts.js';
import {
  findCompiledTarget,
  type InferenceRuntimeSnapshot,
  type RuntimeSnapshotStore,
} from '../execution/runtime-snapshot.js';
import type { AiEvent, AiGateway, AiRequest, AiResult, AiRunHandle } from './contracts.js';
import { collectAiResult } from './result-reducer.js';
import { executeAiRun, type AiRunDependencies } from './run-machine.js';
import { AIRequestInfoCollector, type AiRunStatistics } from './request-info-collector.js';
export class DefaultAiGateway implements AiGateway {
  constructor(
    private readonly snapshots: RuntimeSnapshotStore,
    private readonly dependencies: Partial<AiRunDependencies> = {}
  ) {}

  open(request: AiRequest, context: RunContext): AiRunHandle {
    const collector = new AIRequestInfoCollector();
    let settle!: (statistics: AiRunStatistics) => void;
    const statistics = new Promise<AiRunStatistics>((resolve) => {
      settle = resolve;
    });
    return {
      events: this.observeRun(this.execute(request, context, collector), collector, settle),
      statistics,
    };
  }

  async complete(request: AiRequest, context: RunContext): Promise<AiResult> {
    const run = this.open(request, context);
    return collectAiResult(run.events, request.model, context.traceId);
  }

  private async *execute(
    request: AiRequest,
    context: RunContext,
    collector: AIRequestInfoCollector
  ): AsyncIterable<AiEvent> {
    const snapshot = this.snapshots.capture();
    if (!snapshot) {
      yield* this.bindingFailure(
        request,
        context,
        undefined,
        'RUNTIME_NOT_READY',
        'Inference runtime is not ready'
      );
      return;
    }

    const target = findCompiledTarget(snapshot, request.model);
    if (!target) {
      yield* this.bindingFailure(
        request,
        context,
        snapshot,
        'MODEL_TARGET_NOT_FOUND',
        `Configured target not found: ${request.model.providerId}/${request.model.modelId}`
      );
      return;
    }

    yield* executeAiRun({
      request,
      context,
      target,
      policy: snapshot.policies.ai,
      dependencies: this.dependencies,
      onAttemptStarted: (at) =>
        safelyCollectStatistics(() => collector.onAttemptStarted(at), undefined),
    });
  }

  private observeRun(
    events: AsyncIterable<AiEvent>,
    collector: AIRequestInfoCollector,
    settle: (statistics: AiRunStatistics) => void
  ): AsyncIterable<AiEvent> {
    const source = events[Symbol.asyncIterator]();
    let settled = false;
    const finish = (at: number) => {
      if (settled) return;
      settled = true;
      settle(safelyCollectStatistics(() => collector.complete(at), {}));
    };
    const observe = (result: IteratorResult<AiEvent>): IteratorResult<AiEvent> => {
      if (result.done) {
        finish(Date.now());
        return result;
      }
      const event = result.value;
      if (
        (event.kind === 'reasoning.delta' || event.kind === 'text.delta') &&
        event.text.length > 0
      ) {
        safelyCollectStatistics(() => collector.onVisibleContent(event.emittedAt), undefined);
      }
      if (
        event.kind === 'response.completed' ||
        event.kind === 'response.failed' ||
        event.kind === 'response.cancelled'
      ) {
        finish(event.emittedAt);
      }
      return result;
    };
    const iterator: AsyncIterableIterator<AiEvent> = {
      async next() {
        try {
          return observe(await source.next());
        } catch (error) {
          finish(Date.now());
          throw error;
        }
      },
      async return(value?: unknown) {
        try {
          const result: IteratorResult<AiEvent> = source.return
            ? await source.return(value)
            : { done: true, value: undefined };
          return observe(result);
        } catch (error) {
          finish(Date.now());
          throw error;
        }
      },
      async throw(error?: unknown) {
        try {
          if (source.throw) return observe(await source.throw(error));
          if (source.return) await source.return();
          throw error;
        } catch (cause) {
          finish(Date.now());
          throw cause;
        }
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return iterator;
  }

  private async *bindingFailure(
    request: AiRequest,
    context: RunContext,
    snapshot: InferenceRuntimeSnapshot | undefined,
    localCode: string,
    message: string
  ): AsyncIterable<AiEvent> {
    const emittedAt = Date.now();
    yield {
      kind: 'response.started',
      runId: context.runId,
      sequence: 1,
      attempt: 0,
      emittedAt,
      model: request.model,
      configRevision: snapshot?.configRevision ?? 0,
    };
    yield {
      kind: 'response.failed',
      runId: context.runId,
      sequence: 2,
      attempt: 0,
      emittedAt: Date.now(),
      error: localCallError({
        gateway: 'ai',
        target: request.model,
        driverId: 'unresolved',
        stage: 'binding',
        attempt: 0,
        traceId: context.traceId,
        localCode,
        message,
      }),
    };
  }
}

function safelyCollectStatistics<T>(collect: () => T, fallback: T): T {
  try {
    return collect();
  } catch (error) {
    if (!statisticsFailureReported) {
      statisticsFailureReported = true;
      appLog.warn({
        event: 'inference.statistics.collect.degraded',
        message: 'Inference statistics collection degraded',
        context: { scope: 'inference.statistics' },
        error: error,
      });
    }
    return fallback;
  }
}

let statisticsFailureReported = false;
