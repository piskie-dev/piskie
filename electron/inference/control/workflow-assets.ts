import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const fieldBindingSchema = z.object({
  nodeId: z.string().min(1).describe('ComfyUI workflow node ID that owns the bound input field.'),
  field: z.string().min(1).describe('Input field name on the selected ComfyUI workflow node.'),
}).strip();

export const comfyWorkflowBindingsSchema = z.object({
  prompt: fieldBindingSchema.describe('Required workflow input that receives the generation or edit prompt.'),
  seed: fieldBindingSchema.optional().describe('Optional workflow input that receives a deterministic seed.'),
  width: fieldBindingSchema.optional().describe('Optional workflow input that receives requested image width.'),
  height: fieldBindingSchema.optional().describe('Optional workflow input that receives requested image height.'),
  batch: fieldBindingSchema.optional().describe('Optional workflow input that receives the requested image count.'),
  inputImages: z.array(fieldBindingSchema).min(1).optional()
    .describe('Workflow inputs that receive source or reference images.'),
  mask: fieldBindingSchema.optional().describe('Optional workflow input that receives an edit mask.'),
}).strip();

export type ComfyWorkflowBindings = z.infer<typeof comfyWorkflowBindingsSchema>;
export type ComfyFieldBinding = z.infer<typeof fieldBindingSchema>;

export interface ComfyWorkflowNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export type ComfyWorkflow = Record<string, ComfyWorkflowNode>;

export interface ComfyWorkflowAsset {
  id: string;
  sha256: string;
  filePath: string;
  workflow: ComfyWorkflow;
}

export interface WorkflowBindingIssue {
  code: 'WORKFLOW_NODE_NOT_FOUND' | 'WORKFLOW_FIELD_NOT_FOUND' | 'WORKFLOW_OUTPUT_NODE_NOT_FOUND';
  path: string;
  message: string;
}

export interface WorkflowBindingReport {
  valid: boolean;
  issues: readonly WorkflowBindingIssue[];
}

export class WorkflowAssetError extends Error {
  constructor(
    readonly code:
      | 'WORKFLOW_INVALID_JSON'
      | 'WORKFLOW_INVALID_API_FORMAT'
      | 'WORKFLOW_ASSET_ID_INVALID'
      | 'WORKFLOW_ASSET_NOT_FOUND'
      | 'WORKFLOW_ASSET_HASH_MISMATCH'
      | 'WORKFLOW_BINDINGS_INVALID',
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorkflowAssetError';
  }
}

export class ComfyWorkflowAssetStore {
  constructor(readonly directory: string) {}

