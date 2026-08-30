import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactStoreError, LocalImageArtifactStore } from '../artifact-store.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-artifacts-'));
  directories.push(directory);
  return directory;
}

describe('LocalImageArtifactStore', () => {
  it('writes content-addressed private files and returns verified bytes and metadata', async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, 'store');
    const now = new Date('2026-07-29T02:00:00.000Z');
    const store = new LocalImageArtifactStore(directory, { now: () => now });
    const bytes = Buffer.from('stable artifact bytes');
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

    const stored = await store.write({
      bytes,
      mimeType: 'image/png',
      fileName: 'result.png',
      metadata: { width: 16, height: 8 },
    });

    expect(stored).toEqual({
      ref: { artifactId: `artifact:sha256:${sha256}` },
      mimeType: 'image/png',
      fileName: 'result.png',
      byteLength: bytes.byteLength,
      sha256,
      metadata: { width: 16, height: 8 },
      createdAt: now.toISOString(),
    });
    await expect(store.read(stored.ref)).resolves.toMatchObject({
      bytes: new Uint8Array(bytes),
      mimeType: 'image/png',
      fileName: 'result.png',
    });
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(directory, `${sha256}.bin`))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.join(directory, `${sha256}.json`))).mode & 0o777).toBe(0o600);
  });

  it('detects byte corruption before returning an artifact', async () => {
    const directory = path.join(await temporaryDirectory(), 'store');
    const store = new LocalImageArtifactStore(directory);
    const stored = await store.write({ bytes: Buffer.from('original'), mimeType: 'image/webp' });
    await fs.writeFile(path.join(directory, `${stored.sha256}.bin`), 'tampered');

    await expect(store.read(stored.ref)).rejects.toMatchObject<Partial<ArtifactStoreError>>({
      code: 'ARTIFACT_CORRUPT',
      details: { artifactId: stored.ref.artifactId, expectedHash: stored.sha256 },
    });
  });

  it('rejects invalid IDs, missing metadata, and expired artifacts with stable codes', async () => {
    const directory = path.join(await temporaryDirectory(), 'store');
    let now = new Date('2026-07-29T03:00:00.000Z');
    const store = new LocalImageArtifactStore(directory, { now: () => now });
    const stored = await store.write({
      bytes: Buffer.from('expiring'),
      mimeType: 'image/png',
      expiresAt: '2026-07-29T03:01:00.000Z',
    });

    await expect(store.info({ artifactId: '../outside' })).rejects.toMatchObject({ code: 'ARTIFACT_ID_INVALID' });
    await expect(store.info({ artifactId: `artifact:sha256:${'0'.repeat(64)}` }))
      .rejects.toMatchObject({ code: 'ARTIFACT_NOT_FOUND' });
    now = new Date('2026-07-29T03:01:00.000Z');
    await expect(store.read(stored.ref)).rejects.toMatchObject({ code: 'ARTIFACT_EXPIRED' });
  });
});

