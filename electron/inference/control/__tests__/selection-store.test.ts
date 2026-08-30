import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inferenceConfigPaths } from '../config-repository.js';
import { InferenceSelectionStore } from '../selection-store.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

describe('InferenceSelectionStore', () => {
  it('ignores unknown persisted fields without accepting invalid known fields', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-inference-selection-'));
    directories.push(root);
    const paths = inferenceConfigPaths(root);
    await fs.mkdir(path.dirname(paths.selectionFile), { recursive: true });
    await fs.writeFile(paths.selectionFile, JSON.stringify({
      schemaVersion: 1,
      revision: 3,
      futureDocumentField: true,
      ai: {
        providerId: 'ai-main',
        modelId: 'chat-main',
        futureTargetField: true,
      },
    }));

    await expect(new InferenceSelectionStore(paths).read()).resolves.toEqual({
      schemaVersion: 1,
      revision: 3,
      ai: {
        providerId: 'ai-main',
        modelId: 'chat-main',
      },
    });
    expect(await fs.readFile(paths.selectionFile, 'utf8')).toContain('futureDocumentField');

    await fs.writeFile(paths.selectionFile, JSON.stringify({
      schemaVersion: 1,
      revision: 'invalid',
    }));
    await expect(new InferenceSelectionStore(paths).read()).rejects.toThrow(/number/i);
  });

  it('reads canonical state and switches runtime reads to the ConfigHost publication', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-inference-selection-'));
    directories.push(root);
    const paths = inferenceConfigPaths(root);
    await fs.mkdir(path.dirname(paths.selectionFile), { recursive: true });
    await fs.writeFile(paths.selectionFile, JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      ai: { providerId: 'ai-main', modelId: 'chat-main' },
      image: { providerId: 'image-main', modelId: 'image-main' },
    }));
    const store = new InferenceSelectionStore(paths);
    await expect(store.read()).resolves.toMatchObject({ revision: 1 });

    store.publishSelections({
      schemaVersion: 1,
      revision: 2,
      ai: { providerId: 'ai-main', modelId: 'chat-new' },
    });
    await expect(store.read()).resolves.toEqual({
      schemaVersion: 1,
      revision: 2,
      ai: { providerId: 'ai-main', modelId: 'chat-new' },
    });
    expect(await fs.readFile(paths.selectionFile, 'utf8')).toContain('chat-main');
  });
});
