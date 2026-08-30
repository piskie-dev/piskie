import type { ComfyWorkflow } from '../../control/workflow-assets.js';
import type { ImageRequest } from '../../image/contracts.js';
import {
  comfyRequestExtensionSchema,
  type ComfyModelOptions,
  type ComfyRequestExtension,
} from './options.js';

export class ComfySerializationError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ComfySerializationError';
  }
}

export interface ComfyRequestPlan {
  extension: ComfyRequestExtension;
  sourceCount: number;
  hasMask: boolean;
}

export function planComfyRequest(
  request: ImageRequest,
  options: ComfyModelOptions,
): ComfyRequestPlan {
  const rawExtension = request.extensions?.['comfyui-workflow'];
  const parsedExtension = comfyRequestExtensionSchema.safeParse(rawExtension ?? {});
  if (!parsedExtension.success) {
    throw new ComfySerializationError(
      'COMFYUI_EXTENSION_INVALID',
      `extensions.comfyui-workflow is invalid: ${parsedExtension.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  }

  const operation = request.operation;
  positiveInteger(operation.count, 'count');
  positiveInteger(operation.output?.width, 'output.width');
  positiveInteger(operation.output?.height, 'output.height');
  requireBinding(operation.count, options.bindings.batch, 'count', 'batch');
  requireBinding(operation.output?.width, options.bindings.width, 'output.width', 'width');
  requireBinding(operation.output?.height, options.bindings.height, 'output.height', 'height');
  requireBinding(parsedExtension.data.seed, options.bindings.seed, 'seed', 'seed');

  const unsupportedOutput = Object.entries({
    'output.aspectRatio': operation.output?.aspectRatio,
    'output.quality': operation.output?.quality,
    'output.format': operation.output?.format,
    'output.background': operation.output?.background,
  }).find(([, value]) => value !== undefined);
  if (unsupportedOutput) {
    throw new ComfySerializationError(
      'COMFYUI_OUTPUT_FIELD_UNMAPPED',
      `ComfyUI workflow has no binding contract for ${unsupportedOutput[0]}`,
    );
  }

  if (operation.kind === 'generate') {
    return { extension: parsedExtension.data, sourceCount: 0, hasMask: false };
  }
  if (operation.sources.length === 0) {
    throw new ComfySerializationError('COMFYUI_EDIT_SOURCE_REQUIRED', 'ComfyUI image edit requires at least one source');
  }
  const inputBindings = options.bindings.inputImages ?? [];
  if (operation.sources.length > inputBindings.length) {
    throw new ComfySerializationError(
      'COMFYUI_INPUT_BINDINGS_INSUFFICIENT',
      `ComfyUI workflow has ${inputBindings.length} input image bindings for ${operation.sources.length} sources`,
    );
  }
  if (operation.mask && !options.bindings.mask) {
    throw new ComfySerializationError(
      'COMFYUI_MASK_BINDING_MISSING',
      'ComfyUI edit request includes a mask but the workflow has no mask binding',
    );
  }
  return {
    extension: parsedExtension.data,
    sourceCount: operation.sources.length,
    hasMask: operation.mask !== undefined,
  };
}

export function materializeComfyRequest(
  template: ComfyWorkflow,
  request: ImageRequest,
  options: ComfyModelOptions,
  plan: ComfyRequestPlan,
  uploadedSources: readonly string[],
  uploadedMask?: string,
): ComfyWorkflow {
  if (uploadedSources.length !== plan.sourceCount || (uploadedMask !== undefined) !== plan.hasMask) {
    throw new ComfySerializationError(
      'COMFYUI_UPLOAD_RESULT_MISMATCH',
      'Uploaded ComfyUI inputs do not match the prepared request',
    );
  }
  const workflow = structuredClone(template);
  setBoundValue(workflow, options.bindings.prompt, request.operation.prompt);
  setBoundValue(workflow, options.bindings.seed, plan.extension.seed);
  setBoundValue(workflow, options.bindings.width, request.operation.output?.width);
  setBoundValue(workflow, options.bindings.height, request.operation.output?.height);
  setBoundValue(workflow, options.bindings.batch, request.operation.count);
  options.bindings.inputImages?.forEach((binding, index) => {
    setBoundValue(workflow, binding, uploadedSources[index]);
  });
  setBoundValue(workflow, options.bindings.mask, uploadedMask);
  return workflow;
}

function setBoundValue(
  workflow: ComfyWorkflow,
  binding: { nodeId: string; field: string } | undefined,
  value: unknown,
): void {
  if (!binding || value === undefined) return;
  const node = workflow[binding.nodeId];
  if (!node || !Object.hasOwn(node.inputs, binding.field)) {
    throw new ComfySerializationError(
      'COMFYUI_BINDING_INVALID',
      `ComfyUI binding ${binding.nodeId}.${binding.field} is unavailable in the compiled workflow`,
    );
  }
  node.inputs[binding.field] = value;
}

function requireBinding(
  value: unknown,
  binding: unknown,
  requestField: string,
  bindingName: string,
): void {
  if (value !== undefined && binding === undefined) {
    throw new ComfySerializationError(
      'COMFYUI_BINDING_MISSING',
      `ComfyUI request field ${requestField} requires the ${bindingName} workflow binding`,
    );
  }
}

function positiveInteger(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new ComfySerializationError('COMFYUI_VALUE_INVALID', `${field} must be a positive integer`);
  }
}

