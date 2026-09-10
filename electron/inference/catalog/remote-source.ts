import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { configFileWriter } from '../../config/core/atomic-file-writer.js';
import type { CatalogDocument } from './contracts.js';
import {
  CatalogUpdateError,
  MAX_CATALOG_BYTES,
  MODEL_CATALOG_PATH,
  verifyCatalogDocument,
  verifyCatalogManifest,
  type CatalogKeyring,
  type CatalogManifest,
  type CatalogUpdateErrorKind,
} from './distribution.js';

interface ModelCatalogUpdateStatus {
  state: 'idle' | 'checking' | 'current' | 'updated' | 'error';
  source: 'bundled' | 'remote';
  version: string;
  checkedAt?: string;
  error?: CatalogUpdateErrorKind;
}

const cachePointerSchema = z.object({
  current: z.unknown(),
  previous: z.unknown().optional(),
}).strip();

export interface RemoteCatalogOptions {
  rootDirectory: string;
  baseUrl: string;
  clientVersion: string;
  keys: CatalogKeyring;
  driverIds: ReadonlySet<string>;
  bundledVersion: string;
  bundledGeneratedAt: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

export class RemoteCatalogSource {
  private readonly directory: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly baseUrl: URL;
  private manifest?: CatalogManifest;
  private previousManifest?: CatalogManifest;
  private document?: CatalogDocument;
  private initialization?: Promise<void>;
  private refreshPromise?: Promise<ModelCatalogUpdateStatus>;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly abort = new AbortController();
  private currentStatus: ModelCatalogUpdateStatus;

  constructor(private readonly options: RemoteCatalogOptions) {
    this.directory = path.join(options.rootDirectory, 'catalog', 'remote');
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    this.baseUrl = new URL(options.baseUrl);
    if ((this.baseUrl.protocol !== 'https:' && !(this.baseUrl.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(this.baseUrl.hostname)))
      || this.baseUrl.username || this.baseUrl.password) {
      throw new Error('Model catalog origin must use HTTPS or localhost without credentials');
    }
    this.currentStatus = { state: 'idle', source: 'bundled', version: options.bundledVersion };
  }

  status(): ModelCatalogUpdateStatus {
    return { ...this.currentStatus };
  }

  initialize(): Promise<void> {
    this.initialization ??= this.restore();
    return this.initialization;
  }

  async load(): Promise<CatalogDocument | undefined> {
    await this.initialize();
    return this.document;
  }

  start(): void {
    if (this.timer || this.abort.signal.aborted) return;
    const tick = (): void => {
      this.timer = undefined;
      void this.refresh().finally(() => {
        if (this.abort.signal.aborted) return;
        this.timer = setTimeout(tick, 6 * 60 * 60 * 1000);
        this.timer.unref();
      });
    };
    this.timer = setTimeout(tick, 5_000);
    this.timer.unref();
  }

  refresh(): Promise<ModelCatalogUpdateStatus> {
    this.refreshPromise ??= this.check().finally(() => { this.refreshPromise = undefined; });
    return this.refreshPromise;
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.abort.abort();
    await this.refreshPromise;
  }

