import { z } from 'zod';
import type { InferenceControlPlane } from '../../inference/control/control-plane.js';
import type {
  InferenceSelections,
  InferenceSelectionStore,
} from '../../inference/control/selection-store.js';
import type { ConfigDomainReader } from './integrations.js';
import { createManagedDomain } from './domain-factory.js';

const targetSchema = z.strictObject({
  providerId: z.string().trim().min(1).describe('Exact configured inference Provider ID.'),
  modelId: z.string().trim().min(1).describe('Exact model binding ID within the Provider.'),
});

export const inferenceSelectionsWriteSchema = z.strictObject({
  ai: targetSchema.describe('Default target for new AI requests.').optional(),
  image: targetSchema.describe('Default target for new image requests.').optional(),
});

export const inferenceSelectionsReadSchema = z.strictObject({
  schemaVersion: z.literal(1).describe('Inference-selection schema version owned by Piskie.'),
  revision: z.number().int().nonnegative().describe('Monotonic inference-selections revision.'),
  ai: targetSchema.describe('Current default target for new AI requests.').optional(),
  image: targetSchema.describe('Current default target for new image requests.').optional(),
});

type SelectionsWrite = z.infer<typeof inferenceSelectionsWriteSchema>;
type SelectionsRead = z.infer<typeof inferenceSelectionsReadSchema>;
type SelectionsDocument = SelectionsRead;

export function createInferenceSelectionsDomain(
  rootDirectory: string,
  selections: InferenceSelectionStore,
  inference: InferenceControlPlane,
  readDomain: ConfigDomainReader,
  onChanged?: (selections: InferenceSelections) => void | Promise<void>,
) {
  return createManagedDomain<SelectionsDocument, SelectionsRead, SelectionsWrite>(rootDirectory, {
    contract: {
      id: 'inference-selections',
      title: 'Inference selections',
      description: 'Exact default Provider/model targets used for new AI and image requests.',
      schemaVersion: 1,
      readSchema: inferenceSelectionsReadSchema,
      writeSchema: inferenceSelectionsWriteSchema,
      capabilities: ['show', 'plan', 'validate', 'apply', 'verify', 'history', 'rollback'],
    },
    codec: { parse: (raw) => inferenceSelectionsReadSchema.parse(raw) },
    bootstrap: () => ({ schemaVersion: 1, revision: 0 }),
    adapter: {
      projectRead: (stored) => inference.filterSelections(stored),
      normalizeCandidate: (current, patched) => ({
        ...patched,
        schemaVersion: 1,
        revision: current.revision,
      }),
      dependencyRevisions: async () => ({ inference: revisionOf(await readDomain('inference')) }),
      validateSemantic: async (candidate) => {
        const issues: Array<{ stage: 'reference'; code: string; path: string; message: string }> = [];
        for (const [gateway, target] of [['ai', candidate.ai], ['image', candidate.image]] as const) {
          if (!target) continue;
          try {
            await inference.assertSelectableTarget(target, gateway);
          } catch (cause) {
            issues.push({
              stage: 'reference',
              code: errorCode(cause, 'SELECTION_TARGET_NOT_FOUND'),
              path: `/${gateway}`,
              message: cause instanceof Error ? cause.message : String(cause),
            });
          }
        }
        return { valid: issues.length === 0, issues };
      },
      publish: async (candidate) => {
        const effective = await inference.filterSelections(candidate);
        selections.publishSelections(effective);
        await onChanged?.(effective);
      },
    },
  });
}

function revisionOf(value: unknown): number {
  return isRecord(value) && Number.isInteger(value.revision) ? value.revision as number : 0;
}

function errorCode(error: unknown, fallback: string): string {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
