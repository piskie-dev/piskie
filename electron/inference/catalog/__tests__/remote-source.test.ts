import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testModel } from '../../control/__tests__/fixtures.js';
import {
  catalogHash, catalogSignaturePayload, MODEL_CATALOG_PATH,
  verifyCatalogDocument, verifyCatalogManifest, type CatalogManifest,
} from '../distribution.js';
import { RemoteCatalogSource, type RemoteCatalogOptions } from '../remote-source.js';

const pair = generateKeyPairSync('ed25519');
const keys = { example: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
const drivers = new Set(['fake']);
const directories: string[] = [];
const sources: RemoteCatalogSource[] = [];

function publication(revision: number, name = `Example ${revision}`) {
  const document = {
    version: name,
    models: [testModel({
      id: 'example/chat', displayName: name, source: { kind: 'remote', version: name },
    })],
  };
  const bytes = Buffer.from(JSON.stringify(document));
  const sha256 = catalogHash(bytes);
  const manifest = signed({
    schemaVersion: 1, revision, version: document.version, generatedAt: '2026-02-01T00:00:00.000Z',
    minClientVersion: '0.1.0', sha256, keyId: 'example', catalogPath: `${MODEL_CATALOG_PATH}/${sha256}.json`,
  });
  return { document, bytes, manifest };
}

function signed(manifest: Omit<CatalogManifest, 'signature'>): CatalogManifest {
  return { ...manifest, signature: sign(null, catalogSignaturePayload(manifest), pair.privateKey).toString('base64') };
}

async function fixture(overrides: Partial<RemoteCatalogOptions> = {}) {
  const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'example-catalog-'));
  directories.push(rootDirectory);
  let release = publication(1);
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) => (
    new Response(String(url).endsWith('/manifest.json')
      ? JSON.stringify(release.manifest) : new Uint8Array(release.bytes))
  ));
  const options: RemoteCatalogOptions = {
    rootDirectory, baseUrl: 'https://example.test', clientVersion: '0.1.0', keys, driverIds: drivers,
    bundledVersion: 'bundled-example', bundledGeneratedAt: '2026-01-01T00:00:00.000Z', fetch,
    ...overrides,
  };
  const create = (changes: Partial<RemoteCatalogOptions> = {}) => {
    const source = new RemoteCatalogSource({ ...options, ...changes });
    sources.push(source);
    return source;
  };
  return {
    rootDirectory, fetch, create, source: create(), setRelease: (next: typeof release) => { release = next; },
    pointer: () => fs.readFile(path.join(rootDirectory, 'catalog/remote/current.json'), 'utf8'),
  };
}

