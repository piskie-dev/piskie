import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readArtifactPreview } from '../application/artifact-preview.js';
import type { ModelTarget } from '../execution/contracts.js';
import { createLiveRuntime, parseLiveTargets } from './runtime.js';

const live = process.env.PISKIE_LIVE_IMAGE === '1';

describe.skipIf(!live)('live image inference', () => {
  it('probes the exact selected model through Image Gateway and returns a previewable artifact', async () => {
    const runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-live-image-'));
    const host = createLiveRuntime({ runtimeDirectory });
    try {
      await host.initialize();
      const selections = await host.selections.read();
      const target = process.env.PISKIE_LIVE_IMAGE_TARGET
        ? parseLiveTargets(process.env.PISKIE_LIVE_IMAGE_TARGET, 'PISKIE_LIVE_IMAGE_TARGET')[0]!
        : requiredImageTarget(selections.image);
      const compiled = host.control.runtime.capture()?.targets
        .get(target.providerId)?.get(target.modelId);
      if (!compiled?.image) throw new Error(`Selected image target is not compiled: ${target.providerId}/${target.modelId}`);
      const startedAt = Date.now();
      const receipts = await host.control.probeCurrent(
        'smoke',
        target,
        AbortSignal.timeout(600_000),
      );
      const receipt = receipts[0];

      expect(receipt).toMatchObject({
        providerId: target.providerId,
        modelId: target.modelId,
        driverId: compiled.driverId,
        level: 'smoke',
        success: true,
      });
      expect(receipt?.artifacts?.length).toBeGreaterThan(0);
      const artifacts = [];
      for (const artifact of receipt?.artifacts ?? []) {
        const payload = await host.artifacts.read({ artifactId: artifact.artifactId });
        const sha256 = crypto.createHash('sha256').update(payload.bytes).digest('hex');
        const preview = await readArtifactPreview(host.artifacts, artifact.artifactId);
        const bytesFile = path.join(host.artifacts.directory, `${sha256}.bin`);
        const metadataFile = path.join(host.artifacts.directory, `${sha256}.json`);
        const [bytesStat, metadataStat] = await Promise.all([fs.stat(bytesFile), fs.stat(metadataFile)]);
        expect(payload.mimeType).toMatch(/^image\//);
        expect(payload.bytes.byteLength).toBeGreaterThan(0);
        expect(bytesStat.isFile()).toBe(true);
        expect(bytesStat.size).toBe(payload.bytes.byteLength);
        expect(metadataStat.isFile()).toBe(true);
        expect(artifact.width).toBeGreaterThan(0);
        expect(artifact.height).toBeGreaterThan(0);
        expect(artifact.byteLength).toBe(payload.bytes.byteLength);
        expect(artifact.sha256).toBe(sha256);
        expect(preview).toMatchObject({ artifactId: artifact.artifactId, mimeType: payload.mimeType });
        expect(preview.dataUrl).toMatch(/^data:image\/[^;]+;base64,/);
        artifacts.push({
          artifactId: artifact.artifactId,
          mimeType: payload.mimeType,
          width: artifact.width,
          height: artifact.height,
          byteLength: payload.bytes.byteLength,
          sha256,
          previewDataUrlLength: preview.dataUrl.length,
        });
      }
      console.info(JSON.stringify({
        gateway: 'image',
        target,
        driverId: compiled.driverId,
        configRevision: host.control.runtime.capture()?.configRevision,
        artifacts,
        elapsedMs: Date.now() - startedAt,
      }));
    } finally {
      await host.close();
      await fs.rm(runtimeDirectory, { recursive: true, force: true });
    }
  }, 900_000);
});

function requiredImageTarget(target?: ModelTarget): ModelTarget {
  if (!target) throw new Error('No exact image selection is configured');
  return target;
}
