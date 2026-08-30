import { z } from 'zod';
import { INFERENCE_OPERATIONS } from '../../../shared/electron-contracts/inference.js';
import type { InferenceRuntimeHost } from '../../inference/composition/runtime-host.js';
import { readArtifactPreview } from '../../inference/application/artifact-preview.js';
import type { OperationDefinition } from '../catalog.js';
import { args, identifier, plainRecord } from '../validation.js';

const querySchema = z.object({
  gateway: z.enum(['ai', 'image']),
  operation: z.enum(['generate', 'edit']).optional(),
});
const probeSchema = z.object({
  level: z.enum(['connectivity', 'smoke']),
  target: z.object({
    providerId: identifier.optional(),
    modelId: identifier.optional(),
  }).optional(),
});

export function createInferenceController(host: InferenceRuntimeHost): readonly OperationDefinition[] {
  return Object.freeze([
    operation(INFERENCE_OPERATIONS.listDrivers, args([]), () => host.control.drivers()),
    operation(INFERENCE_OPERATIONS.driverSchema, args([identifier]), ([driverId]) => (
      host.control.driverSchema(driverId)
    )),
    operation(INFERENCE_OPERATIONS.queryModels, args([querySchema]), ([input]) => (
      host.control.models(input.gateway, input.operation)
    )),
    operation(INFERENCE_OPERATIONS.importWorkflow, args([z.string().min(1).max(32 * 1024 * 1024)]), async ([source]) => {
      const asset = await host.control.importComfyWorkflow(source);
      return { id: asset.id, sha256: asset.sha256 };
    }),
    operation(INFERENCE_OPERATIONS.inspectWorkflow, args([identifier]), ([assetId]) => (
      host.control.inspectComfyWorkflow(assetId)
    )),
    operation(INFERENCE_OPERATIONS.detectBindings, args([identifier]), ([assetId]) => (
      host.control.detectComfyWorkflowBindings(assetId)
    )),
    operation(
      INFERENCE_OPERATIONS.validateBindings,
      args([z.object({
        assetId: identifier,
        bindings: plainRecord,
        outputNodeIds: z.array(identifier).max(1_000),
      })]),
      ([input]) => host.control.validateComfyWorkflowBindings(
        input.assetId,
        input.bindings,
        input.outputNodeIds,
      ),
    ),
    operation(INFERENCE_OPERATIONS.probe, args([probeSchema]), ([input]) => (
      host.control.probeCurrent(input.level, input.target)
    )),
    operation(INFERENCE_OPERATIONS.artifact, args([identifier]), ([artifactId]) => (
      readArtifactPreview(host.artifacts, artifactId)
    )),
  ]);
}

function operation(
  id: string,
  input: z.ZodType<unknown[]>,
  execute: (input: any[]) => unknown,
): OperationDefinition<unknown[]> {
  return {
    id,
    capability: 'inference',
    input,
    execute: (_context, value) => execute(value),
  };
}
