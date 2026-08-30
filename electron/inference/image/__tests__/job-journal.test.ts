import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ImageRequest } from '../contracts.js';
import { ImageJobJournal } from '../job-journal.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-image-jobs-'));
  directories.push(directory);
  return path.join(directory, 'jobs');
}

function request(): ImageRequest {
  return {
    model: { providerId: 'local-comfy', modelId: 'workflow' },
    operation: { kind: 'generate', prompt: 'persist me' },
  };
}

describe('ImageJobJournal', () => {
  it('persists the exact target, revision, upstream job, request, and Driver state privately', async () => {
    const directory = await temporaryDirectory();
    const timestamps = [
      new Date('2026-07-29T04:00:00.000Z'),
      new Date('2026-07-29T04:01:00.000Z'),
    ];
    const journal = new ImageJobJournal(directory, () => timestamps.shift()!);
    const created = await journal.create({
      providerId: 'local-comfy',
      modelId: 'workflow',
      driverId: 'comfyui-workflow',
      configRevision: 12,
      upstreamJobId: 'prompt-123',
      resumable: true,
      request: request(),
      driverState: { clientId: 'client-123' },
    });

    expect(created).toMatchObject({
      job: {
        providerId: 'local-comfy',
        modelId: 'workflow',
        driverId: 'comfyui-workflow',
        configRevision: 12,
        upstreamJobId: 'prompt-123',
        resumable: true,
      },
      request: request(),
      driverState: { clientId: 'client-123' },
      status: 'observing',
      artifacts: [],
      usage: {},
      createdAt: '2026-07-29T04:00:00.000Z',
      updatedAt: '2026-07-29T04:00:00.000Z',
    });
    await expect(journal.read(created.journalId)).resolves.toEqual(created);
    await expect(journal.listResumable()).resolves.toEqual([created]);
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(directory, `${created.journalId}.json`))).mode & 0o777).toBe(0o600);

    const completed = await journal.update(created.journalId, {
      status: 'completed',
      artifacts: [{ artifactId: 'artifact:sha256:test', mimeType: 'image/png' }],
      usage: { imageCount: 1 },
    });
    expect(completed).toMatchObject({
      status: 'completed',
      updatedAt: '2026-07-29T04:01:00.000Z',
      usage: { imageCount: 1 },
    });
    await expect(journal.listResumable()).resolves.toEqual([]);
  });

  it('does not list non-resumable jobs and rejects invalid or corrupt journal records', async () => {
    const directory = await temporaryDirectory();
    const journal = new ImageJobJournal(directory);
    const created = await journal.create({
      providerId: 'provider',
      modelId: 'model',
      driverId: 'driver',
      configRevision: 1,
      upstreamJobId: 'upstream',
      resumable: false,
      request: request(),
    });
    await expect(journal.listResumable()).resolves.toEqual([]);
    await expect(journal.read('../../outside')).rejects.toMatchObject({ code: 'IMAGE_JOB_ID_INVALID' });

    await fs.writeFile(path.join(directory, `${created.journalId}.json`), '{"schemaVersion":1}', 'utf8');
    await expect(journal.read(created.journalId)).rejects.toMatchObject({ code: 'IMAGE_JOB_CORRUPT' });
  });
});

