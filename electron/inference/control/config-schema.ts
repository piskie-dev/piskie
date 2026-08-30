import { z } from 'zod';
import { reasoningProfileSchema } from '../catalog/contracts.js';

const reasoningSelectionSchema = reasoningProfileSchema.shape.defaultSelection;

export const DEFAULT_AI_RETRY_BASE_DELAY_MS = 3_000;

// Mutation candidates are closed contracts; persisted reads strip unknown keys before publication.
export const plainAuthSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('none').describe('Send no authentication credentials.'),
  }).strict(),
  z.object({
    kind: z.literal('bearer').describe('Send the credential as an Authorization bearer token.'),
    value: z.string()
      .describe('Plaintext bearer credential used for Provider requests.'),
  }).strict(),
  z.object({
    kind: z.literal('api_key').describe('Send the credential in a configurable HTTP header.'),
    header: z.string().trim().min(1)
      .describe('HTTP header name that carries the API key.'),
    value: z.string()
      .describe('Plaintext API key sent in the configured header.'),
  }).strict(),
  z.object({
    kind: z.literal('basic').describe('Use HTTP Basic authentication.'),
    username: z.string().describe('Username used for HTTP Basic authentication.'),
    password: z.string()
      .describe('Plaintext password used for HTTP Basic authentication.'),
  }).strict(),
  z.object({
    kind: z.literal('aws').describe('Use AWS SigV4-compatible credentials.'),
    accessKeyId: z.string()
      .describe('AWS access key identifier.'),
    secretAccessKey: z.string()
      .describe('AWS secret access key.'),
    sessionToken: z.string().optional()
      .describe('Optional temporary AWS session token.'),
    region: z.string().trim().min(1).describe('AWS region used when signing requests.'),
  }).strict(),
]).describe('Authentication strategy for this Provider connection.');

export const providerConnectionSchema = z.object({
  baseUrl: z.url().describe('Base URL for every request sent through this Provider.'),
  auth: plainAuthSchema,
  headers: z.record(
    z.string(),
    z.string()
      .describe('Plaintext value for an additional Provider HTTP header.'),
  )
    .default({})
    .describe('Additional HTTP headers applied to every request for this Provider.')
    .meta({ 'x-piskie': { keyPlaceholder: 'headerName' } }),
  proxyId: z.string().trim().min(1).nullable().default(null)
    .describe('Global proxy configuration ID, or null to connect directly.')
    .meta({
      'x-piskie': {
        reference: { domain: 'proxies', collection: 'proxies', onDelete: 'reject' },
        changeImpact: 'Affects every request made through this Provider.',
        applyMode: 'next-request',
        recommendedProbe: 'connectivity',
      },
    }),
})
  .strict()
  .describe('Network connection and authentication shared by this Provider.');

export const modelBindingSchema = z.object({
  catalogId: z.string().trim().min(1)
    .describe('Model Catalog entry that supplies metadata for this binding.'),
  upstreamId: z.string().trim().min(1)
    .describe('Exact model identifier sent to the upstream Provider.'),
  enabled: z.boolean().default(true)
    .describe('Whether this model binding can be selected for new requests.'),
  defaultReasoning: reasoningSelectionSchema.optional()
    .describe('Default reasoning selection used when a request does not provide one.'),
  options: z.record(z.string(), z.unknown())
    .default({})
    .describe('Driver-defined options for this model binding.')
    .meta({ 'x-piskie': { keyPlaceholder: 'optionName' } }),
})
  .strict()
  .describe('One user-visible model bound to an upstream Provider model.');

export const providerInstanceSchema = z.object({
  displayName: z.string().trim().min(1).describe('User-visible name for this Provider instance.'),
  driver: z.string().trim().min(1)
    .describe('Registered inference Driver that implements this Provider protocol.'),
  enabled: z.boolean().default(true)
    .describe('Whether this Provider and its model bindings can be selected for new requests.'),
  connection: providerConnectionSchema,
  models: z.record(z.string(), modelBindingSchema)
    .describe('Model bindings keyed by stable user-facing model ID.')
    .meta({ 'x-piskie': { keyPlaceholder: 'modelId' } }),
  driverOptions: z.record(z.string(), z.unknown())
    .default({})
    .describe('Driver-defined options shared by every model on this Provider.')
    .meta({ 'x-piskie': { keyPlaceholder: 'optionName' } }),
})
  .strict()
  .describe('Configured Provider instance used by AI or Image Gateway requests.');

export const inferenceConfigSchema = z.object({
  schemaVersion: z.literal(1)
    .describe('Inference configuration schema version owned by Piskie.')
    .meta({ 'x-piskie': { mutability: 'system' } }),
  revision: z.number().int().nonnegative()
    .describe('Monotonic configuration revision owned by the Control Plane.')
    .meta({ 'x-piskie': { mutability: 'read-only' } }),
  providers: z.record(z.string(), providerInstanceSchema)
    .describe('Provider instances keyed by stable Provider ID.')
    .meta({ 'x-piskie': { keyPlaceholder: 'providerId' } }),
  policies: z.object({
    ai: z.object({
      maxAttempts: z.number().int().min(1).max(10)
        .describe('Maximum attempts for one AI request, including the initial attempt.'),
      connectTimeoutMs: z.number().int().positive()
        .describe('Maximum milliseconds allowed to establish an AI Provider connection.'),
      streamIdleTimeoutMs: z.number().int().positive()
        .describe('Maximum milliseconds allowed before the first AI stream event and between consecutive events.'),
      retryBaseDelayMs: z.number().int().nonnegative().default(DEFAULT_AI_RETRY_BASE_DELAY_MS)
        .describe('Base exponential backoff delay in milliseconds for retryable AI request failures.'),
    }).strict().describe('Retry and timeout policy shared by AI Gateway requests.'),
    image: z.object({
      maxSubmitAttempts: z.number().int().min(1).max(5)
        .describe('Maximum submissions to the selected image model; retries are allowed only when the Driver proves the prior submission was not accepted.'),
      submitTimeoutMs: z.number().int().positive()
        .describe('Maximum milliseconds for a job-style image Driver to return an accepted job ID. Synchronous image APIs do not use this deadline.'),
      operationTimeoutMs: z.number().int().positive()
        .describe('Wall-clock milliseconds for one image request, from invocation through artifact persistence. Applies to synchronous OpenAI-compatible image requests.'),
      allowResubmitAfterAccepted: z.literal(false)
        .describe('Accepted image jobs are never resubmitted, preventing duplicate generation and duplicate charges.'),
    }).strict().describe('Submission and wall-clock policy shared by Image Gateway requests.'),
  }).strict().describe('Gateway-level retry and timeout policies.'),
})
  .strict()
  .describe('Versioned AI and image inference configuration.');

export const inferenceConfigWriteSchema = inferenceConfigSchema.omit({
  schemaVersion: true,
  revision: true,
});

export type PlainAuth = z.infer<typeof plainAuthSchema>;
export type ModelBinding = z.infer<typeof modelBindingSchema>;
export type ProviderInstance = z.infer<typeof providerInstanceSchema>;
export type InferenceConfig = z.infer<typeof inferenceConfigSchema>;

export function inferenceConfigJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(inferenceConfigSchema) as Record<string, unknown>;
}
