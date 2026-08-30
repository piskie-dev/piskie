import { createUuid } from '@shared/utils/identifiers.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { configFileWriter } from '../../config/core/atomic-file-writer.js';
import type { ImageArtifact, ImageJobRef, ImageRequest, ImageUsage } from './contracts.js';

export type ImageJobStatus = 'observing' | 'completed' | 'failed' | 'cancelled';

export interface ImageJobRecord {
  schemaVersion: 1;
  journalId: string;
  job: ImageJobRef;
  request: ImageRequest;
  driverState?: unknown;
  status: ImageJobStatus;
  artifacts: readonly ImageArtifact[];
  usage: ImageUsage;
  createdAt: string;
  updatedAt: string;
  error?: unknown;
}

export interface CreateImageJobInput {
  providerId: string;
  modelId: string;
  driverId: string;
  configRevision: number;
  upstreamJobId: string;
  resumable: boolean;
  request: ImageRequest;
  driverState?: unknown;
}

export class ImageJobJournalError extends Error {
  constructor(
    readonly code: 'IMAGE_JOB_ID_INVALID' | 'IMAGE_JOB_NOT_FOUND' | 'IMAGE_JOB_CORRUPT',
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ImageJobJournalError';
  }
}

export class ImageJobJournal {
  constructor(
    readonly directory: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(input: CreateImageJobInput): Promise<ImageJobRecord> {
    const journalId = createUuid();
    const timestamp = this.now().toISOString();
    const record: ImageJobRecord = {
      schemaVersion: 1,
      journalId,
      job: {
        journalId,
        providerId: input.providerId,
        modelId: input.modelId,
        driverId: input.driverId,
        configRevision: input.configRevision,
        upstreamJobId: input.upstreamJobId,
        resumable: input.resumable,
      },
      request: structuredClone(input.request),
      ...(input.driverState !== undefined && { driverState: structuredClone(input.driverState) }),
      status: 'observing',
      artifacts: [],
      usage: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.write(record);
    return record;
  }

  async read(journalId: string): Promise<ImageJobRecord> {
    const filePath = this.filePath(journalId);
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (cause) {
      if (isNodeError(cause, 'ENOENT')) {
        throw new ImageJobJournalError(
          'IMAGE_JOB_NOT_FOUND',
          `Image job journal not found: ${journalId}`,
          { journalId },
          { cause },
        );
      }
      throw new ImageJobJournalError(
        'IMAGE_JOB_CORRUPT',
        `Image job journal is unreadable: ${journalId}`,
        { journalId },
        { cause },
      );
    }
    return parseRecord(raw, journalId);
  }

  async update(
    journalId: string,
    update: {
      status?: ImageJobStatus;
      artifacts?: readonly ImageArtifact[];
      usage?: ImageUsage;
      error?: unknown;
    },
  ): Promise<ImageJobRecord> {
    const current = await this.read(journalId);
    const next: ImageJobRecord = {
      ...current,
      ...update,
      ...(update.artifacts && { artifacts: structuredClone(update.artifacts) }),
      ...(update.usage && { usage: structuredClone(update.usage) }),
      updatedAt: this.now().toISOString(),
    };
    await this.write(next);
    return next;
  }

  async listResumable(): Promise<readonly ImageJobRecord[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.directory);
    } catch (cause) {
      if (isNodeError(cause, 'ENOENT')) return [];
      throw cause;
    }
    const records: ImageJobRecord[] = [];
    for (const name of names.sort()) {
      const match = /^([0-9a-f-]{36})\.json$/i.exec(name);
      if (!match) continue;
      const record = await this.read(match[1]!);
      if (record.status === 'observing' && record.job.resumable) records.push(record);
    }
    return records;
  }

  private async write(record: ImageJobRecord): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await configFileWriter.replace(
      this.filePath(record.journalId),
      `${JSON.stringify(record, null, 2)}\n`,
    );
  }

  private filePath(journalId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(journalId)) {
      throw new ImageJobJournalError('IMAGE_JOB_ID_INVALID', `Invalid image job journal ID: ${journalId}`);
    }
    return path.join(this.directory, `${journalId}.json`);
  }
}

function parseRecord(raw: unknown, journalId: string): ImageJobRecord {
  if (!isRecord(raw)
    || raw.schemaVersion !== 1
    || raw.journalId !== journalId
    || !isRecord(raw.job)
    || raw.job.journalId !== journalId
    || typeof raw.job.providerId !== 'string'
    || typeof raw.job.modelId !== 'string'
    || typeof raw.job.driverId !== 'string'
    || typeof raw.job.configRevision !== 'number'
    || typeof raw.job.upstreamJobId !== 'string'
    || typeof raw.job.resumable !== 'boolean'
    || !isRecord(raw.request)
    || !['observing', 'completed', 'failed', 'cancelled'].includes(String(raw.status))
    || !Array.isArray(raw.artifacts)
    || !isRecord(raw.usage)
    || typeof raw.createdAt !== 'string'
    || typeof raw.updatedAt !== 'string') {
    throw new ImageJobJournalError(
      'IMAGE_JOB_CORRUPT',
      `Image job journal has an invalid structure: ${journalId}`,
      { journalId },
    );
  }
  return raw as unknown as ImageJobRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
