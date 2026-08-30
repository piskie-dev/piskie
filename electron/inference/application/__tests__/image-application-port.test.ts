import { describe, expect, it, vi } from 'vitest';
import type { ImageGateway, ImageRequest } from '../../image/contracts.js';
import { MemoryArtifactStore, toImageArtifact } from '../../image/artifact-store.js';
import { RuntimeSnapshotStore, type InferenceRuntimeSnapshot } from '../../execution/runtime-snapshot.js';
import { DefaultImageApplicationPort } from '../image-application-port.js';

const model = { providerId: 'images-main', modelId: 'image-selected' };

function snapshot(): RuntimeSnapshotStore {
  const snapshots = new RuntimeSnapshotStore();
  snapshots.publish({
    configRevision: 7,
    catalogVersion: 'test',
    targets: new Map([[model.providerId, new Map([[model.modelId, {
      ref: model,
      driverId: 'fake-images',
      upstreamModel: 'wire-image-model',
      catalogId: 'catalog/image',
      configRevision: 7,
      image: {
        submit: async () => ({ kind: 'rejected', error: new Error('unused') as never }),
        observe: async function* () {},
      },
    }]])]]),
    policies: {
      ai: {
        maxAttempts: 1,
        connectTimeoutMs: 1_000,
        streamIdleTimeoutMs: 1_000,
        retryBaseDelayMs: 0,
      },
      image: {
        maxSubmitAttempts: 1,
        submitTimeoutMs: 1_000,
        operationTimeoutMs: 1_000,
        allowResubmitAfterAccepted: false,
      },
    },
    createdAt: new Date(0).toISOString(),
  } satisfies InferenceRuntimeSnapshot);
  return snapshots;
}

describe('DefaultImageApplicationPort', () => {
  it('passes the exact target and projects generated artifacts as bytes', async () => {
    const artifacts = new MemoryArtifactStore();
    const stored = await artifacts.write({
      bytes: Uint8Array.from([1, 2, 3]),
      mimeType: 'image/png',
      metadata: { width: 32, height: 48, revisedPrompt: 'upstream prompt' },
    });
    const complete = vi.fn(async (request: ImageRequest) => ({
      runId: 'upstream-run',
      model: request.model,
      configRevision: 7,
      artifacts: [toImageArtifact(stored)],
      usage: { imageCount: 1 },
    }));
    const port = new DefaultImageApplicationPort(
      { complete } as unknown as ImageGateway,
      snapshot(),
      artifacts,
    );

    expect(port.hasTarget(model)).toBe(true);
    const result = await port.execute({
      model,
      prompt: 'draw exactly this',
      size: '32x48',
      quality: 'high',
    });

    expect(complete).toHaveBeenCalledWith(
      {
        model,
        operation: {
          kind: 'generate',
          prompt: 'draw exactly this',
          output: { width: 32, height: 48, quality: 'high' },
        },
      },
      expect.objectContaining({ runId: expect.any(String), traceId: expect.any(String) }),
    );
    expect(result.images[0]).toMatchObject({
      artifactId: stored.ref.artifactId,
      mimeType: 'image/png',
      width: 32,
      height: 48,
      revisedPrompt: 'upstream prompt',
    });
    expect(result.images[0]!.bytes).toEqual(Uint8Array.from([1, 2, 3]));
  });

  it('stores every reference and sends edit even when catalog capability is absent', async () => {
    const artifacts = new MemoryArtifactStore();
    const output = await artifacts.write({ bytes: Uint8Array.from([9]), mimeType: 'image/webp' });
    let captured: ImageRequest | undefined;
    const port = new DefaultImageApplicationPort({
      complete: async (request) => {
        captured = request;
        return {
          runId: 'edit-run',
          model: request.model,
          configRevision: 7,
          artifacts: [toImageArtifact(output)],
          usage: { imageCount: 1 },
        };
      },
    } as ImageGateway, snapshot(), artifacts);

    await port.execute({
      model,
      prompt: 'keep composition',
      sources: [
        { bytes: Uint8Array.from([1]), mimeType: 'image/png' },
        { bytes: Uint8Array.from([2]), mimeType: 'image/jpeg' },
      ],
    });

    expect(captured?.model).toEqual(model);
    expect(captured?.operation.kind).toBe('edit');
    if (captured?.operation.kind !== 'edit') throw new Error('expected edit');
    expect(captured.operation.sources).toHaveLength(2);
    await expect(artifacts.read(captured.operation.sources[0]!)).resolves.toMatchObject({
      bytes: Uint8Array.from([1]),
      mimeType: 'image/png',
    });
    await expect(artifacts.read(captured.operation.sources[1]!)).resolves.toMatchObject({
      bytes: Uint8Array.from([2]),
      mimeType: 'image/jpeg',
    });
  });
});
