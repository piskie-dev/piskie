import { z } from 'zod';
import {
  aiModelLimitsSchema,
  catalogOverlayDocumentSchema,
  type LocalCatalogDocument,
  modelOverlaySchema,
} from '../../inference/catalog/contracts.js';
import type { InferenceControlPlane } from '../../inference/control/control-plane.js';
import type { ConfigDomainReader } from './integrations.js';
import { createManagedDomain } from './domain-factory.js';

const catalogModelReadSchema = modelOverlaySchema.omit({ id: true })
  .describe('Local model metadata or a partial override of a bundled model.');
const catalogModelWriteBaseSchema = modelOverlaySchema.omit({ id: true, source: true });
export const catalogAiModelWriteSchema = catalogModelWriteBaseSchema.extend({
  kind: z.literal('ai'),
  limits: aiModelLimitsSchema,
}).describe('AI model metadata accepted when a local model is added or changed.');
const catalogImageModelWriteSchema = catalogModelWriteBaseSchema.extend({
  kind: z.literal('image'),
}).describe('Image model metadata accepted when a local model is added or changed.');
const catalogModelWriteSchema = z.discriminatedUnion('kind', [
  catalogAiModelWriteSchema,
  catalogImageModelWriteSchema,
]);
const modelRecordMetadata = {
  'x-piskie': { keyPlaceholder: 'modelId', applyMode: 'next-inference-request' },
};

export const modelCatalogWriteSchema = z.strictObject({
  models: z.record(z.string().trim().min(1), catalogModelWriteSchema)
    .describe('Local model definitions and overrides keyed by immutable catalog model ID.')
    .meta(modelRecordMetadata),
});

export const modelCatalogReadSchema = z.strictObject({
  revision: z.number().int().nonnegative().describe('Monotonic model-catalog revision.'),
  version: z.string().describe('Derived local catalog version for runtime compilation.'),
  models: z.record(z.string().trim().min(1), catalogModelReadSchema)
    .describe('Local model definitions and overrides keyed by immutable catalog model ID.')
    .meta(modelRecordMetadata),
});

type CatalogModelRead = z.infer<typeof catalogModelReadSchema>;
type ModelCatalogWrite = z.infer<typeof modelCatalogWriteSchema>;
type ModelCatalogRead = z.infer<typeof modelCatalogReadSchema>;
interface ModelCatalogDocument {
  revision: number;
  version: string;
  models: Record<string, CatalogModelRead>;
}

export function createModelCatalogDomain(
  rootDirectory: string,
  inference: InferenceControlPlane,
  readDomain: ConfigDomainReader,
  now: () => Date = () => new Date(),
) {
  return createManagedDomain<ModelCatalogDocument, ModelCatalogRead, ModelCatalogWrite>(rootDirectory, {
    contract: {
      id: 'model-catalog',
      title: 'Local model catalog',
      description: 'User-maintained model metadata and overrides compiled into the inference runtime.',
      schemaVersion: 1,
      readSchema: modelCatalogReadSchema,
      writeSchema: modelCatalogWriteSchema,
      capabilities: ['show', 'plan', 'validate', 'apply', 'verify', 'history', 'rollback'],
    },
    codec: {
      parse: parseCatalogDocument,
      serialize: serializeCatalogDocument,
    },
    bootstrap: () => ({ revision: 0, version: 'local:0', models: {} }),
    adapter: {
      projectRead: (stored) => stored,
      normalizeCandidate: (current, patched) => {
        const revision = current.revision + 1;
        return {
          ...patched,
          revision: current.revision,
          version: `local:${revision}`,
          models: Object.fromEntries(Object.entries(patched.models)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([id, model]) => [id, {
              ...model,
              source: {
                kind: 'local' as const,
                version: `local:${revision}`,
                updatedAt: now().toISOString(),
              },
            }])),
        };
      },
      dependencyRevisions: async () => ({ inference: revisionOf(await readDomain('inference')) }),
      validateSemantic: async (candidate) => {
        try {
          return await inference.validateCatalogCandidate(toLocalCatalog(candidate));
        } catch (cause) {
          return {
            valid: false,
            issues: [{
              stage: 'semantic' as const,
              code: errorCode(cause, 'MODEL_CATALOG_COMPILE_FAILED'),
              path: '/models',
              message: cause instanceof Error ? cause.message : String(cause),
            }],
          };
        }
      },
      analyzeImpact: (current, candidate) => Object.keys(current.models)
        .filter((id) => !candidate.models[id])
        .map((id) => ({
          code: 'CATALOG_MODEL_REMOVED',
          severity: 'warning' as const,
          path: `/models/${escapePointer(id)}`,
          message: `Local model metadata ${id} will be removed and inference will be recompiled.`,
        })),
      publish: (candidate) => inference.publishCatalogCandidate(toLocalCatalog(candidate)),
    },
  });
}

function parseCatalogDocument(raw: unknown): ModelCatalogDocument {
  const parsed = catalogOverlayDocumentSchema.parse(raw);
  const revision = parsed.revision ?? revisionFromVersion(parsed.version);
  return modelCatalogReadSchema.parse({
    revision,
    version: parsed.version,
    models: Object.fromEntries(parsed.models.map((model) => {
      const { id, ...entry } = model;
      return [id, entry];
    })),
  });
}

function serializeCatalogDocument(document: ModelCatalogDocument): string {
  const overlay = {
    version: `local:${document.revision}`,
    revision: document.revision,
    models: Object.entries(document.models).map(([id, model]) => ({
      id,
      ...model,
      ...(model.source && {
        source: { ...model.source, version: `local:${document.revision}` },
      }),
    })),
  };
  return `${JSON.stringify(overlay, null, 2)}\n`;
}

function toLocalCatalog(document: ModelCatalogDocument): LocalCatalogDocument {
  return {
    revision: document.revision,
    version: document.version,
    models: Object.entries(document.models).map(([id, model]) => ({ id, ...model })),
  };
}

function revisionFromVersion(version: string): number {
  const match = /^local:(\d+)$/.exec(version);
  return match ? Number(match[1]) : 0;
}

function revisionOf(value: unknown): number {
  return isRecord(value) && Number.isInteger(value.revision) ? value.revision as number : 0;
}

function errorCode(error: unknown, fallback: string): string {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : fallback;
}

function escapePointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
