import { z } from 'zod';
import { comfyWorkflowBindingsSchema } from '../../control/workflow-assets.js';

export const comfyProviderOptionsSchema = z.object({
  historyPollIntervalMs: z.number().int().min(25).max(60_000).default(500)
    .describe('Milliseconds between ComfyUI history polls while waiting for an accepted workflow job.'),
}).strip();

export const comfyModelOptionsSchema = z.object({
  workflowAssetId: z.string().regex(/^comfyui:sha256:[a-f0-9]{64}$/)
    .describe('Immutable content-addressed ID returned when the ComfyUI API workflow was imported.'),
  bindings: comfyWorkflowBindingsSchema
    .describe('Validated mapping from Piskie image request fields to ComfyUI workflow inputs.'),
  outputNodeIds: z.array(
    z.string().min(1).describe('ComfyUI node ID whose image outputs Piskie must collect.'),
  ).min(1).describe('Workflow output nodes that produce the final image artifacts.'),
}).strip();

export const comfyRequestExtensionSchema = z.object({
  seed: z.number().int().nonnegative().optional()
    .describe('Optional request-specific seed written through the configured seed binding.'),
}).strict();

export type ComfyModelOptions = z.infer<typeof comfyModelOptionsSchema>;
export type ComfyRequestExtension = z.infer<typeof comfyRequestExtensionSchema>;
