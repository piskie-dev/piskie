import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertConfigDomainManifestSources,
  CONFIG_DOMAIN_IDS,
  type ConfigDomainManifestError,
} from '../manifest.js';

const domainsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('Config Domain manifest', () => {
  it('contains every adapter source and points only to existing adapter sources', async () => {
    const sourceFiles = await fs.readdir(domainsDirectory);

    expect(() => assertConfigDomainManifestSources(sourceFiles)).not.toThrow();
  });

  it('fails with a stable error when an adapter is added without registration', async () => {
    const sourceFiles = await fs.readdir(domainsDirectory);

    expect(() => assertConfigDomainManifestSources([
      ...sourceFiles,
      'forgotten.adapter.ts',
    ])).toThrowError(expect.objectContaining<Partial<ConfigDomainManifestError>>({
      code: 'CONFIG_DOMAIN_UNREGISTERED',
      details: { unregistered: ['forgotten'] },
    }));
  });

  it('fails when a manifest entry no longer has an adapter source', async () => {
    const sourceFiles = await fs.readdir(domainsDirectory);
    const removedId = CONFIG_DOMAIN_IDS[0]!;

    expect(() => assertConfigDomainManifestSources(
      sourceFiles.filter((file) => file !== `${removedId}.adapter.ts`),
    )).toThrowError(expect.objectContaining<Partial<ConfigDomainManifestError>>({
      code: 'CONFIG_DOMAIN_SOURCE_MISSING',
      details: { missingSources: [removedId] },
    }));
  });
});
