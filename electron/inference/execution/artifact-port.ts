import type { ArtifactRef } from './contracts.js';

export interface ArtifactPayload {
  bytes: Uint8Array;
  mimeType: string;
  fileName?: string;
}

export interface ArtifactReader {
  read(ref: ArtifactRef, signal?: AbortSignal): Promise<ArtifactPayload>;
}

export interface ArtifactWriteInput extends ArtifactPayload {
  metadata?: Readonly<Record<string, unknown>>;
  expiresAt?: string;
}

export interface StoredArtifact {
  ref: ArtifactRef;
  mimeType: string;
  fileName?: string;
  byteLength: number;
  sha256: string;
  metadata: Readonly<Record<string, unknown>>;
  createdAt: string;
  expiresAt?: string;
}

export interface ArtifactWriter {
  write(input: ArtifactWriteInput, signal?: AbortSignal): Promise<StoredArtifact>;
}

export interface ArtifactStore extends ArtifactReader, ArtifactWriter {
  info(ref: ArtifactRef): Promise<StoredArtifact>;
}
