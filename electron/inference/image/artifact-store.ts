import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ArtifactPayload,
  ArtifactStore,
  ArtifactWriteInput,
  StoredArtifact,
} from '../execution/artifact-port.js';
import type { ArtifactRef } from '../execution/contracts.js';
import { configFileWriter } from '../../config/core/atomic-file-writer.js';
import type { ImageArtifact } from './contracts.js';

export class ArtifactStoreError extends Error {
  constructor(
    readonly code: 'ARTIFACT_ID_INVALID' | 'ARTIFACT_NOT_FOUND' | 'ARTIFACT_CORRUPT' | 'ARTIFACT_EXPIRED',
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ArtifactStoreError';
  }
}

interface LocalArtifactRecord extends StoredArtifact {
  schemaVersion: 1;
}

export interface LocalImageArtifactStoreOptions {
  now?: () => Date;
}

export class LocalImageArtifactStore implements ArtifactStore {
  private readonly now: () => Date;

  constructor(
    readonly directory: string,
    options: LocalImageArtifactStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async write(input: ArtifactWriteInput, signal?: AbortSignal): Promise<StoredArtifact> {
    signal?.throwIfAborted();
    const sha256 = crypto.createHash('sha256').update(input.bytes).digest('hex');
    const ref = { artifactId: `artifact:sha256:${sha256}` };
    const record: LocalArtifactRecord = {
      schemaVersion: 1,
      ref,
      mimeType: input.mimeType,
      ...(input.fileName && { fileName: input.fileName }),
      byteLength: input.bytes.byteLength,
      sha256,
      metadata: structuredClone(input.metadata ?? {}),
      createdAt: this.now().toISOString(),
      ...(input.expiresAt && { expiresAt: input.expiresAt }),
    };
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const bytesPath = this.bytesPath(sha256);
    try {
      await fs.writeFile(bytesPath, input.bytes, { flag: 'wx', mode: 0o600 });
    } catch (cause) {
      if (!isNodeError(cause, 'EEXIST')) throw cause;
      const existing = await fs.readFile(bytesPath);
      const existingHash = crypto.createHash('sha256').update(existing).digest('hex');
      if (existingHash !== sha256) {
        throw new ArtifactStoreError('ARTIFACT_CORRUPT', `Existing artifact bytes are corrupt: ${ref.artifactId}`);
      }
    }
    const metadataPath = this.metadataPath(sha256);
    try {
      await fs.access(metadataPath);
    } catch {
      await configFileWriter.replace(metadataPath, `${JSON.stringify(record, null, 2)}\n`);
    }
    return this.info(ref);
  }

  async read(ref: ArtifactRef, signal?: AbortSignal): Promise<ArtifactPayload> {
    signal?.throwIfAborted();
    const record = await this.info(ref);
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(this.bytesPath(record.sha256));
    } catch (cause) {
      throw new ArtifactStoreError(
        'ARTIFACT_NOT_FOUND',
        `Artifact bytes not found: ${ref.artifactId}`,
        { artifactId: ref.artifactId },
        { cause },
      );
    }
    const actualHash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== record.sha256) {
      throw new ArtifactStoreError(
        'ARTIFACT_CORRUPT',
        `Artifact hash mismatch: ${ref.artifactId}`,
        { artifactId: ref.artifactId, expectedHash: record.sha256, actualHash },
      );
    }
    return {
      bytes: Uint8Array.from(bytes),
      mimeType: record.mimeType,
      ...(record.fileName && { fileName: record.fileName }),
    };
  }

  async info(ref: ArtifactRef): Promise<StoredArtifact> {
    const sha256 = parseArtifactId(ref.artifactId);
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(this.metadataPath(sha256), 'utf8'));
    } catch (cause) {
      throw new ArtifactStoreError(
        'ARTIFACT_NOT_FOUND',
        `Artifact metadata not found: ${ref.artifactId}`,
        { artifactId: ref.artifactId },
        { cause },
      );
    }
    const record = parseRecord(raw, ref.artifactId, sha256);
    if (record.expiresAt && new Date(record.expiresAt).getTime() <= this.now().getTime()) {
      throw new ArtifactStoreError(
        'ARTIFACT_EXPIRED',
        `Artifact expired: ${ref.artifactId}`,
        { artifactId: ref.artifactId, expiresAt: record.expiresAt },
      );
    }
    return toStoredArtifact(record);
  }

  private bytesPath(sha256: string): string {
    return path.join(this.directory, `${sha256}.bin`);
  }

  private metadataPath(sha256: string): string {
    return path.join(this.directory, `${sha256}.json`);
  }
}

