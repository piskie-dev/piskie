#!/usr/bin/env node

import { createHash, createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { gte, valid } from 'semver';
import packageJson from '../../package.json' with { type: 'json' };
import trustedKeys from '../../shared/ai-model-catalog/trusted-keys.json' with { type: 'json' };

/**
 * Pulls the signed model catalog published by the website into the bundled baseline, or verifies
 * the checked-in baseline offline with `--check`. The bundled files are the exact published object
 * bytes plus their manifest, so the same signature and content hash protect both the website
 * publication and the desktop build.
 */

const MODEL_CATALOG_PATH = '/api/v1/model-catalog';
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
const DEFAULT_ORIGIN = 'https://www.piskie.dev';
const SAMPLE_LIMIT = 20;

const root = path.resolve(import.meta.dirname, '../..');
const generatedDirectory = path.join(root, 'shared/ai-model-catalog/generated');
const manifestFile = path.join(generatedDirectory, 'manifest.json');
const catalogFile = path.join(generatedDirectory, 'catalog.json');

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function decodeJson(bytes, label) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (cause) {
    return fail(`${label} is not valid JSON: ${cause.message}`);
  }
}

function signaturePayload(manifest) {
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

function verifyManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Model catalog manifest must be an object');
  if (raw.schemaVersion !== 1) fail(`Unsupported model catalog manifest schema: ${raw.schemaVersion}`);
  if (!Number.isSafeInteger(raw.revision) || raw.revision <= 0) fail('Invalid model catalog revision');
  if (typeof raw.version !== 'string' || raw.version.length === 0) fail('Missing model catalog version');
  if (!Number.isFinite(Date.parse(raw.generatedAt))) fail('Invalid model catalog publication date');
  if (!valid(raw.minClientVersion)) fail('Invalid model catalog minimum client version');
  if (!/^[a-f0-9]{64}$/.test(raw.sha256)) fail('Invalid model catalog content hash');
  if (raw.catalogPath !== `${MODEL_CATALOG_PATH}/${raw.sha256}.json`) {
    fail('Model catalog path does not match its content hash');
  }
  if (typeof raw.keyId !== 'string' || !Object.hasOwn(trustedKeys, raw.keyId)) {
    fail(`Model catalog signing key is not trusted: ${raw.keyId}`);
  }
  if (!/^[A-Za-z0-9+/]{86}==$/.test(raw.signature)) fail('Invalid model catalog signature encoding');
  const manifest = {
    schemaVersion: raw.schemaVersion,
    revision: raw.revision,
    version: raw.version,
    generatedAt: raw.generatedAt,
    minClientVersion: raw.minClientVersion,
    sha256: raw.sha256,
    keyId: raw.keyId,
    catalogPath: raw.catalogPath,
    signature: raw.signature,
  };
  const publicKey = createPublicKey(trustedKeys[manifest.keyId]);
  if (publicKey.asymmetricKeyType !== 'ed25519'
    || !verify(null, signaturePayload(manifest), publicKey, Buffer.from(manifest.signature, 'base64'))) {
    fail('Model catalog signature is not trusted');
  }
  if (!gte(packageJson.version, manifest.minClientVersion)) {
    fail(`Model catalog requires application ${manifest.minClientVersion}; this repository is ${packageJson.version}`);
  }
  return manifest;
}

function verifyDocument(bytes, manifest) {
  if (bytes.byteLength > MAX_CATALOG_BYTES) fail('Model catalog exceeds its size limit');
  if (sha256(bytes) !== manifest.sha256) fail('Model catalog content hash does not match its manifest');
  const document = decodeJson(bytes, 'Model catalog');
  if (!document || typeof document !== 'object' || document.version !== manifest.version) {
    fail('Model catalog version does not match its manifest');
  }
  if (!Array.isArray(document.models) || document.models.length === 0) fail('Model catalog contains no models');
  const ids = new Set();
  for (const model of document.models) {
    if (!model || typeof model.id !== 'string' || model.id.length === 0) fail('Model catalog contains a model without an ID');
    if (ids.has(model.id)) fail(`Model catalog contains a duplicate model: ${model.id}`);
    ids.add(model.id);
    if (model.source?.kind !== 'remote') fail(`Model catalog provenance is invalid: ${model.id}`);
    if (!Array.isArray(model.compatibleDrivers) || model.compatibleDrivers.length === 0) {
      fail(`Model catalog entry has no compatible drivers: ${model.id}`);
    }
  }
  return document;
}

