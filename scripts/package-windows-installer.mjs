import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputDirectory = path.join(projectRoot, 'release', 'artifacts');
const unpackedDirectory = path.join(outputDirectory, 'win-unpacked');
const temporaryUnpackedDirectory = `${unpackedDirectory}.tmp`;
const builderCli = path.join(projectRoot, 'node_modules', 'electron-builder', 'cli.js');
const packageVerifier = path.join(projectRoot, 'scripts', 'verify-packaged-app.mjs');

async function cleanStagingDirectories() {
  await Promise.all([
    removeDirectory(unpackedDirectory),
    removeDirectory(temporaryUnpackedDirectory),
  ]);
}

async function removeDirectory(directory) {
  await fs.rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 500,
  });
}

async function detachStagingDirectory() {
  const detachedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-windows-package-'));
  const detachedUnpackedDirectory = path.join(detachedRoot, 'win-unpacked');
  const relativeToProject = path.relative(projectRoot, detachedUnpackedDirectory);
  if (!relativeToProject.startsWith('..') && !path.isAbsolute(relativeToProject)) {
    await removeDirectory(detachedRoot);
    throw new Error(`Package smoke directory must be outside the project: ${detachedRoot}`);
  }

  // Isolate the package so module resolution cannot borrow dependencies from the workspace.
  try {
    await moveDirectoryAcrossDevices(unpackedDirectory, detachedUnpackedDirectory);
  } catch (error) {
    await removeDirectory(detachedRoot);
    throw error;
  }
  return { detachedRoot, detachedUnpackedDirectory };
}

async function renameWithRetries(source, destination, rename) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (
        attempt >= 5
        || !error
        || typeof error !== 'object'
        || !['EBUSY', 'EPERM'].includes(error.code)
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

export async function moveDirectoryAcrossDevices(source, destination, operations = {}) {
  const rename = operations.rename ?? fs.rename;
  const copy = operations.copy ?? fs.cp;
  const remove = operations.remove ?? removeDirectory;

  try {
    await renameWithRetries(source, destination, rename);
    return;
  } catch (error) {
    if (!error || typeof error !== 'object' || error.code !== 'EXDEV') throw error;
  }

  try {
    await copy(source, destination, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    await remove(source);
  } catch (error) {
    try {
      await remove(destination);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Failed to move ${source} across devices and clean ${destination}`,
      );
    }
    throw error;
  }
}

function runBuilder() {
  return runProcess(process.execPath, [builderCli, '--win', 'nsis', '--x64'], 'electron-builder');
}

function runProcess(executable, args, label, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: projectRoot,
      stdio: 'inherit',
      windowsHide: true,
      ...options,
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} exited unsuccessfully (${code ?? signal ?? 'unknown'})`));
    });
  });
}

async function assertRegularFile(filePath, label) {
  const stats = await fs.stat(filePath).catch(() => undefined);
  if (!stats?.isFile() || stats.size === 0) {
    throw new Error(`${label} is missing or empty: ${filePath}`);
  }
}

async function validatePackage(stagingDirectory, smokeRoot) {
  const entries = await fs.readdir(outputDirectory, { withFileTypes: true });
  const installers = entries.filter(
    (entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.exe',
  );
  const zipFiles = entries.filter(
    (entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.zip',
  );
  if (installers.length !== 1) {
    throw new Error(`Expected exactly one NSIS installer, found ${installers.length}`);
  }
  if (zipFiles.length > 0) {
    throw new Error(`ZIP artifacts are not allowed: ${zipFiles.map(({ name }) => name).join(', ')}`);
  }

  const installerPath = path.join(outputDirectory, installers[0].name);
  const packagedResources = path.join(stagingDirectory, 'resources');
  const packagedExecutable = path.join(stagingDirectory, 'Piskie.exe');
  await Promise.all([
    assertRegularFile(installerPath, 'NSIS installer'),
    assertRegularFile(packagedExecutable, 'Packaged application executable'),
    assertRegularFile(path.join(packagedResources, 'app.asar'), 'ASAR application archive'),
    assertRegularFile(
      path.join(
        packagedResources,
        'app.asar.unpacked',
        'node_modules',
        '@vscode',
        'ripgrep-win32-x64',
        'bin',
        'rg.exe',
      ),
      'Unpacked ripgrep executable',
    ),
  ]);
  await runProcess(
    packagedExecutable,
    [packageVerifier, path.join(packagedResources, 'app.asar'), smokeRoot],
    'Packaged application smoke test',
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_PATH: '',
      },
    },
  );
  return installerPath;
}

async function keepOnlyInstaller(installerPath) {
  const entries = await fs.readdir(outputDirectory, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(outputDirectory, entry.name);
    if (entryPath === installerPath) return;
    await fs.rm(entryPath, {
      recursive: entry.isDirectory(),
      force: true,
      maxRetries: 5,
      retryDelay: 500,
    });
  }));
}

export async function packageWindowsInstaller() {
  await removeDirectory(outputDirectory);
  await fs.mkdir(outputDirectory, { recursive: true });
  let succeeded = false;
  let detachedRoot;
  try {
    await runBuilder();
    const detached = await detachStagingDirectory();
    detachedRoot = detached.detachedRoot;
    const installerPath = await validatePackage(
      detached.detachedUnpackedDirectory,
      path.join(detachedRoot, 'smoke'),
    );
    await removeDirectory(detachedRoot);
    detachedRoot = undefined;
    await keepOnlyInstaller(installerPath);
    succeeded = true;
    console.log(`Windows installer created: ${installerPath}`);
  } finally {
    await cleanStagingDirectories();
    if (detachedRoot) await removeDirectory(detachedRoot);
    if (!succeeded) await removeDirectory(outputDirectory);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await packageWindowsInstaller();
}