  async import(source: string | unknown): Promise<ComfyWorkflowAsset> {
    const workflow = parseWorkflow(source);
    const encoded = `${canonicalJson(workflow)}\n`;
    const sha256 = crypto.createHash('sha256').update(encoded).digest('hex');
    const id = `comfyui:sha256:${sha256}`;
    const filePath = this.filePath(sha256);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(filePath, encoded, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (cause) {
      if (!isNodeError(cause, 'EEXIST')) throw cause;
      const existing = await fs.readFile(filePath, 'utf8');
      if (crypto.createHash('sha256').update(existing).digest('hex') !== sha256) {
        throw new WorkflowAssetError(
          'WORKFLOW_ASSET_HASH_MISMATCH',
          `Existing workflow asset does not match its content hash: ${id}`,
          { id, filePath },
        );
      }
    }
    return { id, sha256, filePath, workflow };
  }

  readSync(assetId: string): ComfyWorkflowAsset {
    const sha256 = parseAssetId(assetId);
    const filePath = this.filePath(sha256);
    let source: string;
    try {
      source = fsSync.readFileSync(filePath, 'utf8');
    } catch (cause) {
      if (isNodeError(cause, 'ENOENT')) {
        throw new WorkflowAssetError(
          'WORKFLOW_ASSET_NOT_FOUND',
          `ComfyUI workflow asset not found: ${assetId}`,
          { assetId, filePath },
          { cause },
        );
      }
      throw cause;
    }
    const actualHash = crypto.createHash('sha256').update(source).digest('hex');
    if (actualHash !== sha256) {
      throw new WorkflowAssetError(
        'WORKFLOW_ASSET_HASH_MISMATCH',
        `ComfyUI workflow asset hash mismatch: ${assetId}`,
        { assetId, expectedHash: sha256, actualHash },
      );
    }
    return { id: assetId, sha256, filePath, workflow: parseWorkflow(source) };
  }

  inspect(assetId: string): {
    id: string;
    sha256: string;
    nodes: readonly { nodeId: string; classType: string; fields: readonly string[]; title?: string }[];
  } {
    const asset = this.readSync(assetId);
    return {
      id: asset.id,
      sha256: asset.sha256,
      nodes: Object.entries(asset.workflow)
        .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
        .map(([nodeId, node]) => ({
          nodeId,
          classType: node.class_type,
          fields: Object.keys(node.inputs).sort(),
          ...(typeof node._meta?.title === 'string' && { title: node._meta.title }),
        })),
    };
  }

  detectBindings(assetId: string): Record<string, readonly ComfyFieldBinding[]> {
    const { workflow } = this.readSync(assetId);
    const candidates: Record<string, ComfyFieldBinding[]> = {
      prompt: [], seed: [], width: [], height: [], batch: [], inputImages: [], mask: [],
    };
    for (const [nodeId, node] of Object.entries(workflow)) {
      for (const field of Object.keys(node.inputs)) {
        const normalized = field.toLowerCase();
        const binding = { nodeId, field };
        if (normalized === 'text') candidates.prompt!.push(binding);
        if (normalized === 'seed' || normalized === 'noise_seed') candidates.seed!.push(binding);
        if (normalized === 'width') candidates.width!.push(binding);
        if (normalized === 'height') candidates.height!.push(binding);
        if (normalized === 'batch_size' || normalized === 'batch') candidates.batch!.push(binding);
        if (normalized === 'image' && /loadimage/i.test(node.class_type)) candidates.inputImages!.push(binding);
        if (normalized === 'mask' || (normalized === 'image' && /mask/i.test(node.class_type))) {
          candidates.mask!.push(binding);
        }
      }
    }
    return candidates;
  }

  validateBindings(
    assetId: string,
    bindings: ComfyWorkflowBindings,
    outputNodeIds: readonly string[],
  ): WorkflowBindingReport {
    const { workflow } = this.readSync(assetId);
    const issues: WorkflowBindingIssue[] = [];
    for (const [name, binding] of bindingEntries(bindings)) {
      const node = workflow[binding.nodeId];
      if (!node) {
        issues.push({
          code: 'WORKFLOW_NODE_NOT_FOUND',
          path: `/bindings/${name}/nodeId`,
          message: `Workflow node does not exist: ${binding.nodeId}`,
        });
      } else if (!Object.hasOwn(node.inputs, binding.field)) {
        issues.push({
          code: 'WORKFLOW_FIELD_NOT_FOUND',
          path: `/bindings/${name}/field`,
          message: `Workflow node ${binding.nodeId} has no writable input field ${binding.field}`,
        });
      }
    }
    outputNodeIds.forEach((nodeId, index) => {
      if (!workflow[nodeId]) {
        issues.push({
          code: 'WORKFLOW_OUTPUT_NODE_NOT_FOUND',
          path: `/outputNodeIds/${index}`,
          message: `Workflow output node does not exist: ${nodeId}`,
        });
      }
    });
    return { valid: issues.length === 0, issues };
  }

  materialize(
    assetId: string,
    bindings: ComfyWorkflowBindings,
    outputNodeIds: readonly string[],
    values: Partial<Record<keyof ComfyWorkflowBindings, unknown>> & { inputImages?: readonly string[] },
  ): ComfyWorkflow {
    const report = this.validateBindings(assetId, bindings, outputNodeIds);
    if (!report.valid) {
      throw new WorkflowAssetError(
        'WORKFLOW_BINDINGS_INVALID',
        `ComfyUI workflow bindings are invalid for ${assetId}`,
        { issues: report.issues },
      );
    }
    const workflow = structuredClone(this.readSync(assetId).workflow);
    for (const name of ['prompt', 'seed', 'width', 'height', 'batch', 'mask'] as const) {
      const binding = bindings[name];
      const value = values[name];
      if (binding && value !== undefined) workflow[binding.nodeId]!.inputs[binding.field] = value;
    }
    if (bindings.inputImages && values.inputImages) {
      bindings.inputImages.forEach((binding, index) => {
        const value = values.inputImages?.[index];
        if (value !== undefined) workflow[binding.nodeId]!.inputs[binding.field] = value;
      });
    }
    return workflow;
  }

  private filePath(sha256: string): string {
    return path.join(this.directory, `${sha256}.json`);
  }
}

function parseWorkflow(source: string | unknown): ComfyWorkflow {
  let raw = source;
  if (typeof source === 'string') {
    try {
      raw = JSON.parse(source);
    } catch (cause) {
      throw new WorkflowAssetError('WORKFLOW_INVALID_JSON', 'ComfyUI workflow is not valid JSON', {}, { cause });
    }
  }
  if (!isRecord(raw) || Object.keys(raw).length === 0) {
    throw new WorkflowAssetError(
      'WORKFLOW_INVALID_API_FORMAT',
      'ComfyUI workflow must be a non-empty Save (API Format) object',
    );
  }
  const workflow: ComfyWorkflow = {};
  for (const [nodeId, candidate] of Object.entries(raw)) {
    if (!isRecord(candidate)
      || typeof candidate.class_type !== 'string'
      || candidate.class_type.length === 0
      || !isRecord(candidate.inputs)) {
      throw new WorkflowAssetError(
        'WORKFLOW_INVALID_API_FORMAT',
        `ComfyUI node ${nodeId} must contain class_type and inputs`,
        { nodeId },
      );
    }
    workflow[nodeId] = {
      class_type: candidate.class_type,
      inputs: candidate.inputs,
      ...(isRecord(candidate._meta) && { _meta: candidate._meta }),
    };
  }
  return workflow;
}

function parseAssetId(assetId: string): string {
  const match = /^comfyui:sha256:([a-f0-9]{64})$/.exec(assetId);
  if (!match) throw new WorkflowAssetError('WORKFLOW_ASSET_ID_INVALID', `Invalid ComfyUI workflow asset ID: ${assetId}`);
  return match[1]!;
}

function bindingEntries(bindings: ComfyWorkflowBindings): [string, ComfyFieldBinding][] {
  const entries: [string, ComfyFieldBinding][] = [];
  for (const name of ['prompt', 'seed', 'width', 'height', 'batch', 'mask'] as const) {
    const binding = bindings[name];
    if (binding) entries.push([name, binding]);
  }
  bindings.inputImages?.forEach((binding, index) => entries.push([`inputImages/${index}`, binding]));
  return entries;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('Workflow contains a non-JSON value');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
