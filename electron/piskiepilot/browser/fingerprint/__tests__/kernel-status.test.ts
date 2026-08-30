import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPilotRoot, setPilotRoot } from '@electron/piskiepilot/paths.js';
import {
  getKernelStatus,
  resolveExecutable,
} from '../binary.js';
import {
  ensureBinary,
  FPC_RELEASE,
  getDownloadProgress,
  hasAssetForHost,
} from '../downloader.js';
import { cacheExecPath } from '../host.js';
import { getLegalSeedLawVersion } from '../seed.js';

const originalRoot = getPilotRoot();
const originalEnvPath = process.env.FP_CHROMIUM_PATH;
const originalFetch = globalThis.fetch;
let root: string;

function writeExecutable(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, '#!/bin/sh\nexit 0\n');
  chmodSync(filePath, 0o755);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'piskie-kernel-status-'));
  setPilotRoot(root);
  delete process.env.FP_CHROMIUM_PATH;
});

afterEach(() => {
  if (originalEnvPath === undefined) delete process.env.FP_CHROMIUM_PATH;
  else process.env.FP_CHROMIUM_PATH = originalEnvPath;
  globalThis.fetch = originalFetch;
  setPilotRoot(originalRoot);
  rmSync(root, { recursive: true, force: true });
});

describe('fingerprint-chromium asset availability', () => {
  it('pins the managed release to the seed-law version', () => {
    const releaseMajor = FPC_RELEASE.tag.match(/^fpc-(\d+)\./)?.[1];
    expect(releaseMajor).toBe(getLegalSeedLawVersion());
  });

  it('publishes verified assets for the supported production hosts', () => {
    expect(hasAssetForHost('darwin-arm64')).toBe(true);
    expect(hasAssetForHost('win32-x64')).toBe(true);
    expect(hasAssetForHost('linux-x64')).toBe(true);
    expect(FPC_RELEASE.assets['win32-x64'].sha256).toBe(
      'b4d91ba966622c92d094336afba8a3031bf7ea372c04904508b650d58df6fb4d',
    );
  });

  it('rejects unsupported hosts and assets without a SHA', () => {
    expect(hasAssetForHost('darwin-x64')).toBe(false);
    const asset = FPC_RELEASE.assets['linux-x64'];
    const originalSha = asset.sha256;
    try {
      asset.sha256 = '';
      expect(hasAssetForHost('linux-x64')).toBe(false);
    } finally {
      asset.sha256 = originalSha;
    }
  });
});

describe('kernel status', () => {
  it('keeps byte totals in the latest progress snapshot for late subscribers', async () => {
    const body = new Uint8Array([1, 2, 3]);
    globalThis.fetch = async () => new Response(body, {
      status: 200,
      headers: { 'content-length': String(body.byteLength) },
    });

    await expect(ensureBinary('darwin-arm64')).rejects.toThrow('sha256 不匹配');
    expect(getDownloadProgress('darwin-arm64')).toMatchObject({
      phase: 'error',
      received: body.byteLength,
      total: body.byteLength,
    });
  });

  it('uses an explicit development executable without downloading', async () => {
    const executable = join(root, 'custom-fpc');
    writeExecutable(executable);
    process.env.FP_CHROMIUM_PATH = executable;

    expect(getKernelStatus('darwin-arm64')).toMatchObject({
      hostKey: 'darwin-arm64',
      installed: true,
      hasAsset: true,
      version: FPC_RELEASE.tag,
    });
    await expect(resolveExecutable()).resolves.toBe(executable);
  });

  it('recognizes the cached executable without extra runtime auditing', () => {
    const executable = cacheExecPath('darwin-arm64')!;
    writeExecutable(executable);

    expect(getKernelStatus('darwin-arm64')).toMatchObject({
      installed: true,
      hasAsset: true,
    });
  });
});