  private async restore(): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(path.join(this.directory, 'current.json'), 'utf8'));
    } catch (cause) {
      if (!isMissing(cause)) this.report(cause);
      return;
    }
    const pointer = cachePointerSchema.safeParse(raw);
    if (!pointer.success) return;
    for (const candidate of [pointer.data.current, pointer.data.previous]) {
      if (!candidate) continue;
      try {
        const manifest = verifyCatalogManifest(candidate, this.options.keys, this.options.clientVersion);
        const bytes = await fs.readFile(this.snapshotPath(manifest));
        const document = verifyCatalogDocument(bytes, manifest, this.options.driverIds);
        if (!this.manifest) {
          this.manifest = manifest;
          this.activate(manifest, document);
        } else if (manifest.sha256 !== this.manifest.sha256) {
          this.previousManifest = manifest;
        }
      } catch (cause) {
        this.report(cause);
      }
    }
  }

  private async check(): Promise<ModelCatalogUpdateStatus> {
    await this.initialize();
    this.currentStatus = { ...this.currentStatus, state: 'checking', error: undefined };
    try {
      const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)]);
      const bytes = await this.download(`${MODEL_CATALOG_PATH}/manifest.json`, 16 * 1024, signal);
      let raw: unknown;
      try {
        raw = JSON.parse(bytes.toString('utf8'));
      } catch (cause) {
        throw new CatalogUpdateError('untrusted', 'Invalid model catalog manifest JSON', { cause });
      }
      const manifest = verifyCatalogManifest(raw, this.options.keys, this.options.clientVersion);
      if (this.manifest && (manifest.revision < this.manifest.revision
        || (manifest.revision === this.manifest.revision && manifest.sha256 !== this.manifest.sha256))) {
        throw new CatalogUpdateError('untrusted', 'Model catalog publication is older than the verified cache');
      }
      if (Date.parse(manifest.generatedAt) < Date.parse(this.options.bundledGeneratedAt)) {
        this.currentStatus = { ...this.currentStatus, state: 'current', checkedAt: this.now().toISOString() };
        return this.status();
      }
      if (this.document && manifest.sha256 === this.manifest?.sha256) {
        await this.savePointer(manifest, this.previousManifest);
        this.manifest = manifest;
        this.currentStatus = { ...this.currentStatus, state: 'current', checkedAt: this.now().toISOString() };
        return this.status();
      }
      const catalogBytes = await this.download(manifest.catalogPath, MAX_CATALOG_BYTES, signal);
      const document = verifyCatalogDocument(catalogBytes, manifest, this.options.driverIds);
      try {
        // Publish the pointer only after the complete, verified object is durable.
        await configFileWriter.replace(this.snapshotPath(manifest), catalogBytes.toString('utf8'));
        await this.savePointer(manifest, this.manifest);
      } catch (cause) {
        throw new CatalogUpdateError('storage', 'Unable to save the verified model catalog', { cause });
      }
      this.previousManifest = this.manifest;
      this.manifest = manifest;
      this.activate(manifest, document);
      this.currentStatus = { ...this.currentStatus, state: 'updated', checkedAt: this.now().toISOString() };
      await this.pruneSnapshots().catch((cause) => this.report(cause));
    } catch (cause) {
      this.currentStatus = {
        ...this.currentStatus,
        state: 'error',
        error: cause instanceof CatalogUpdateError ? cause.kind : 'network',
        checkedAt: this.now().toISOString(),
      };
      if (!this.abort.signal.aborted) this.report(cause);
    }
    return this.status();
  }

  private activate(manifest: CatalogManifest, document: CatalogDocument): void {
    if (Date.parse(manifest.generatedAt) < Date.parse(this.options.bundledGeneratedAt)) return;
    this.document = document;
    this.currentStatus = { ...this.currentStatus, source: 'remote', version: document.version };
  }

  private snapshotPath(manifest: CatalogManifest): string {
    return path.join(this.directory, 'snapshots', `${manifest.sha256}.json`);
  }

  private async savePointer(current: CatalogManifest, previous?: CatalogManifest): Promise<void> {
    try {
      await configFileWriter.replace(path.join(this.directory, 'current.json'), `${JSON.stringify({
        current, ...(previous && { previous }),
      }, null, 2)}\n`);
    } catch (cause) {
      throw new CatalogUpdateError('storage', 'Unable to save the verified model catalog', { cause });
    }
  }

  private async pruneSnapshots(): Promise<void> {
    const directory = path.join(this.directory, 'snapshots');
    const keep = new Set([this.manifest?.sha256, this.previousManifest?.sha256]);
    for (const entry of await fs.readdir(directory)) {
      if (/^[a-f0-9]{64}\.json$/.test(entry) && !keep.has(entry.slice(0, -5))) {
        await fs.unlink(path.join(directory, entry));
      }
    }
  }

  private async download(relativePath: string, limit: number, signal: AbortSignal): Promise<Buffer> {
    const response = await this.fetch(new URL(relativePath, this.baseUrl), {
      signal,
      redirect: 'error',
      credentials: 'omit',
      headers: { accept: 'application/json' },
    });
    if (!response.ok || !response.body) {
      throw new CatalogUpdateError('network', `Model catalog HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new CatalogUpdateError('untrusted', 'Model catalog exceeds its size limit');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return Buffer.concat(chunks);
  }

  private report(error: unknown): void {
    try { this.options.onError?.(error); } catch { /* Diagnostics do not affect the offline catalog. */ }
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
