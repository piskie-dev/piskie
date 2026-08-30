import type { CatalogSnapshot, ModelDefinition } from './contracts.js';

export type CapabilityState = 'supported' | 'unsupported' | 'unknown';

export class CatalogQuery {
  constructor(private readonly snapshot: CatalogSnapshot) {}

  get(modelId: string): ModelDefinition | undefined {
    return this.snapshot.models.get(modelId);
  }

  list(kind?: ModelDefinition['kind']): readonly ModelDefinition[] {
    return [...this.snapshot.models.values()]
      .filter((model) => kind === undefined || model.kind === kind)
      .sort(compareCatalogModels);
  }

  capability(modelId: string, capability: keyof ModelDefinition['capabilities']): CapabilityState {
    const value = this.snapshot.models.get(modelId)?.capabilities[capability];
    if (value === undefined) return 'unknown';
    return value ? 'supported' : 'unsupported';
  }
}

export function compareCatalogModels(left: ModelDefinition, right: ModelDefinition): number {
  const release = compareOptionalDateDescending(left.releaseDate, right.releaseDate);
  if (release !== 0) return release;
  const updated = compareOptionalDateDescending(left.source.updatedAt, right.source.updatedAt);
  return updated || left.id.localeCompare(right.id);
}

export function resolveBoundModelDefinition(
  snapshot: CatalogSnapshot,
  input: { catalogId: string; upstreamId: string; driverId: string },
): ModelDefinition | undefined {
  const configured = snapshot.models.get(input.catalogId);
  if (!configured || configured.source.kind === 'bundled') return configured;
  const bundledDefinition = [...snapshot.models.values()].find((candidate) => (
    candidate.source.kind === 'bundled'
    && candidate.kind === configured.kind
    && candidate.compatibleDrivers.includes(input.driverId)
    && upstreamId(candidate.id) === input.upstreamId
  ));
  if (!bundledDefinition) return configured;
  const reasoning = configured.reasoning ?? bundledDefinition.reasoning;
  return {
    ...bundledDefinition,
    ...configured,
    releaseDate: configured.releaseDate ?? bundledDefinition.releaseDate,
    capabilities: {
      ...bundledDefinition.capabilities,
      ...configured.capabilities,
      ...(reasoning && { reasoning: reasoning.mode !== 'none' }),
    },
    reasoning,
    // Operational limits are local configuration, never inferred from a name match.
    limits: configured.limits,
    source: configured.source,
  };
}

function compareOptionalDateDescending(left?: string, right?: string): number {
  if (left && right) return right.localeCompare(left);
  if (left) return -1;
  if (right) return 1;
  return 0;
}

function upstreamId(catalogId: string): string {
  const separator = catalogId.indexOf('/');
  return separator < 0 ? catalogId : catalogId.slice(separator + 1);
}
