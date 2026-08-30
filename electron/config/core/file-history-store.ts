import fs from 'node:fs/promises';
import path from 'node:path';
import type { VersionedConfigDocument } from '../contracts/repository.js';
import { ConfigRepositoryError } from '../contracts/repository.js';
import {
  configFileWriter,
  type AtomicFileWriter,
} from './atomic-file-writer.js';
import { CONFIG_HISTORY_RETENTION } from './storage-layout.js';

export interface ConfigHistoryCodec<T extends VersionedConfigDocument> {
  serialize(document: T): string;
  parse(source: string, filePath: string): T;
}

export class FileConfigHistoryStore<T extends VersionedConfigDocument> {
  constructor(
    private readonly domain: string,
    readonly directory: string,
    private readonly codec: ConfigHistoryCodec<T>,
    private readonly writer: AtomicFileWriter = configFileWriter,
  ) {}

  async read(revision: number): Promise<T> {
    const filePath = this.filePath(revision);
    let source: string;
    try {
      source = await fs.readFile(filePath, 'utf8');
    } catch (cause) {
      if (isNodeError(cause, 'ENOENT')) {
        throw new ConfigRepositoryError(
          'CONFIG_HISTORY_NOT_FOUND',
          `${this.domain} config history revision not found: ${revision}`,
          { domain: this.domain, revision, filePath },
        );
      }
      throw new ConfigRepositoryError(
        'CONFIG_READ_FAILED',
        `Unable to read ${this.domain} config history revision ${revision}`,
        { domain: this.domain, revision, filePath },
        { cause },
      );
    }
    const document = this.codec.parse(source, filePath);
    if (document.revision !== revision) {
      throw new ConfigRepositoryError(
        'CONFIG_INVALID',
        `${this.domain} config history revision does not match its file name`,
        {
          domain: this.domain,
          expectedRevision: revision,
          actualRevision: document.revision,
          filePath,
        },
      );
    }
    return document;
  }

  async revisions(): Promise<number[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.directory);
    } catch (cause) {
      if (isNodeError(cause, 'ENOENT')) return [];
      throw new ConfigRepositoryError(
        'CONFIG_READ_FAILED',
        `Unable to read ${this.domain} config history`,
        { domain: this.domain, historyDirectory: this.directory },
        { cause },
      );
    }
    return names
      .map((name) => /^(\d{8,})\.json$/.exec(name)?.[1])
      .filter((revision): revision is string => revision !== undefined)
      .map(Number)
      .sort((left, right) => left - right);
  }

  async write(document: T): Promise<boolean> {
    const filePath = this.filePath(document.revision);
    try {
      return await this.writer.create(filePath, this.codec.serialize(document));
    } catch (cause) {
      throw new ConfigRepositoryError(
        'CONFIG_WRITE_FAILED',
        `Unable to write ${this.domain} config history revision ${document.revision}`,
        { domain: this.domain, revision: document.revision, filePath },
        { cause },
      );
    }
  }

  async remove(revision: number): Promise<void> {
    const filePath = this.filePath(revision);
    try {
      await fs.unlink(filePath);
    } catch (cause) {
      if (isNodeError(cause, 'ENOENT')) return;
      throw new ConfigRepositoryError(
        'CONFIG_WRITE_FAILED',
        `Unable to prune ${this.domain} config history revision ${revision}`,
        { domain: this.domain, revision, filePath },
        { cause },
      );
    }
  }

  async prune(): Promise<readonly number[]> {
    const revisions = await this.revisions();
    const removed = revisions.slice(0, Math.max(0, revisions.length - CONFIG_HISTORY_RETENTION));
    await Promise.all(removed.map((revision) => this.remove(revision)));
    return removed;
  }

  private filePath(revision: number): string {
    if (!Number.isInteger(revision) || revision < 0) {
      throw new ConfigRepositoryError(
        'CONFIG_HISTORY_NOT_FOUND',
        `Invalid ${this.domain} config history revision: ${revision}`,
        { domain: this.domain, revision },
      );
    }
    return path.join(this.directory, `${String(revision).padStart(8, '0')}.json`);
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
