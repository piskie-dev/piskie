import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getHostEnvironment,
  initializeHostEnvironment,
  prependToPath,
} from '../../../environment/host-environment.js';
import {
  installConfigCliLauncher,
  renderWindowsLauncher,
} from '../launcher.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('Piskie CLI launcher', () => {
  it.runIf(process.platform !== 'win32')(
    'publishes an executable POSIX command that forwards args and the config root',
    async () => {
      const userDataDirectory = await temporaryDirectory();
      const cliEntryPath = path.join(userDataDirectory, 'fake-cli.mjs');
      await writeFile(cliEntryPath, [
        'process.stdout.write(JSON.stringify({',
        '  args: process.argv.slice(2),',
        '  root: process.env.PISKIE_CONFIG_ROOT,',
        '  runAsNode: process.env.ELECTRON_RUN_AS_NODE,',
        '}));',
      ].join('\n'));
      await chmod(cliEntryPath, 0o644);
      const environment: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };

      const result = await installConfigCliLauncher({
        userDataDirectory,
        cliEntryPath,
        executablePath: process.execPath,
        environment,
        platform: 'linux',
      });

      expect(environment.PATH?.split(':')[0]).toBe(result.directory);
      expect((await stat(result.commandPath)).mode & 0o111).not.toBe(0);
      const execution = await execFileAsync(result.commandPath, ['config', 'show', 'value with spaces']);
      expect(JSON.parse(execution.stdout)).toEqual({
        args: ['config', 'show', 'value with spaces'],
        root: userDataDirectory,
        runAsNode: '1',
      });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'refreshes a stale POSIX launcher and keeps its PATH entry unique', async () => {
      const userDataDirectory = await temporaryDirectory();
      const cliEntryPath = path.join(userDataDirectory, 'fake-cli.mjs');
      await writeFile(cliEntryPath, '');
      const launcherDirectory = path.join(userDataDirectory, 'bin');
      const environment: NodeJS.ProcessEnv = {
        PATH: `/usr/bin:${launcherDirectory}:${launcherDirectory}`,
      };

      const first = await installConfigCliLauncher({
        userDataDirectory,
        cliEntryPath,
        executablePath: process.execPath,
        environment,
        platform: 'linux',
      });
      await writeFile(first.commandPath, 'stale');
      await installConfigCliLauncher({
        userDataDirectory,
        cliEntryPath,
        executablePath: process.execPath,
        environment,
        platform: 'linux',
      });

      expect((await readFile(first.commandPath, 'utf8')).startsWith('#!/bin/sh')).toBe(true);
      expect(environment.PATH?.split(':').filter((entry) => entry === launcherDirectory)).toHaveLength(1);
      expect(environment.PATH?.split(':')[0]).toBe(launcherDirectory);
    },
  );

  it('renders a Windows cmd launcher with safe percent escaping', () => {
    const launcher = renderWindowsLauncher(
      String.raw`C:\Program Files\Piskie%20\Piskie.exe`,
      String.raw`C:\Program Files\Piskie%20\resources\app\config-cli\main.js`,
      String.raw`C:\Users\100% User\.piskie`,
    );

    expect(launcher).toContain('set "PISKIE_CONFIG_ROOT=C:\\Users\\100%% User\\.piskie"');
    expect(launcher).toContain('set "ELECTRON_RUN_AS_NODE=1"');
    expect(launcher).toContain('"C:\\Program Files\\Piskie%%20\\Piskie.exe"');
    expect(launcher).toContain('%*');
  });

  it.runIf(process.platform === 'win32')(
    'executes the Windows launcher from a userData path containing spaces, Unicode, and percent signs',
    async () => {
      const root = await temporaryDirectory();
      const userDataDirectory = path.join(root, '100% User', '配置');
      await mkdir(userDataDirectory, { recursive: true });
      const cliEntryPath = path.join(userDataDirectory, 'fake-cli.mjs');
      await writeFile(cliEntryPath, [
        'process.stdout.write(JSON.stringify({',
        '  args: process.argv.slice(2),',
        '  root: process.env.PISKIE_CONFIG_ROOT,',
        '  runAsNode: process.env.ELECTRON_RUN_AS_NODE,',
        '}));',
      ].join('\n'));
      const environment: NodeJS.ProcessEnv = { Path: process.env.Path };
      const result = await installConfigCliLauncher({
        userDataDirectory,
        cliEntryPath,
        executablePath: process.execPath,
        environment,
        platform: 'win32',
      });

      const execution = await execFileAsync(result.commandPath, [
        'config', 'show', 'value with spaces',
      ], { shell: true });
      expect(JSON.parse(execution.stdout)).toEqual({
        args: ['config', 'show', 'value with spaces'],
        root: userDataDirectory,
        runAsNode: '1',
      });
    },
  );

  it('uses the existing case-preserved Windows Path key', () => {
    const environment: NodeJS.ProcessEnv = { Path: String.raw`C:\Windows\System32;C:\Tools` };

    prependToPath(environment, String.raw`C:\Piskie\bin`, 'win32');
    prependToPath(environment, String.raw`c:\piskie\bin`, 'win32');

    expect(environment.PATH).toBeUndefined();
    expect(environment.Path).toBe(String.raw`c:\piskie\bin;C:\Windows\System32;C:\Tools`);
  });

  it.runIf(process.platform !== 'win32')(
    'replays the launcher directory after the host environment snapshot is initialized',
    async () => {
      const originalPath = process.env.PATH;
      const userDataDirectory = await temporaryDirectory();
      const cliEntryPath = path.join(userDataDirectory, 'fake-cli.mjs');
      const marker = '__PISKIE_LAUNCHER_ENV_TEST__:';
      await writeFile(cliEntryPath, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');

      try {
        await initializeHostEnvironment({
          environment: { PATH: '/usr/bin:/bin' },
          marker,
          platform: 'linux',
          shell: '/bin/bash',
          runProcess: async () => `${marker}${Buffer.from(JSON.stringify({
            PATH: '/usr/bin:/bin',
          }), 'utf8').toString('base64')}\n`,
        });
        const launcher = await installConfigCliLauncher({
          userDataDirectory,
          cliEntryPath,
          executablePath: process.execPath,
          platform: 'linux',
        });

        const environment = getHostEnvironment();
        expect(environment.PATH?.split(':')[0]).toBe(launcher.directory);
        expect(environment.PATH?.split(':').filter((entry) => entry === launcher.directory))
          .toHaveLength(1);
        const execution = await execFileAsync('/bin/bash', ['-c', 'piskie help --json'], {
          env: environment,
        });
        expect(JSON.parse(execution.stdout)).toEqual(['help', '--json']);
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
    },
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'piskie-cli-launcher-'));
  temporaryDirectories.push(directory);
  return directory;
}
