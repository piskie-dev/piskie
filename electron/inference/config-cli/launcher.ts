import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  prependToPath,
  registerHostRuntimePath,
} from '../../environment/host-environment.js';

export interface ConfigCliLauncherOptions {
  userDataDirectory: string;
  cliEntryPath?: string;
  executablePath?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export interface ConfigCliLauncherResult {
  commandPath: string;
  directory: string;
}

export async function installConfigCliLauncher(
  options: ConfigCliLauncherOptions,
): Promise<ConfigCliLauncherResult> {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const cliEntryPath = options.cliEntryPath
    ?? fileURLToPath(new URL('../../cli/main.js', import.meta.url));
  const executablePath = options.executablePath ?? process.execPath;
  const directory = path.join(options.userDataDirectory, 'bin');
  const commandPath = path.join(directory, platform === 'win32' ? 'piskie.cmd' : 'piskie');

  await Promise.all([access(cliEntryPath), access(executablePath)]);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const content = platform === 'win32'
    ? renderWindowsLauncher(executablePath, cliEntryPath, options.userDataDirectory)
    : renderPosixLauncher(executablePath, cliEntryPath, options.userDataDirectory);
  await writeIfChanged(commandPath, content);
  if (platform !== 'win32') await chmod(commandPath, 0o755);

  prependToPath(environment, directory, platform);
  if (options.environment === undefined) registerHostRuntimePath(directory, platform);
  return { commandPath, directory };
}

export function renderPosixLauncher(
  executablePath: string,
  cliEntryPath: string,
  configRoot: string,
): string {
  return [
    '#!/bin/sh',
    `export PISKIE_CONFIG_ROOT=${quotePosix(configRoot)}`,
    'export ELECTRON_RUN_AS_NODE=1',
    `exec ${quotePosix(executablePath)} ${quotePosix(cliEntryPath)} "$@"`,
    '',
  ].join('\n');
}

export function renderWindowsLauncher(
  executablePath: string,
  cliEntryPath: string,
  configRoot: string,
): string {
  return [
    '@echo off',
    'setlocal',
    `set "PISKIE_CONFIG_ROOT=${escapeBatchValue(configRoot)}"`,
    'set "ELECTRON_RUN_AS_NODE=1"',
    `"${escapeBatchValue(executablePath)}" "${escapeBatchValue(cliEntryPath)}" %*`,
    '',
  ].join('\r\n');
}

async function writeIfChanged(filePath: string, content: string): Promise<void> {
  const current = await readFile(filePath, 'utf8').catch(() => undefined);
  if (current !== content) await writeFile(filePath, content, 'utf8');
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function escapeBatchValue(value: string): string {
  return value.replaceAll('%', '%%');
}
