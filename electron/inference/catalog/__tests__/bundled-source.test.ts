import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bundledInferenceCatalog,
  ensureBundledInferenceCatalog,
} from '../bundled-source.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe('bundled inference catalog', () => {
  it('rewrites a stale base snapshot when unified provider content changes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-bundled-catalog-'));
    directories.push(root);
    const catalogDirectory = path.join(root, 'catalog');
    const baseFile = path.join(catalogDirectory, 'models.json');
    await fs.mkdir(catalogDirectory, { recursive: true });
    await fs.writeFile(baseFile, JSON.stringify({
      version: 'piskie-inference-v2:version-without-content-hash',
      models: [],
    }));

    const paths = await ensureBundledInferenceCatalog(root);
    const stored = JSON.parse(await fs.readFile(paths.baseFile, 'utf8')) as {
      version: string;
      models: unknown[];
    };

    expect(stored.version).toBe(bundledInferenceCatalog().version);
    expect(stored.version).toMatch(/^piskie-inference-v3:.+:[a-f0-9]{16}$/);
    expect(stored.models.length).toBeGreaterThan(0);
  });

  it('projects known OpenAI models with the five user-facing effort levels', () => {
    const model = bundledInferenceCatalog().models.find((entry) => entry.id === 'openai/gpt-5.4-mini');

    expect(model?.reasoning?.options.filter((option) => option.kind === 'effort')).toEqual([
      { kind: 'effort', effort: 'low' },
      { kind: 'effort', effort: 'medium' },
      { kind: 'effort', effort: 'high' },
      { kind: 'effort', effort: 'xhigh' },
      { kind: 'effort', effort: 'max' },
    ]);
  });
});
