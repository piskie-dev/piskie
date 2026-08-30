import { z } from 'zod';
import { MIN_CONTEXT_WINDOW } from '../../../shared/constants/token.js';

const reasoningSelectionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('provider-default')
      .describe('Use the upstream Provider or model default reasoning behavior.'),
  }).strip(),
  z.object({
    kind: z.literal('disabled')
      .describe('Explicitly disable reasoning for this model binding.'),
  }).strip(),
  z.object({
    kind: z.literal('enabled')
      .describe('Enable reasoning while leaving its strength or budget to the Provider.'),
  }).strip(),
  z.object({
    kind: z.literal('effort')
      .describe('Control reasoning with a Provider-supported effort level.'),
    effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
      .describe('Reasoning effort requested from the selected model.'),
  }).strip(),
  z.object({
    kind: z.literal('budget')
      .describe('Control reasoning with an explicit token budget.'),
    tokens: z.number().int().positive()
      .describe('Maximum reasoning-token budget requested from the selected model.'),
  }).strip(),
]);

export const reasoningProfileSchema = z.object({
  mode: z.enum(['none', 'fixed', 'toggle', 'effort', 'budget', 'effort-or-budget'])
    .describe('Reasoning controls that this model exposes.'),
  options: z.array(reasoningSelectionSchema.describe('Supported reasoning selection.')).min(1)
    .describe('Reasoning selections accepted by this model.'),
  defaultSelection: reasoningSelectionSchema
    .describe('Reasoning selection used when a binding does not override it.'),
  mandatory: z.boolean().describe('Whether reasoning must remain enabled for this model.'),
  transportPreset: z.enum([
    'none',
    'openai-effort',
    'openai-reasoning-object',
    'anthropic-adaptive-effort',
    'anthropic-budget',
    'gemini-effort',
    'deepseek-thinking',
    'dashscope-enable-thinking',
    'minimax-thinking',
    'volcengine-reasoning',
    'together-reasoning',
    'fireworks-reasoning',
    'openrouter-reasoning',
    'ollama-think',
  ]).describe('Driver mapping used to encode the reasoning selection.'),
  replayPolicy: z.enum(['none', 'visible', 'opaque-required'])
    .describe('How prior reasoning content must be replayed in follow-up requests.'),
  minBudgetTokens: z.number().int().positive()
    .describe('Minimum explicit reasoning-token budget.').optional(),
  maxBudgetTokens: z.number().int().positive()
    .describe('Maximum explicit reasoning-token budget.').optional(),
}).strip().describe('Reasoning capabilities and transport behavior for a model.');

export const modelCapabilitiesSchema = z.object({
  streaming: z.boolean().describe('Whether the model supports streamed responses.').optional(),
  tools: z.boolean().describe('Whether the model supports tool calls.').optional(),
  vision: z.boolean().describe('Whether the model accepts image inputs.').optional(),
  reasoning: z.boolean().describe('Whether the model supports reasoning controls.').optional(),
  structuredOutput: z.boolean().describe('Whether the model supports structured output.').optional(),
  generate: z.boolean().describe('Whether the image model supports generation.').optional(),
  edit: z.boolean().describe('Whether the image model supports editing.').optional(),
  referenceImages: z.boolean().describe('Whether the image model accepts reference images.').optional(),
  mask: z.boolean().describe('Whether the image model accepts edit masks.').optional(),
}).strip().describe('Declared model capabilities used for selection and UI guidance.');

export const modelLimitsSchema = z.object({
  contextWindow: z.number().int().positive().describe('Maximum context-window tokens.').optional(),
  maxOutputTokens: z.number().int().positive().describe('Maximum output tokens.').optional(),
  maxImages: z.number().int().positive().describe('Maximum images accepted or produced.').optional(),
  sizes: z.array(z.string().trim().min(1).describe('Supported image size.'))
    .describe('Supported image sizes.').optional(),
  formats: z.array(z.enum(['png', 'jpeg', 'webp']).describe('Supported image format.'))
    .describe('Supported image output formats.').optional(),
}).strip().describe('Known model input and output limits.');

export const aiModelLimitsSchema = modelLimitsSchema.extend({
  contextWindow: z.number().int().min(MIN_CONTEXT_WINDOW)
    .describe('Maximum context-window tokens required for AI model execution.'),
});

export const modelDefinitionSchema = z.object({
  id: z.string().trim().min(1).describe('Stable model Catalog ID.'),
  displayName: z.string().trim().min(1).describe('User-visible model name.'),
  kind: z.enum(['ai', 'image']).describe('Gateway kind supported by this model.'),
  family: z.string().trim().min(1).describe('Optional model family or Provider family.').optional(),
  releaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe('Optional model release date in YYYY-MM-DD form.').optional(),
  lifecycle: z.enum(['preview', 'active', 'deprecated', 'retired'])
    .default('active').describe('Current model lifecycle state.'),
  compatibleDrivers: z.array(z.string().trim().min(1).describe('Compatible inference Driver ID.'))
    .min(1).describe('Inference Drivers able to invoke this model.'),
  inputModalities: z.array(z.string().trim().min(1).describe('Accepted input modality.'))
    .default([]).describe('Input modalities accepted by this model.'),
  outputModalities: z.array(z.string().trim().min(1).describe('Produced output modality.'))
    .default([]).describe('Output modalities produced by this model.'),
  capabilities: modelCapabilitiesSchema,
  reasoning: reasoningProfileSchema.optional(),
  limits: modelLimitsSchema.default({}),
  pricing: z.record(z.string(), z.number().nonnegative().describe('Non-negative price value.'))
    .describe('Optional pricing values keyed by pricing unit.')
    .meta({ 'x-piskie': { keyPlaceholder: 'pricingUnit' } })
    .optional(),
  source: z.object({
    kind: z.enum(['bundled', 'local', 'remote']).describe('Catalog provenance kind.'),
    version: z.string().trim().min(1).describe('Catalog provenance version.'),
    updatedAt: z.string().trim().min(1).describe('Optional provenance update timestamp.').optional(),
  }).strip().describe('System-managed model provenance.'),
}).strip().describe('One model definition in the compiled Catalog.');

export const catalogDocumentSchema = z.object({
  version: z.string().trim().min(1).describe('Catalog document version.'),
  models: z.array(modelDefinitionSchema).describe('Model definitions in this Catalog document.'),
}).strip();

export const modelOverlaySchema = modelDefinitionSchema.partial().required({ id: true });

export const catalogOverlayDocumentSchema = z.object({
  version: z.string().trim().min(1).describe('Local Catalog overlay version.'),
  revision: z.number().int().nonnegative().describe('Optional local Catalog revision.').optional(),
  models: z.array(modelOverlaySchema).describe('Local model definitions and partial overrides.'),
}).strip();

export type ModelDefinition = z.infer<typeof modelDefinitionSchema>;
export type CatalogDocument = z.infer<typeof catalogDocumentSchema>;
export type CatalogOverlayDocument = z.infer<typeof catalogOverlayDocumentSchema>;

export interface LocalCatalogDocument extends CatalogOverlayDocument {
  revision: number;
  models: CatalogOverlayDocument['models'];
}

export interface CatalogSnapshot {
  version: string;
  loadedAt: string;
  models: ReadonlyMap<string, ModelDefinition>;
}

export interface ModelCatalogSource {
  load(signal?: AbortSignal): Promise<CatalogSnapshot>;
}
