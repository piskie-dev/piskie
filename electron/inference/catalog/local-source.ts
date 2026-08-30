import fs from 'node:fs/promises';
import path from 'node:path';
import {
  catalogDocumentSchema,
  catalogOverlayDocumentSchema,
  modelDefinitionSchema,
  type CatalogOverlayDocument,
  type CatalogSnapshot,
  type ModelCatalogSource,
  type ModelDefinition,
} from './contracts.js';

export interface LocalCatalogSourceOptions {
  rootDirectory: string;
  basePath: string;
  overlayPaths?: readonly string[];
  overlayOverrides?: ReadonlyMap<string, CatalogOverlayDocument>;
  now?: () => Date;
}

export class CatalogLoadError extends Error {
  constructor(
    readonly code: 'CATALOG_READ_FAILED' | 'CATALOG_PARSE_FAILED' | 'CATALOG_DUPLICATE_MODEL' | 'CATALOG_INVALID_OVERLAY',
    readonly filePath: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CatalogLoadError';
  }
}

export class LocalCatalogSource implements ModelCatalogSource {
  private readonly now: () => Date;

  constructor(private readonly options: LocalCatalogSourceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async load(signal?: AbortSignal): Promise<CatalogSnapshot> {
    signal?.throwIfAborted();
    const basePath = this.resolve(this.options.basePath);
    const base = catalogDocumentSchema.parse(await readJson(basePath));
    const models = new Map<string, ModelDefinition>();

    for (const model of base.models) {
      if (models.has(model.id)) {
        throw new CatalogLoadError('CATALOG_DUPLICATE_MODEL', basePath, `Duplicate model in base catalog: ${model.id}`);
      }
      models.set(model.id, model);
    }

    const versions = [base.version];
    for (const configuredPath of this.options.overlayPaths ?? []) {
      signal?.throwIfAborted();
      const overlayPath = this.resolve(configuredPath);
      const override = this.options.overlayOverrides?.get(overlayPath);
      const overlay = override ?? catalogOverlayDocumentSchema.parse(await readJson(overlayPath));
      applyOverlay(models, overlay, overlayPath);
      versions.push(overlay.version);
    }

    return {
      version: versions.join('+'),
      loadedAt: this.now().toISOString(),
      models,
    };
  }

  private resolve(configuredPath: string): string {
    return path.isAbsolute(configuredPath)
      ? configuredPath
      : path.resolve(this.options.rootDirectory, configuredPath);
  }
}

async function readJson(filePath: string): Promise<unknown> {
  let source: string;
  try {
    source = await fs.readFile(filePath, 'utf8');
  } catch (cause) {
    throw new CatalogLoadError('CATALOG_READ_FAILED', filePath, `Unable to read model catalog: ${filePath}`, { cause });
  }

  try {
    return JSON.parse(source);
  } catch (cause) {
    throw new CatalogLoadError('CATALOG_PARSE_FAILED', filePath, `Invalid model catalog JSON: ${filePath}`, { cause });
  }
}

function applyOverlay(
  models: Map<string, ModelDefinition>,
  overlay: CatalogOverlayDocument,
  overlayPath: string,
): void {
  const seen = new Set<string>();
  for (const patch of overlay.models) {
    if (seen.has(patch.id)) {
      throw new CatalogLoadError('CATALOG_DUPLICATE_MODEL', overlayPath, `Duplicate model in catalog overlay: ${patch.id}`);
    }
    seen.add(patch.id);

    const existing = models.get(patch.id);
    // The overlay file itself is the provenance boundary. Older documents may
    // omit source, but their operational limits must still never come from a
    // same-named bundled model.
    const overlaySource = {
      kind: 'local' as const,
      version: overlay.version,
      ...patch.source,
    };
    const candidate = existing
      ? {
          ...existing,
          ...patch,
          capabilities: { ...existing.capabilities, ...patch.capabilities },
          limits: { ...(patch.limits ?? {}) },
          source: overlaySource,
          ...(existing.pricing || patch.pricing
            ? { pricing: { ...existing.pricing, ...patch.pricing } }
            : {}),
        }
      : { ...patch, limits: { ...(patch.limits ?? {}) }, source: overlaySource };
    const parsed = modelDefinitionSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new CatalogLoadError(
        'CATALOG_INVALID_OVERLAY',
        overlayPath,
        `Invalid overlay for model ${patch.id}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
      );
    }
    models.set(patch.id, parsed.data);
  }
}