afterEach(async () => {
  await Promise.all(sources.splice(0).map((source) => source.close()));
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('signed model catalog boundary', () => {
  it('verifies both signature and exact content bytes and ignores unknown read fields', () => {
    const release = publication(1);
    const manifest = verifyCatalogManifest({ ...release.manifest, futureField: true }, keys, '0.1.0');
    expect(verifyCatalogDocument(release.bytes, manifest, drivers)).toEqual(release.document);
  });

  it('rejects modified signatures, foreign paths, content changes and unknown signing keys', () => {
    const { manifest, bytes } = publication(1);
    for (const changed of [
      { ...manifest, revision: 2 },
      { ...manifest, catalogPath: 'https://elsewhere.test/catalog.json' },
      { ...manifest, keyId: 'unknown' },
    ]) expect(() => verifyCatalogManifest(changed, keys, '0.1.0')).toThrow();
    expect(() => verifyCatalogDocument(Buffer.concat([bytes, Buffer.from(' ')]), manifest, drivers)).toThrow();
  });

  it('enforces client and driver compatibility before activation', () => {
    const { manifest, bytes } = publication(1);
    expect(() => verifyCatalogManifest(signed({ ...manifest, minClientVersion: '2.0.0' }), keys, '1.0.0'))
      .toThrow('newer application');
    expect(() => verifyCatalogDocument(bytes, manifest, new Set(['different-driver'])))
      .toThrow('unsupported inference capabilities');
  });
});

describe('RemoteCatalogSource', () => {
  it('starts offline without a request and restores a verified cached update on the next launch', async () => {
    const { source, fetch, create } = await fixture();
    expect(await source.load()).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(await source.refresh()).toMatchObject({ state: 'updated', source: 'remote', version: 'Example 1' });
    expect(await create().load()).toEqual(publication(1).document);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error', credentials: 'omit', headers: { accept: 'application/json' } });
  });

  it('refreshes in the background after startup and every six hours, then stops on close', async () => {
    const { source, fetch } = await fixture();
    await source.initialize();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    source.start();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await source.refresh();
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    await source.refresh();
    expect(fetch).toHaveBeenCalledTimes(3);
    await source.close();
    await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('aborts an in-flight background download when the application closes', async () => {
    const { source, fetch } = await fixture();
    await source.initialize();
    const entered = Promise.withResolvers<AbortSignal>();
    fetch.mockImplementation(async (_url, options) => {
      const signal = options!.signal!;
      entered.resolve(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const refreshing = source.refresh();
    const signal = await entered.promise;
    await source.close();
    expect(signal.aborted).toBe(true);
    expect(await refreshing).toMatchObject({ state: 'error', source: 'bundled' });
    expect(await source.load()).toBeUndefined();
  });

  it('coalesces simultaneous refreshes', async () => {
    const { source, fetch } = await fixture();
    const first = source.refresh();
    expect(source.refresh()).toBe(first);
    await first;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps the last verified object and pointer when a download is corrupted or the network is unavailable', async () => {
    const { source, fetch, setRelease, pointer } = await fixture();
    await source.refresh();
    const previous = await pointer();
    setRelease({ ...publication(2), bytes: Buffer.from('{}') });
    expect(await source.refresh()).toMatchObject({ state: 'error', error: 'untrusted', version: 'Example 1' });
    expect(await pointer()).toBe(previous);
    fetch.mockRejectedValue(new Error('Offline'));
    expect(await source.refresh()).toMatchObject({ state: 'error', error: 'network', source: 'remote' });
    expect(await source.load()).toEqual(publication(1).document);
  });

  it('uses the previous verified snapshot if the current cached object is damaged', async () => {
    const { source, setRelease, rootDirectory, create } = await fixture();
    await source.refresh();
    setRelease(publication(2));
    await source.refresh();
    await fs.writeFile(path.join(rootDirectory, 'catalog/remote/snapshots', `${publication(2).manifest.sha256}.json`), '{}');
    expect(await create().load()).toEqual(publication(1).document);
  });

  it('prefers a newer bundled catalog over an old verified cache', async () => {
    const { source, create } = await fixture();
    await source.refresh();
    const upgraded = create({ bundledGeneratedAt: '2026-03-01T00:00:00.000Z' });
    expect(await upgraded.load()).toBeUndefined();
    expect(await upgraded.refresh()).toMatchObject({ state: 'current', source: 'bundled', version: 'bundled-example' });
  });

  it('persists a higher revision for identical content without downloading the same object again', async () => {
    const { source, setRelease, fetch, create, pointer } = await fixture();
    await source.refresh();
    setRelease(publication(3, 'Example 1'));
    expect(await source.refresh()).toMatchObject({ state: 'current' });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(JSON.parse(await pointer()).current.revision).toBe(3);
    setRelease(publication(2, 'Example 1'));
    expect(await create().refresh()).toMatchObject({ state: 'error', error: 'untrusted' });
  });

  it('retains only the current and previous complete snapshots', async () => {
    const { source, setRelease, rootDirectory } = await fixture();
    for (const revision of [1, 2, 3]) {
      setRelease(publication(revision));
      await source.refresh();
    }
    const entries = await fs.readdir(path.join(rootDirectory, 'catalog/remote/snapshots'));
    expect(entries.sort()).toEqual([2, 3].map((revision) => `${publication(revision).manifest.sha256}.json`).sort());
  });

  it('limits the manifest response before parsing or following its object path', async () => {
    const { source, fetch } = await fixture();
    fetch.mockImplementation(async () => new Response(' '.repeat(16 * 1024 + 1)));
    expect(await source.refresh()).toMatchObject({ state: 'error', error: 'untrusted', source: 'bundled' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('does not download a publication identical to the bundled snapshot', async () => {
    const release = publication(1);
    const { source, fetch, rootDirectory } = await fixture({ bundledSha256: release.manifest.sha256 });
    expect(await source.refresh()).toMatchObject({ state: 'current', source: 'bundled', version: 'bundled-example' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await source.load()).toBeUndefined();
    await expect(fs.access(path.join(rootDirectory, 'catalog/remote/current.json'))).rejects.toThrow();
  });
});
