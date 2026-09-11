import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { ConfigValidationIssue } from '../../../shared/types/config.js';
import type { WorkerPreferencesDocument } from '../../../shared/types/worker-preferences.js';
import { reasoningProfileSchema } from '../../inference/catalog/contracts.js';
import type { InferenceControlPlane } from '../../inference/control/control-plane.js';
import type { ConfigDomainIntegrations, ConfigDomainReader } from './integrations.js';
import { createManagedDomain } from './domain-factory.js';
import { escapePointer, validateWorkerInference } from './worker-inference-validation.js';

const target = z.object({
  providerId: z.string().trim().min(1).describe('Configured inference provider ID for new Workers of this type.'),
  modelId: z.string().trim().min(1).describe('Configured model binding ID within the selected inference provider.'),
});
const displayName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .describe('Optional display remark used only in Agent management; never changes Spec identity.')
  .meta({ 'x-piskie': { applyMode: 'immediate' } });
const reasoningWrite = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('provider-default') }),
  z.strictObject({ kind: z.literal('disabled') }),
  z.strictObject({ kind: z.literal('enabled') }),
  z.strictObject({
    kind: z.literal('effort'),
    effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  }),
  z.strictObject({ kind: z.literal('budget'), tokens: z.number().int().positive() }),
]);
const metadata = { 'x-piskie': { keyPlaceholder: 'type', applyMode: 'next-worker-creation' } };
export const workerPreferencesReadSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  profiles: z
    .record(
      z.string().min(1),
      z.object({
        displayName: displayName.optional(),
        inference: z
          .object({ target, reasoning: reasoningProfileSchema.shape.defaultSelection })
          .optional(),
      })
    )
    .meta(metadata),
});
export const workerPreferencesWriteSchema = z.strictObject({
  profiles: z
    .record(
      z.string().min(1),
      z.strictObject({
        displayName: displayName.optional(),
        inference: z
          .strictObject({ target: target.strict(), reasoning: reasoningWrite })
          .optional(),
      })
    )
    .describe(
      'Preferences keyed by registered Worker Spec name; remove inference to inherit the parent.'
    )
    .meta(metadata),
});

export function createWorkerPreferencesDomain(
  rootDirectory: string,
  inference: InferenceControlPlane,
  readDomain: ConfigDomainReader,
  integration?: ConfigDomainIntegrations['workerPreferences']
) {
  return createManagedDomain<
    WorkerPreferencesDocument,
    WorkerPreferencesDocument,
    z.infer<typeof workerPreferencesWriteSchema>
  >(rootDirectory, {
    contract: {
      id: 'worker-preferences',
      title: 'Worker preferences',
      description:
        'Model and concrete reasoning preferences per Worker type, applied to new instances.',
      schemaVersion: 1,
      readSchema: workerPreferencesReadSchema,
      writeSchema: workerPreferencesWriteSchema,
      capabilities: ['show', 'plan', 'validate', 'apply', 'verify', 'history', 'rollback'],
    },
    codec: { parse: (raw) => workerPreferencesReadSchema.parse(raw) },
    bootstrap: () => ({ schemaVersion: 1, revision: 0, profiles: {} }),
    adapter: {
      projectRead: (stored) => stored,
      normalizeCandidate: (current, patched) => ({
        ...patched,
        schemaVersion: 1,
        revision: current.revision,
      }),
      dependencyRevisions: async () => {
        const domains = ['inference', 'model-catalog'];
        const documents = await Promise.all(domains.map((id) => readDomain(id)));
        return Object.fromEntries(
          domains.map((id, index) => [id, (documents[index] as { revision: number }).revision])
        );
      },
      validateSemantic: async (candidate) => {
        const current = (await readDomain('worker-preferences')) as WorkerPreferencesDocument;
        const types = integration
          ? new Set(integration.listTypes().map((entry) => entry.type))
          : undefined;
        const issues: ConfigValidationIssue[] = [];
        for (const [type, profile] of Object.entries(candidate.profiles)) {
          if (types?.has(type)) continue;
          issues.push({
            stage: 'reference',
            code: types ? 'WORKER_TYPE_NOT_FOUND' : 'WORKER_CATALOG_UNAVAILABLE',
            path: `/profiles/${escapePointer(type)}`,
            details: { type },
            severity: isDeepStrictEqual(current.profiles[type], profile) ? 'warning' : 'error',
            message: types
              ? `Worker type ${type} is not registered.`
              : 'Worker type catalog is unavailable in this host.',
          });
        }
        for (const issue of await validateWorkerInference(inference, candidate)) {
          const type = issue.details!.type as string;
          issues.push({
            ...issue,
            severity: isDeepStrictEqual(
              current.profiles[type]?.inference,
              candidate.profiles[type]?.inference
            )
              ? 'warning'
              : 'error',
          });
        }
        return { valid: issues.every((issue) => issue.severity === 'warning'), issues };
      },
      // Consumed on creation; publishing preferences must not mutate live instances.
      publish: () => undefined,
    },
  });
}