export class MemoryArtifactStore implements ArtifactStore {
  private readonly records = new Map<string, { stored: StoredArtifact; bytes: Uint8Array }>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async write(input: ArtifactWriteInput, signal?: AbortSignal): Promise<StoredArtifact> {
    signal?.throwIfAborted();
    const sha256 = crypto.createHash('sha256').update(input.bytes).digest('hex');
    const ref = { artifactId: `artifact:sha256:${sha256}` };
    const stored: StoredArtifact = {
      ref,
      mimeType: input.mimeType,
      ...(input.fileName && { fileName: input.fileName }),
      byteLength: input.bytes.byteLength,
      sha256,
      metadata: structuredClone(input.metadata ?? {}),
      createdAt: this.now().toISOString(),
      ...(input.expiresAt && { expiresAt: input.expiresAt }),
    };
    this.records.set(ref.artifactId, { stored, bytes: Uint8Array.from(input.bytes) });
    return structuredClone(stored);
  }

  async read(ref: ArtifactRef, signal?: AbortSignal): Promise<ArtifactPayload> {
    signal?.throwIfAborted();
    const entry = this.records.get(ref.artifactId);
    if (!entry) throw new ArtifactStoreError('ARTIFACT_NOT_FOUND', `Artifact not found: ${ref.artifactId}`);
    return {
      bytes: Uint8Array.from(entry.bytes),
      mimeType: entry.stored.mimeType,
      ...(entry.stored.fileName && { fileName: entry.stored.fileName }),
    };
  }

  async info(ref: ArtifactRef): Promise<StoredArtifact> {
    const entry = this.records.get(ref.artifactId);
    if (!entry) throw new ArtifactStoreError('ARTIFACT_NOT_FOUND', `Artifact not found: ${ref.artifactId}`);
    return structuredClone(entry.stored);
  }
}

export function toImageArtifact(stored: StoredArtifact): ImageArtifact {
  return {
    artifactId: stored.ref.artifactId,
    mimeType: stored.mimeType,
    byteLength: stored.byteLength,
    sha256: stored.sha256,
    ...numberMetadata(stored.metadata, 'width'),
    ...numberMetadata(stored.metadata, 'height'),
    ...numberMetadata(stored.metadata, 'seed'),
    ...(typeof stored.metadata.revisedPrompt === 'string' && {
      revisedPrompt: stored.metadata.revisedPrompt,
    }),
  };
}

function numberMetadata(
  metadata: Readonly<Record<string, unknown>>,
  field: 'width' | 'height' | 'seed',
): Partial<Record<'width' | 'height' | 'seed', number>> {
  const value = metadata[field];
  return typeof value === 'number' ? { [field]: value } : {};
}

function parseArtifactId(artifactId: string): string {
  const match = /^artifact:sha256:([a-f0-9]{64})$/.exec(artifactId);
  if (!match) throw new ArtifactStoreError('ARTIFACT_ID_INVALID', `Invalid artifact ID: ${artifactId}`);
  return match[1]!;
}

function parseRecord(raw: unknown, artifactId: string, sha256: string): LocalArtifactRecord {
  if (!isRecord(raw)
    || raw.schemaVersion !== 1
    || !isRecord(raw.ref)
    || raw.ref.artifactId !== artifactId
    || raw.sha256 !== sha256
    || typeof raw.mimeType !== 'string'
    || typeof raw.byteLength !== 'number'
    || !isRecord(raw.metadata)
    || typeof raw.createdAt !== 'string') {
    throw new ArtifactStoreError('ARTIFACT_CORRUPT', `Artifact metadata is corrupt: ${artifactId}`);
  }
  return raw as unknown as LocalArtifactRecord;
}

function toStoredArtifact(record: LocalArtifactRecord): StoredArtifact {
  return {
    ref: structuredClone(record.ref),
    mimeType: record.mimeType,
    ...(record.fileName && { fileName: record.fileName }),
    byteLength: record.byteLength,
    sha256: record.sha256,
    metadata: structuredClone(record.metadata),
    createdAt: record.createdAt,
    ...(record.expiresAt && { expiresAt: record.expiresAt }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