async function readSnapshot() {
  let manifestBytes;
  let bytes;
  try {
    [manifestBytes, bytes] = await Promise.all([fs.readFile(manifestFile), fs.readFile(catalogFile)]);
  } catch (cause) {
    if (cause?.code === 'ENOENT') return undefined;
    throw cause;
  }
  const manifest = verifyManifest(decodeJson(manifestBytes, 'Bundled model catalog manifest'));
  return { manifest, bytes, document: verifyDocument(bytes, manifest) };
}

function catalogOrigin() {
  const origin = new URL(process.env.PISKIE_MODEL_CATALOG_BASE_URL ?? DEFAULT_ORIGIN);
  const localhost = origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if ((origin.protocol !== 'https:' && !localhost) || origin.username || origin.password) {
    fail('PISKIE_MODEL_CATALOG_BASE_URL must use HTTPS or a localhost HTTP origin without credentials');
  }
  return origin;
}

async function download(origin, relativePath, limit) {
  const url = new URL(relativePath, origin);
  const response = await fetch(url, {
    redirect: 'error',
    headers: { accept: 'application/json', 'user-agent': 'piskie-model-catalog-pull' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) fail(`Model catalog HTTP ${response.status}: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > limit) fail(`Model catalog response exceeds ${limit} bytes: ${url}`);
  return bytes;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function describe(manifest, document) {
  return `${manifest.version} (revision ${manifest.revision}, published ${manifest.generatedAt}, `
    + `${document.models.length} models, sha256 ${manifest.sha256.slice(0, 16)}…)`;
}

function sample(ids) {
  const shown = ids.slice(0, SAMPLE_LIMIT).join(', ');
  return ids.length > SAMPLE_LIMIT ? `${shown}, … (${ids.length - SAMPLE_LIMIT} more)` : shown;
}

function reportChanges(previous, next) {
  if (!previous) {
    console.log('No previous bundled snapshot to compare against.');
    return;
  }
  const withoutSource = ({ source: _source, ...model }) => model;
  const before = new Map(previous.models.map((model) => [model.id, canonical(withoutSource(model))]));
  const after = new Map(next.models.map((model) => [model.id, canonical(withoutSource(model))]));
  const added = [...after.keys()].filter((id) => !before.has(id)).sort();
  const removed = [...before.keys()].filter((id) => !after.has(id)).sort();
  const changed = [...after].filter(([id, value]) => before.has(id) && before.get(id) !== value).map(([id]) => id).sort();
  console.log(`Compared with the previous snapshot: ${added.length} added, ${removed.length} removed, ${changed.length} changed.`);
  if (added.length > 0) console.log(`  added:   ${sample(added)}`);
  if (removed.length > 0) console.log(`  removed: ${sample(removed)}`);
  if (changed.length > 0) console.log(`  changed: ${sample(changed)}`);
}

async function checkSnapshot() {
  const snapshot = await readSnapshot();
  if (!snapshot) fail('The bundled model catalog is missing; run npm run catalog:pull');
  console.log(`Bundled model catalog is valid: ${describe(snapshot.manifest, snapshot.document)}`);
}

async function pullSnapshot() {
  const origin = catalogOrigin();
  let previous;
  try {
    previous = await readSnapshot();
  } catch (cause) {
    console.warn(`Ignoring the current bundled snapshot: ${cause.message}`);
  }
  const manifestBytes = await download(origin, `${MODEL_CATALOG_PATH}/manifest.json`, MAX_MANIFEST_BYTES);
  const manifest = verifyManifest(decodeJson(manifestBytes, 'Published model catalog manifest'));
  if (previous && manifest.revision < previous.manifest.revision) {
    fail(`Published revision ${manifest.revision} is older than the bundled revision ${previous.manifest.revision}`);
  }
  const bytes = previous && previous.manifest.sha256 === manifest.sha256
    ? previous.bytes
    : await download(origin, manifest.catalogPath, MAX_CATALOG_BYTES);
  const document = verifyDocument(bytes, manifest);
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  if (previous && previous.manifest.sha256 === manifest.sha256
    && canonical(previous.manifest) === canonical(manifest)) {
    console.log(`Bundled model catalog already matches the publication: ${describe(manifest, document)}`);
    return;
  }
  await fs.mkdir(generatedDirectory, { recursive: true });
  await fs.writeFile(catalogFile, bytes);
  await fs.writeFile(manifestFile, manifestText);
  console.log(`Bundled model catalog updated from ${origin.origin}: ${describe(manifest, document)}`);
  reportChanges(previous?.document, document);
}

try {
  if (process.argv.includes('--check')) await checkSnapshot();
  else await pullSnapshot();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
