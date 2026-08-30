import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface DerivedFile {
  upstreamPath: string;
  localPath: string;
  upstreamSha256: string;
  modifications: string;
}

interface Provenance {
  package: string;
  version: string;
  commit: string;
  npmIntegrity: string;
  npmShasum: string;
  tarballSha256: string;
  license: string;
  licenseFile: string;
  noticeFile: string;
  upstreamPuppeteer: string;
  runtimePuppeteerCore: string;
  derivedFiles: DerivedFile[];
  behavioralReferences: string[];
}

const root = resolve(fileURLToPath(new URL('../../../../../', import.meta.url)));
const attributionRoot = resolve(
  root,
  'electron/piskiepilot/browser/third_party/chrome-devtools-mcp-1.7.0'
);

describe('chrome-devtools-mcp 1.7.0 provenance', () => {
  it('pins the official release and carries its Apache-2.0 attribution', async () => {
    const provenance = await readProvenance();
    expect(provenance).toMatchObject({
      package: 'chrome-devtools-mcp',
      version: '1.7.0',
      commit: '774d78f5eef5e610407a0c92fa6ec5ed74b027e8',
      npmIntegrity:
        'sha512-6xFW7oiUxTxZuHcfyYBkKQtmttjCbfifKZMSEk5CV8H2FucvKweYiJr8CblddYHtYjA4C14K9VAs1r49906RBA==',
      npmShasum: 'b20e2ee77afb585e2e762535c37ca9336e7445a4',
      tarballSha256: '895733586a0ece138493790c07e8b083b8571b1d2037a73124334d968d1046d0',
      license: 'Apache-2.0',
      licenseFile: 'LICENSE',
      noticeFile: 'NOTICE',
      upstreamPuppeteer: '25.5.0',
      runtimePuppeteerCore: '25.9.0',
    });

    const license = await readFile(resolve(attributionRoot, provenance.licenseFile), 'utf8');
    expect(license).toContain('Apache License');
    expect(license).toContain('Version 2.0, January 2004');
    expect(license).toContain('Copyright [yyyy] [name of copyright owner]');

    const notice = await readFile(resolve(attributionRoot, provenance.noticeFile), 'utf8');
    expect(notice).toContain('chrome-devtools-mcp 1.7.0');
    expect(notice).toContain('Copyright 2025 Google LLC');
    expect(notice).toContain(provenance.commit);
    expect(notice).toContain('provenance.json');
  });

  it('marks every source-derived local file and records its upstream digest', async () => {
    const provenance = await readProvenance();
    expect(provenance.derivedFiles.length).toBeGreaterThan(0);
    expect(provenance.behavioralReferences).toEqual(
      expect.arrayContaining(provenance.derivedFiles.map((entry) => entry.upstreamPath))
    );

    for (const entry of provenance.derivedFiles) {
      expect(entry.upstreamPath).toMatch(/^src\/.+\.ts$/);
      expect(entry.localPath).toMatch(/^electron\/piskiepilot\/browser\/.+\.ts$/);
      expect(entry.upstreamSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.modifications.trim()).not.toBe('');

      const localSource = await readFile(resolve(root, entry.localPath), 'utf8');
      expect(localSource).toMatch(/Copyright 202[56] Google LLC/);
      expect(localSource).toContain('SPDX-License-Identifier: Apache-2.0');
      expect(localSource).toContain('Modified by Piskie Team, 2026.');
    }
  });
});

async function readProvenance(): Promise<Provenance> {
  return JSON.parse(
    await readFile(resolve(attributionRoot, 'provenance.json'), 'utf8')
  ) as Provenance;
}
