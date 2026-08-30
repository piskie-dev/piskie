import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ComfyWorkflowAssetStore,
  WorkflowAssetError,
  type ComfyWorkflowBindings,
} from '../workflow-assets.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

async function store(): Promise<ComfyWorkflowAssetStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-workflow-'));
  temporaryDirectories.push(directory);
  return new ComfyWorkflowAssetStore(directory);
}

function workflow() {
  return {
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'Piskie', images: ['8', 0] } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'old prompt', clip: ['4', 1] } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    '10': { class_type: 'LoadImage', inputs: { image: 'old.png', upload: 'image' } },
    '3': { class_type: 'KSampler', inputs: { seed: 1, steps: 8 } },
  };
}

const bindings: ComfyWorkflowBindings = {
  prompt: { nodeId: '6', field: 'text' },
  seed: { nodeId: '3', field: 'seed' },
  width: { nodeId: '5', field: 'width' },
  height: { nodeId: '5', field: 'height' },
  batch: { nodeId: '5', field: 'batch_size' },
  inputImages: [{ nodeId: '10', field: 'image' }],
};

describe('ComfyWorkflowAssetStore', () => {
  it('imports API-format workflows by canonical content hash and reuses identical assets', async () => {
    const assets = await store();
    const first = await assets.import(workflow());
    const reordered = Object.fromEntries(Object.entries(workflow()).reverse());
    const second = await assets.import(reordered);

    expect(first.id).toMatch(/^comfyui:sha256:[a-f0-9]{64}$/);
    expect(second.id).toBe(first.id);
    expect(assets.inspect(first.id).nodes.map((node) => node.nodeId)).toEqual(['3', '5', '6', '9', '10']);
    expect((await fs.stat(first.filePath)).mode & 0o777).toBe(0o600);
  });

  it('validates binding targets and materializes an isolated workflow clone', async () => {
    const assets = await store();
    const asset = await assets.import(workflow());

    expect(assets.validateBindings(asset.id, bindings, ['9'])).toEqual({ valid: true, issues: [] });
    const materialized = assets.materialize(asset.id, bindings, ['9'], {
      prompt: 'new prompt',
      seed: 42,
      width: 1024,
      height: 768,
      batch: 2,
      inputImages: ['uploaded/input.png'],
    });

    expect(materialized['6']!.inputs.text).toBe('new prompt');
    expect(materialized['3']!.inputs.seed).toBe(42);
    expect(materialized['5']!.inputs).toMatchObject({ width: 1024, height: 768, batch_size: 2 });
    expect(materialized['10']!.inputs.image).toBe('uploaded/input.png');
    expect(assets.readSync(asset.id).workflow['6']!.inputs.text).toBe('old prompt');
  });

  it('returns binding suggestions without silently selecting them', async () => {
    const assets = await store();
    const asset = await assets.import(workflow());
    const detected = assets.detectBindings(asset.id);

    expect(detected).toMatchObject({
      prompt: [{ nodeId: '6', field: 'text' }],
      seed: [{ nodeId: '3', field: 'seed' }],
      inputImages: [{ nodeId: '10', field: 'image' }],
    });
  });

  it('rejects UI-format documents and dangling fields', async () => {
    const assets = await store();
    await expect(assets.import({ nodes: [], links: [] })).rejects.toMatchObject<WorkflowAssetError>({
      code: 'WORKFLOW_INVALID_API_FORMAT',
    });
    const asset = await assets.import(workflow());
    expect(assets.validateBindings(asset.id, {
      ...bindings,
      prompt: { nodeId: '6', field: 'missing' },
    }, ['404'])).toMatchObject({
      valid: false,
      issues: [
        { code: 'WORKFLOW_FIELD_NOT_FOUND', path: '/bindings/prompt/field' },
        { code: 'WORKFLOW_OUTPUT_NODE_NOT_FOUND', path: '/outputNodeIds/0' },
      ],
    });
  });
});
