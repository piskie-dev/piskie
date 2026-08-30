import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ConfigRepositoryError,
  type VersionedConfigDocument,
  type VersionedConfigRepositoryPaths,
} from '../contracts/repository.js';
import { FileConfigHistoryStore } from './file-history-store.js';
import { parsePersistedConfig } from './persisted-config-parser.js';
import {
  configFileWriter,
  type AtomicFileWriter,
} from './atomic-file-writer.js';

export interface VersionedConfigCodec<T extends VersionedConfigDocument> {
  parse(raw: unknown, filePath: string): T;
  serialize?(document: T): string;
}

export interface VersionedFileConfigRepositoryOptions<T extends VersionedConfigDocument> {
  domain: string;
  paths: VersionedConfigRepositoryPaths;
  codec: VersionedConfigCodec<T>;
  writer?: AtomicFileWriter;
  onHistoryMaintenanceError?: (error: unknown) => void;
}

export class VersionedFileConfigRepository<T extends VersionedConfigDocument> {
  private readonly writer: AtomicFileWriter;
  private readonly serialize: (document: T) => string;
  private readonly historyStore: FileConfigHistoryStore<T>;

  constructor(private readonly options: VersionedFileConfigRepositoryOptions<T>) {
    this.writer = options.writer ?? configFileWriter;
    this.serialize = options.codec.serialize ?? serializeJsonDocument;
    this.historyStore = new FileConfigHistoryStore(
      options.domain,
      options.paths.historyDirectory,
      {
        serialize: this.serialize,
        parse: (source, filePath) => this.parseSource(source, filePath),
      },
      this.writer,
    );
  }

  async exists(): Promise<boolean> {
    try {
      await fs.access(this.options.paths.configFile);
      return true;
    } catch (cause) {
      if (isNodeError(cause, 'ENOENT')) return false;
      throw new ConfigRepositoryError(
        'CONFIG_READ_FAILED',
        `Unable to inspect ${this.options.domain} config`,
        { domain: this.options.domain, filePath: this.options.paths.configFile },
        { cause },
      );
    }
  }

  async initialize(document: T): Promise<void> {
    this.assertRevision(document);
    await fs.mkdir(path.dirname(this.options.paths.configFile), { recursive: true, mode: 0o700 });
    await this.withLock(async () => {
      if (await this.exists()) {
        throw new ConfigRepositoryError(
          'CONFIG_REVISION_CONFLICT',
          `${this.options.domain} config already exists`,
          { domain: this.options.domain },
        );
      }
      await this.writer.replace(this.options.paths.configFile, this.serialize(document));
      await this.historyStore.write(document);
      await this.historyStore.prune();
    });
  }

  read(): Promise<T> {
    return this.readDocument(this.options.paths.configFile, 'CONFIG_NOT_FOUND');
  }

  readRevision(revision: number): Promise<T> {
    return this.historyStore.read(revision);
  }

  async history(): Promise<readonly number[]> {
    await this.historyStore.prune();
    return this.historyStore.revisions();
  }

  pruneHistory(): Promise<readonly number[]> {
    return this.historyStore.prune();
  }

  async commit(candidate: T, expectedRevision: number): Promise<T> {
    return this.withLock(async () => {
      const current = await this.read();
      if (current.revision !== expectedRevision) {
        throw new ConfigRepositoryError(
          'CONFIG_REVISION_CONFLICT',
          `Expected ${this.options.domain} revision ${expectedRevision}, found ${current.revision}`,
          {
            domain: this.options.domain,
            expectedRevision,
            actualRevision: current.revision,
          },
        );
      }

      const next = { ...candidate, revision: current.revision + 1 } as T;
      await this.historyStore.write(current);
      const nextHistoryCreated = await this.historyStore.write(next);
      try {
        await this.writer.replace(this.options.paths.configFile, this.serialize(next));
      } catch (cause) {
        if (nextHistoryCreated) await this.historyStore.remove(next.revision).catch(() => undefined);
        await this.maintainHistory();
        if (cause instanceof ConfigRepositoryError) throw cause;
        throw new ConfigRepositoryError(
          'CONFIG_WRITE_FAILED',
          `Unable to atomically write ${this.options.domain} revision ${next.revision}`,
          { domain: this.options.domain, revision: next.revision },
          { cause },
        );
      }
      await this.maintainHistory();
      return next;
    });
  }

  private async readDocument(
    filePath: string,
    missingCode: 'CONFIG_NOT_FOUND',
  ): Promise<T> {
    let source: string;
    try {
      source = await fs.readFile(filePath, 'utf8');
    } catch (cause) {
      if (isNodeError(cause, 'ENOENT')) {
        throw new ConfigRepositoryError(
          missingCode,
          `${this.options.domain} config file not found: ${filePath}`,
          { domain: this.options.domain, filePath },
        );
      }
      throw new ConfigRepositoryError(
        'CONFIG_READ_FAILED',
        `Unable to read ${this.options.domain} config: ${filePath}`,
        { domain: this.options.domain, filePath },
        { cause },
      );
    }
    return this.parseSource(source, filePath);
  }

  private parseSource(source: string, filePath: string): T {
    let raw: unknown;
    try {
      raw = JSON.parse(source);
    } catch (cause) {
      throw new ConfigRepositoryError(
        'CONFIG_INVALID',
        `${this.options.domain} config is not valid JSON: ${filePath}`,
        { domain: this.options.domain, filePath },
        { cause },
      );
    }
    try {
      const document = parsePersistedConfig(
        raw,
        (candidate) => this.options.codec.parse(candidate, filePath),
      );
      this.assertRevision(document);
      return document;
    } catch (cause) {
      if (cause instanceof ConfigRepositoryError) throw cause;
      throw new ConfigRepositoryError(
        'CONFIG_INVALID',
        `${this.options.domain} config failed schema validation: ${filePath}`,
        { domain: this.options.domain, filePath },
        { cause },
      );
    }
  }

  private assertRevision(document: VersionedConfigDocument): void {
    if (!Number.isInteger(document.revision) || document.revision < 0) {
      throw new ConfigRepositoryError(
        'CONFIG_INVALID',
        `${this.options.domain} config revision must be a non-negative integer`,
        { domain: this.options.domain, revision: document.revision },
      );
    }
  }

  private async maintainHistory(): Promise<void> {
    try {
      await this.historyStore.prune();
    } catch (error) {
      try {
        this.options.onHistoryMaintenanceError?.(error);
      } catch {
        // History diagnostics cannot change the outcome of an atomic config commit.
      }
    }
  }

  private async withLock<R>(operation: () => Promise<R>): Promise<R> {
    await fs.mkdir(path.dirname(this.options.paths.lockFile), { recursive: true, mode: 0o700 });
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(this.options.paths.lockFile, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      await handle.sync();
    } catch (cause) {
      if (isNodeError(cause, 'EEXIST')) {
        throw new ConfigRepositoryError(
          'CONFIG_LOCKED',
          `${this.options.domain} config is locked by another writer`,
          { domain: this.options.domain },
        );
      }
      throw new ConfigRepositoryError(
        'CONFIG_WRITE_FAILED',
        `Unable to acquire ${this.options.domain} config lock`,
        { domain: this.options.domain },
        { cause },
      );
    }

    try {
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      await fs.unlink(this.options.paths.lockFile).catch(() => undefined);
    }
  }
}

function serializeJsonDocument<T>(document: T): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
