import path from 'node:path';
import type {
  CatalogOverlayDocument,
  CatalogSnapshot,
  ModelCatalogSource,
} from './contracts.js';
import { bundledCatalogPaths, type BundledCatalogPaths } from './bundled-source.js';
import { LocalCatalogSource } from './local-source.js';

export interface CanonicalCatalogSourceOptions {
  rootDirectory: string;
  now?: () => Date;
}

/** Loads the system Catalog and the single ConfigHost-owned local overlay. */
export class CanonicalCatalogSource implements ModelCatalogSource {
  readonly paths: BundledCatalogPaths;
  private readonly rootDirectory: string;
  private readonly now?: () => Date;

  constructor(options: CanonicalCatalogSourceOptions) {
    this.rootDirectory = path.resolve(options.rootDirectory);
    this.paths = bundledCatalogPaths(this.rootDirectory);
    this.now = options.now;
  }

  load(signal?: AbortSignal): Promise<CatalogSnapshot> {
    return this.createSource().load(signal);
  }

  loadCandidate(
    candidate: CatalogOverlayDocument,
    signal?: AbortSignal,
  ): Promise<CatalogSnapshot> {
    return this.createSource(candidate).load(signal);
  }

  private createSource(candidate?: CatalogOverlayDocument): LocalCatalogSource {
    return new LocalCatalogSource({
      rootDirectory: this.rootDirectory,
      basePath: this.paths.baseFile,
      overlayPaths: [this.paths.overlayFile],
      ...(candidate && {
        overlayOverrides: new Map([[this.paths.overlayFile, candidate]]),
      }),
      now: this.now,
    });
  }
}
