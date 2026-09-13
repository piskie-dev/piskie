import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import packageJson from '../../../../package.json' with { type: 'json' };
import trustedKeys from '../../../../shared/ai-model-catalog/trusted-keys.json' with { type: 'json' };
import { InferenceRuntimeHost } from '../../composition/runtime-host.js';
import { bundledCatalogManifest } from '../bundled-source.js';
import { verifyCatalogDocument, verifyCatalogManifest } from '../distribution.js';

const catalogBytes = fs.readFileSync(
  new URL('../../../../shared/ai-model-catalog/generated/catalog.json', import.meta.url),
);

describe('bundled catalog snapshot', () => {
  it('is a trusted publication whose bytes, drivers and definitions satisfy the runtime contract', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'piskie-bundled-snapshot-'));
    const host = new InferenceRuntimeHost({ rootDirectory: root });
    try {
      const driverIds = new Set(host.drivers.list().map((driver) => driver.manifest.id));
      const manifest = verifyCatalogManifest(bundledCatalogManifest, trustedKeys, packageJson.version);
      const document = verifyCatalogDocument(new Uint8Array(catalogBytes), manifest, driverIds);

      expect(document.version).toBe(manifest.version);
      expect(document.models.length).toBeGreaterThan(0);
    } finally {
      await host.close();
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
