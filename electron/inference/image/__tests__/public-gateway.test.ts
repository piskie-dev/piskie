import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayCallError } from '../../execution/call-error.js';
import type { RunContext } from '../../execution/contracts.js';
import {
  RuntimeSnapshotStore,
  type CompiledTarget,
  type ImageExecutionPolicy,
  type InferenceRuntimeSnapshot,
} from '../../execution/runtime-snapshot.js';
import type { ImageEvent, ImageRequest } from '../contracts.js';
import { ImageSubmissionError, type CompiledImageTarget } from '../driver-port.js';
import { ImageJobJournal } from '../job-journal.js';
import { DefaultImageGateway } from '../public-gateway.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

const request: ImageRequest = {
  model: { providerId: 'chosen-provider', modelId: 'chosen-model' },
  operation: { kind: 'generate', prompt: 'draw an orange', count: 1 },
};

function context(signal: AbortSignal = new AbortController().signal): RunContext {
  return { runId: 'image-run', traceId: 'image-trace', signal };
}

function compiled(image: CompiledImageTarget, ref = request.model): CompiledTarget {
  return {
    ref,
    driverId: 'fake-image',
    upstreamModel: 'wire-image',
    catalogId: 'test/image',
    configRevision: 7,
    image,
  };
}

function snapshot(
  targets: readonly CompiledTarget[],
  imagePolicy: Partial<ImageExecutionPolicy> = {},
): InferenceRuntimeSnapshot {
  const providers = new Map<string, Map<string, CompiledTarget>>();
  for (const target of targets) {
    const models = providers.get(target.ref.providerId) ?? new Map<string, CompiledTarget>();
    models.set(target.ref.modelId, target);
    providers.set(target.ref.providerId, models);
  }
  return {
    configRevision: 7,
    catalogVersion: 'test',
    targets: providers,
    policies: {
      ai: {
        maxAttempts: 1,
        connectTimeoutMs: 1_000,
        streamIdleTimeoutMs: 1_000,
        retryBaseDelayMs: 1,
      },
      image: {
        maxSubmitAttempts: 3,
        submitTimeoutMs: 1_000,
        operationTimeoutMs: 5_000,
        allowResubmitAfterAccepted: false,
        ...imagePolicy,
      },
    },
    createdAt: '2026-07-29T00:00:00.000Z',
  };
}

async function gateway(...targets: CompiledTarget[]) {
  return gatewayWithPolicy({}, ...targets);
}

async function gatewayWithPolicy(
  imagePolicy: Partial<ImageExecutionPolicy>,
  ...targets: CompiledTarget[]
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-image-jobs-'));
  temporaryDirectories.push(directory);
  const journal = new ImageJobJournal(directory);
  const snapshots = new RuntimeSnapshotStore();
  snapshots.publish(snapshot(targets, imagePolicy));
  return {
    journal,
    gateway: new DefaultImageGateway(snapshots, journal, { sleep: async () => undefined }),
  };
}

