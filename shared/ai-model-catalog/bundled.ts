import catalogJson from './generated/catalog.json' with { type: 'json' };
import manifestJson from './generated/manifest.json' with { type: 'json' };

/** Signed manifest of the website publication that ships with this build. */
export interface BundledCatalogManifest {
  schemaVersion: number;
  revision: number;
  version: string;
  generatedAt: string;
  minClientVersion: string;
  sha256: string;
  keyId: string;
  catalogPath: string;
  signature: string;
}

/**
 * Exact published catalog document. `npm run catalog:pull` refreshes it from the website and
 * `npm run catalog:validate` re-verifies its signature and hash offline; the inference runtime parses
 * it against its catalog contract before use.
 */
export interface BundledCatalogDocument {
  version: string;
  models: readonly unknown[];
}

export const BUNDLED_MODEL_CATALOG: {
  manifest: BundledCatalogManifest;
  document: BundledCatalogDocument;
} = {
  manifest: manifestJson,
  document: catalogJson,
};
