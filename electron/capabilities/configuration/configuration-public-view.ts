import type { ConfigPlan } from '../../../shared/types/config.js';
import type { ConfigPlanSnapshot } from '../../../shared/electron-contracts/configuration.js';

export function projectConfigurationRead(_domain: string, value: unknown): unknown {
  return structuredClone(value);
}

export function projectConfigPlan(plan: ConfigPlan): ConfigPlanSnapshot {
  return {
    id: plan.id,
    domain: plan.domain,
    baseRevision: plan.baseRevision,
    schemaVersion: plan.schemaVersion,
    descriptorHash: plan.descriptorHash,
    dependencyRevisions: structuredClone(plan.dependencyRevisions),
    candidateHash: plan.candidateHash,
    affectedPaths: [...plan.affectedPaths],
    impacts: structuredClone(plan.impacts),
    validation: structuredClone(plan.validation),
    probes: structuredClone(plan.probes),
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
  };
}

export function restoreConfigurationWrite(
  _domain: string,
  submitted: unknown,
  _existing: unknown,
): unknown {
  return submitted;
}