async function collect(events: AsyncIterable<ImageEvent>): Promise<ImageEvent[]> {
  const result: ImageEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function submissionFailure(
  submissionState: 'not_accepted' | 'rejected' | 'unknown',
  retryable: boolean,
): ImageSubmissionError {
  return new ImageSubmissionError({
    source: submissionState === 'rejected' ? 'provider' : 'transport',
    gateway: 'image',
    providerId: request.model.providerId,
    modelId: request.model.modelId,
    driverId: 'fake-image',
    stage: 'submit',
    attempt: 1,
    traceId: 'image-trace',
    message: 'fake submission failure',
    ...(submissionState === 'rejected' && {
      upstream: { status: 503, message: 'fake submission failure' },
    }),
  }, submissionState, retryable);
}

describe('DefaultImageGateway', () => {
  it('collects synchronous artifacts through one execution engine', async () => {
    const target = compiled({
      mode: 'synchronous',
      submit: async function* () {
        yield {
          kind: 'artifact',
          artifact: { artifactId: 'artifact:one', mimeType: 'image/png', byteLength: 3, sha256: 'abc' },
        };
        yield { kind: 'completed', usage: { imageCount: 1 } };
      },
    });
    const created = await gateway(target);

    await expect(created.gateway.complete(request, context())).resolves.toMatchObject({
      runId: 'image-run',
      model: request.model,
      configRevision: 7,
      artifacts: [{ artifactId: 'artifact:one', mimeType: 'image/png' }],
      usage: { imageCount: 1 },
    });
  });

  it('uses the operation deadline for a synchronous image request', async () => {
    const target = compiled({
      mode: 'synchronous',
      submit: (_request, attemptContext) => pendingUntilAborted(attemptContext.signal),
    });
    const created = await gatewayWithPolicy({
      submitTimeoutMs: 5,
      operationTimeoutMs: 25,
    }, target);
    const events = await collect(created.gateway.run(request, context()));

    expect(events.at(-1)).toMatchObject({
      kind: 'image.failed',
      error: {
        source: 'timeout',
        stage: 'operation',
        localCode: 'IMAGE_OPERATION_TIMEOUT',
        message: 'Image request timed out during operation',
      },
    });
  });

  it('uses the submit deadline only while a job driver is awaiting acceptance', async () => {
    const target = compiled({
      mode: 'job',
      submit: (_request, attemptContext) => pendingUntilAborted(attemptContext.signal),
    });
    const created = await gatewayWithPolicy({
      submitTimeoutMs: 10,
      operationTimeoutMs: 100,
    }, target);
    const events = await collect(created.gateway.run(request, context()));

    expect(events.at(-1)).toMatchObject({
      kind: 'image.failed',
      error: {
        source: 'timeout',
        stage: 'submit',
        localCode: 'IMAGE_SUBMIT_TIMEOUT',
        message: 'Image request timed out during submit',
      },
    });
  });

  it('retries only an explicitly safe rejection before acceptance', async () => {
    let submissions = 0;
    const target = compiled({
      mode: 'synchronous',
      submit: async function* () {
        submissions++;
        if (submissions === 1) throw submissionFailure('rejected', true);
        yield { kind: 'completed', usage: { imageCount: 0 } };
      },
    });
    const created = await gateway(target);
    const events = await collect(created.gateway.run(request, context()));

    expect(submissions).toBe(2);
    expect(events.map((event) => event.kind)).toEqual([
      'image.submitting',
      'image.submitting',
      'image.completed',
    ]);
  });

  it('never retries an uncertain submission', async () => {
    let submissions = 0;
    const failure = submissionFailure('unknown', true);
    const target = compiled({
      mode: 'synchronous',
      submit: () => {
        submissions++;
        throw failure;
      },
    });
    const created = await gateway(target);
    const events = await collect(created.gateway.run(request, context()));

    expect(submissions).toBe(1);
    expect(events.at(-1)).toMatchObject({ kind: 'image.failed', error: failure });
  });

  it('persists an accepted job and never submits it again after observation failure', async () => {
    let submissions = 0;
    const observationFailure = new GatewayCallError({
      source: 'transport',
      gateway: 'image',
      providerId: request.model.providerId,
      modelId: request.model.modelId,
      driverId: 'fake-image',
      stage: 'observe',
      attempt: 1,
      traceId: 'image-trace',
      message: 'websocket and history failed',
    });
    const target = compiled({
      mode: 'job',
      submit: async function* () {
        submissions++;
        yield { kind: 'job.accepted', upstreamJobId: 'prompt-1', resumable: true, driverState: { clientId: 'client-1' } };
        throw observationFailure;
      },
      resume: async function* () {
        yield { kind: 'completed', usage: {} };
      },
    });
    const created = await gateway(target);
    const events = await collect(created.gateway.run(request, context()));
    const queued = events.find((event) => event.kind === 'image.queued');

    expect(submissions).toBe(1);
    expect(events.map((event) => event.kind)).toEqual([
      'image.submitting',
      'image.queued',
      'image.failed',
    ]);
    expect(events.at(-1)).toMatchObject({ kind: 'image.failed', error: observationFailure });
    expect(queued?.kind).toBe('image.queued');
    if (queued?.kind !== 'image.queued') throw new Error('Expected queued event');
    await expect(created.journal.read(queued.job.journalId)).resolves.toMatchObject({
      status: 'failed',
      job: { upstreamJobId: 'prompt-1' },
      driverState: { clientId: 'client-1' },
    });
  });

  it('does not invoke a configured alternative when the selected target is missing', async () => {
    const alternativeSubmit = vi.fn();
    const alternative = compiled({
      mode: 'synchronous',
      submit: async function* () {
        alternativeSubmit();
        yield { kind: 'completed', usage: {} };
      },
    }, { providerId: 'other', modelId: 'other' });
    const created = await gateway(alternative);
    const events = await collect(created.gateway.run(request, context()));

    expect(alternativeSubmit).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      kind: 'image.failed',
      error: { localCode: 'MODEL_TARGET_NOT_FOUND' },
    });
  });
});

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

function pendingUntilAborted(signal: AbortSignal): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => rejectWhenAborted(signal),
    }),
  };
}
