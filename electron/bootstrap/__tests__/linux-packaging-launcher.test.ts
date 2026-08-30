import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const installLinuxElectronLauncher = require('../../../build/after-pack.cjs');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.promises.rm(directory, { recursive: true, force: true }))
  );
});

describe('Linux packaging launcher', () => {
  it('moves the Electron binary behind the external sandbox launcher', async () => {
    const appOutDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'piskie-linux-pack-'));
    temporaryDirectories.push(appOutDir);
    const executablePath = path.join(appOutDir, 'piskie');
    await fs.promises.writeFile(executablePath, 'electron-binary');
    await fs.promises.chmod(executablePath, 0o755);

    await installLinuxElectronLauncher({
      electronPlatformName: 'linux',
      appOutDir,
      packager: { executableName: 'piskie' },
    });

    expect(await fs.promises.readFile(`${executablePath}.bin`, 'utf8')).toBe('electron-binary');
    const launcher = await fs.promises.readFile(executablePath, 'utf8');
    expect(launcher).toContain('ELECTRON_RUN_AS_NODE=1');
    expect(launcher).toContain('resources/launcher/electron-launcher.mjs');
    await expect(
      fs.promises.readFile(
        path.join(appOutDir, 'resources', 'launcher', 'electron-launcher.mjs'),
        'utf8'
      )
    ).resolves.toContain('assessLinuxSandbox');
    expect((await fs.promises.stat(executablePath)).mode & 0o777).toBe(0o755);
  });

  it('does not alter non-Linux packages', async () => {
    const appOutDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'piskie-mac-pack-'));
    temporaryDirectories.push(appOutDir);

    await expect(
      installLinuxElectronLauncher({
        electronPlatformName: 'darwin',
        appOutDir,
        packager: { executableName: 'Piskie' },
      })
    ).resolves.toBeUndefined();
    await expect(fs.promises.readdir(appOutDir)).resolves.toEqual([]);
  });
});
