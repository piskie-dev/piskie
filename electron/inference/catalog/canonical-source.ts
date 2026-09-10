import path from 'node:path';
import type {
  CatalogOverlayDocument,
  CatalogDocument,
  CatalogSnapshot,
  CatalogViews,
  ModelCatalogSource,
} from './contracts.js';
import { bundledCatalogPaths, type BundledCatalogPaths } from './bundled-source.js';
import { LocalCatalogSource } from './local-source.js';

export interface CanonicalCatalogSourceOptions {
  rootDirectory: string;
  now?: () => Date;
  remote?: { load(): Promise<CatalogDocument | undefined> };
}

/** Keeps the bundled/remote directory intact while applying the ConfigHost-owned local overlay. */
export class CanonicalCatalogSource implements ModelCatalogSource {
  readonly paths: BundledCatalogPaths;
  private readonly rootDirectory: string;
  private readonly now?: () => Date;
  private readonly remote?: CanonicalCatalogSourceOptions['remote'];

  constructor(options: CanonicalCatalogSourceOptions) {
    this.rootDirectory = path.resolve(options.rootDirectory);
    this.paths = bundledCatalogPaths(this.rootDirectory);
    this.now = options.now;
    this.remote = options.remote;
  }

  async load(signal?: AbortSignal): Promise<CatalogSnapshot> {
    return (await this.loadViews(signal)).effective;
  }

  async loadViews(signal?: AbortSignal): Promise<CatalogViews> {
    return this.createSource(undefined, await this.remote?.load()).loadViews(signal);
  }

  async loadCandidate(
    candidate: CatalogOverlayDocument,
    signal?: AbortSignal,
  ): Promise<CatalogSnapshot> {
    return this.createSource(candidate, await this.remote?.load()).load(signal);
  }

  private createSource(candidate?: CatalogOverlayDocument, remoteCatalog?: CatalogDocument): LocalCatalogSource {
    return new LocalCatalogSource({
      rootDirectory: this.rootDirectory,
      basePath: this.paths.baseFile,
      overlayPaths: [this.paths.overlayFile],
      remoteCatalog,
      ...(candidate && {
        overlayOverrides: new Map([[this.paths.overlayFile, candidate]]),
      }),
      now: this.now,
    });
  }
}
