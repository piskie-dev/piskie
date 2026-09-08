import { createHash, createPublicKey, verify } from 'node:crypto';
import { gte, valid } from 'semver';
import { z } from 'zod';
import { isReasoningSelectionAllowed } from '../ai/reasoning-policy.js';
import { catalogDocumentSchema, type CatalogDocument } from './contracts.js';

export const MODEL_CATALOG_PATH = '/api/v1/model-catalog';
export const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
export const MIN_CATALOG_CLIENT_VERSION = '0.1.0';
export type CatalogKeyring = Readonly<Record<string, string>>;

export const catalogManifestSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  version: z.string().min(1).max(200),
  generatedAt: z.iso.datetime(),
  minClientVersion: z.string().refine((value) => valid(value) !== null),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  keyId: z.string().min(1).max(100),
  catalogPath: z.string(),
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
}).strip();

export type CatalogManifest = z.infer<typeof catalogManifestSchema>;
export type CatalogUpdateErrorKind = 'network' | 'untrusted' | 'incompatible' | 'storage';

export class CatalogUpdateError extends Error {
  constructor(readonly kind: CatalogUpdateErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CatalogUpdateError';
  }
}

export function catalogSignaturePayload(manifest: Omit<CatalogManifest, 'signature'>): Buffer {
  return Buffer.from(JSON.stringify([
    'piskie-model-catalog',
    manifest.schemaVersion,
    manifest.revision,
    manifest.version,
    manifest.generatedAt,
    manifest.minClientVersion,
    manifest.sha256,
    manifest.keyId,
    manifest.catalogPath,
  ]));
}

export function catalogHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function verifyCatalogManifest(raw: unknown, keys: CatalogKeyring, clientVersion: string): CatalogManifest {
  const parsed = catalogManifestSchema.safeParse(raw);
  if (!parsed.success) throw new CatalogUpdateError('incompatible', 'Unsupported model catalog manifest');
  const manifest = parsed.data;
  if (manifest.catalogPath !== `${MODEL_CATALOG_PATH}/${manifest.sha256}.json`) {
    throw new CatalogUpdateError('untrusted', 'Model catalog path does not match its content hash');
  }
  const key = keys[manifest.keyId];
  let trusted = false;
  try {
    const publicKey = key && createPublicKey(key);
    trusted = Boolean(publicKey && publicKey.asymmetricKeyType === 'ed25519'
      && verify(null, catalogSignaturePayload(manifest), publicKey, Buffer.from(manifest.signature, 'base64')));
  } catch {
    trusted = false;
  }
  if (!trusted) throw new CatalogUpdateError('untrusted', 'Model catalog signature is not trusted');
  if (!valid(clientVersion) || !gte(clientVersion, manifest.minClientVersion)) {
    throw new CatalogUpdateError('incompatible', 'Model catalog requires a newer application version');
  }
  return manifest;
}

export function verifyCatalogDocument(
  bytes: Uint8Array,
  manifest: CatalogManifest,
  driverIds: ReadonlySet<string>,
): CatalogDocument {
  if (bytes.byteLength > MAX_CATALOG_BYTES || catalogHash(bytes) !== manifest.sha256) {
    throw new CatalogUpdateError('untrusted', 'Model catalog content hash does not match');
  }
  let document: CatalogDocument;
  try {
    document = catalogDocumentSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch (cause) {
    throw new CatalogUpdateError('incompatible', 'Unsupported model catalog document', { cause });
  }
  if (document.version !== manifest.version || document.models.length === 0) {
    throw new CatalogUpdateError('untrusted', 'Model catalog version or inventory does not match');
  }
  const ids = new Set<string>();
  for (const model of document.models) {
    if (ids.has(model.id) || model.source.kind !== 'remote') {
      throw new CatalogUpdateError('untrusted', 'Model catalog contains duplicate IDs or invalid provenance');
    }
    ids.add(model.id);
    if (model.compatibleDrivers.some((id) => !driverIds.has(id))
      || (model.reasoning && !isReasoningSelectionAllowed(model.reasoning.defaultSelection, model.reasoning))) {
      throw new CatalogUpdateError('incompatible', 'Model catalog requires unsupported inference capabilities');
    }
  }
  return document;
}
