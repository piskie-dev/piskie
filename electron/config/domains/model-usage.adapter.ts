import { z } from 'zod';
import type { ModelUsageConfig } from '../../../shared/types/model-usage.js';
import { createManagedDomain } from './domain-factory.js';

export const modelUsageWriteSchema = z.strictObject({
  retentionDays: z.union([z.literal(30), z.literal(90), z.literal(180), z.literal(365), z.null()])
    .describe('UTC calendar days to retain, including today; null retains all. Shortening removes older report history at cleanup.'),
});
export const modelUsageReadSchema = modelUsageWriteSchema.extend({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
});
export const defaultModelUsageConfig = (): ModelUsageConfig => ({
  schemaVersion: 1, revision: 0, retentionDays: 90,
});

export function createModelUsageDomain(rootDirectory: string, publish?: (config: ModelUsageConfig) => void) {
  return createManagedDomain<ModelUsageConfig, ModelUsageConfig, z.infer<typeof modelUsageWriteSchema>>(rootDirectory, {
    contract: {
      id: 'model-usage', title: 'Model usage',
      description: 'Local model usage retention.',
      schemaVersion: 1, readSchema: modelUsageReadSchema, writeSchema: modelUsageWriteSchema,
      capabilities: ['show', 'plan', 'validate', 'apply', 'verify', 'history', 'rollback'],
    },
    codec: { parse: (raw) => modelUsageReadSchema.parse(raw) },
    bootstrap: defaultModelUsageConfig,
    adapter: {
      projectRead: (stored) => stored,
      normalizeCandidate: (current, patched) => ({ ...patched, schemaVersion: 1, revision: current.revision }),
      publish: (candidate) => publish?.(candidate),
    },
  });
}
