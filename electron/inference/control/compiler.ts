import type { CatalogSnapshot, ModelDefinition } from '../catalog/contracts.js';
import { resolveBoundModelDefinition } from '../catalog/query.js';
import type { DriverRegistry } from '../drivers/registry.js';
import type { CompiledTarget, InferenceRuntimeSnapshot } from '../execution/runtime-snapshot.js';
import type { InferenceConfig } from './config-schema.js';
import {
  analyzeInferenceSemantics,
  type ValidationIssue,
} from './validation.js';

export interface InferenceRuntimeProjection {
  snapshot: InferenceRuntimeSnapshot;
  issues: readonly ValidationIssue[];
}

export function compileInferenceConfig(
  config: InferenceConfig,
  catalog: CatalogSnapshot,
  drivers: DriverRegistry,
  now: () => Date = () => new Date(),
): InferenceRuntimeSnapshot {
  return projectInferenceRuntime(config, catalog, drivers, now).snapshot;
}

export function projectInferenceRuntime(
  config: InferenceConfig,
  catalog: CatalogSnapshot,
  drivers: DriverRegistry,
  now: () => Date = () => new Date(),
): InferenceRuntimeProjection {
  const analysis = analyzeInferenceSemantics(config, catalog, drivers);
  const issues = [...analysis.report.issues];

  const targets = new Map<string, ReadonlyMap<string, CompiledTarget>>();
  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (!provider.enabled || analysis.unavailableProviders.has(providerId)) continue;
    const driver = drivers.get(provider.driver);
    if (!driver) continue;
    const models = new Map<string, CompiledTarget>();

    for (const [modelId, binding] of Object.entries(provider.models)) {
      if (!binding.enabled || analysis.unavailableModels.get(providerId)?.has(modelId)) continue;
      const catalogModel = resolveBoundModelDefinition(catalog, {
        catalogId: binding.catalogId,
        upstreamId: binding.upstreamId,
        driverId: provider.driver,
      });
      if (!catalogModel) continue;

      let target: CompiledTarget;
      try {
        const compiled = driver.compile({
          providerId,
          provider,
          modelId,
          binding,
          catalogModel,
          catalog,
          configRevision: config.revision,
        });
        const compiledAi = compileAiDefaults(compiled, catalogModel);
        target = {
          ...compiled,
          ...(compiledAi && { ai: compiledAi }),
          modelDefinition: catalogModel,
          ...(catalogModel.reasoning && {
            reasoning: {
              profile: catalogModel.reasoning,
              ...(binding.defaultReasoning && { modelDefault: binding.defaultReasoning }),
            },
          }),
        };
      } catch (cause) {
        issues.push(ignoredTargetIssue(
          'DRIVER_COMPILE_FAILED',
          providerId,
          modelId,
          `Driver ${provider.driver} failed to compile this target: ${errorMessage(cause)}`,
        ));
        continue;
      }
      const violations = compiledTargetViolations(
        target,
        providerId,
        modelId,
        provider.driver,
        config.revision,
        catalogModel.kind,
      );
      if (violations.length > 0) {
        issues.push(ignoredTargetIssue(
          'DRIVER_COMPILE_CONTRACT_VIOLATION',
          providerId,
          modelId,
          `Driver ${provider.driver} returned an invalid target: ${violations.join(', ')}`,
        ));
        continue;
      }
      models.set(modelId, Object.freeze(target));
    }
    if (models.size > 0) targets.set(providerId, models);
  }

  const snapshot = Object.freeze({
    configRevision: config.revision,
    catalogVersion: catalog.version,
    catalogModels: catalog.models,
    targets,
    policies: Object.freeze({
      ai: Object.freeze({ ...config.policies.ai }),
      image: Object.freeze({ ...config.policies.image }),
    }),
    createdAt: now().toISOString(),
  });
  return { snapshot, issues: Object.freeze(issues) };
}

function compileAiDefaults(
  target: CompiledTarget,
  catalogModel: ModelDefinition,
): CompiledTarget['ai'] {
  if (!target.ai || catalogModel.kind !== 'ai') return target.ai;
  const compiledAi = { openAttempt: target.ai.openAttempt };
  if (catalogModel.limits.maxOutputTokens === undefined) return compiledAi;
  return {
    ...compiledAi,
    generationDefaults: Object.freeze({
      maxOutputTokens: catalogModel.limits.maxOutputTokens,
    }),
  };
}

function compiledTargetViolations(
  target: CompiledTarget,
  providerId: string,
  modelId: string,
  driverId: string,
  configRevision: number,
  kind: 'ai' | 'image',
): string[] {
  const violations: string[] = [];
  if (target.ref.providerId !== providerId || target.ref.modelId !== modelId) violations.push('target reference changed');
  if (target.driverId !== driverId) violations.push('driver ID changed');
  if (target.configRevision !== configRevision) violations.push('config revision changed');
  if (kind === 'ai' && !target.ai) violations.push('AI function missing');
  if (kind === 'image' && !target.image) violations.push('Image function missing');
  return violations;
}

function ignoredTargetIssue(
  code: string,
  providerId: string,
  modelId: string,
  message: string,
): ValidationIssue {
  return {
    stage: 'semantic',
    code,
    path: `/providers/${escapePointer(providerId)}/models/${escapePointer(modelId)}`,
    message,
    severity: 'warning',
  };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function escapePointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}
