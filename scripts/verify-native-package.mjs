import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputDirectory = path.join(projectRoot, 'release', 'artifacts');
const packageVerifier = path.join(projectRoot, 'scripts', 'verify-packaged-app.mjs');
const packageMetadata = JSON.parse(
  await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8')
);

async function getPackageLayout(temporaryRoot) {
  if (process.platform === 'linux' && process.arch === 'x64') {
    const debPath = path.join(
      outputDirectory,
      `${packageMetadata.name}_${packageMetadata.version}_amd64.deb`
    );
    await assertRegularFile(debPath, 'DEB artifact');

    const { stdout: control } = await execFileAsync('dpkg-deb', ['--field', debPath], {
      maxBuffer: 1024 * 1024,
    });
    assertControlField(control, 'Package', packageMetadata.name);
    assertControlField(control, 'Version', packageMetadata.version);
    assertControlField(control, 'Architecture', 'amd64');
    const dependencies = readControlField(control, 'Depends');
    for (const dependency of ['libgtk-3-0', 'libnss3', 'xdg-utils']) {
      if (!dependencies.includes(dependency)) {
        throw new Error(`DEB dependency metadata is missing ${dependency}`);
      }
    }
    if (/fuse/i.test(dependencies)) {
      throw new Error(`DEB package must not depend on FUSE: ${dependencies}`);
    }

    const root = path.join(temporaryRoot, 'deb-root');
    const controlRoot = path.join(temporaryRoot, 'deb-control');
    await Promise.all([
      fs.mkdir(root, { recursive: true }),
      fs.mkdir(controlRoot, { recursive: true }),
    ]);
    await Promise.all([
      execFileAsync('dpkg-deb', ['--extract', debPath, root]),
      execFileAsync('dpkg-deb', ['--control', debPath, controlRoot]),
    ]);

    const productName = packageMetadata.build?.productName ?? packageMetadata.name;
    const applicationRoot = path.join(root, 'opt', productName);
    const installedExecutable = path.posix.join('/opt', productName, 'piskie');
    const installedCommand = path.posix.join('/usr/bin', packageMetadata.name);
    const desktopFile = path.join(root, 'usr', 'share', 'applications', 'dev.piskie.desktop');
    const icon = path.join(
      root,
      'usr',
      'share',
      'icons',
      'hicolor',
      '256x256',
      'apps',
      'piskie.png'
    );
    const postInstall = path.join(controlRoot, 'postinst');
    await Promise.all([
      assertRegularFile(desktopFile, 'Installed desktop entry'),
      assertRegularFile(icon, 'Installed application icon'),
      assertRegularFile(postInstall, 'DEB post-install script'),
    ]);
    const [desktopEntry, postInstallScript] = await Promise.all([
      fs.readFile(desktopFile, 'utf8'),
      fs.readFile(postInstall, 'utf8'),
    ]);
    const configuredIcon = packageMetadata.build?.linux?.icon;
    if (typeof configuredIcon !== 'string') {
      throw new Error('Linux package configuration is missing its icon source');
    }
    const [installedIcon, sourceIcon] = await Promise.all([
      fs.readFile(icon),
      fs.readFile(path.join(projectRoot, configuredIcon)),
    ]);
    if (!installedIcon.equals(sourceIcon)) {
      throw new Error(`Installed application icon does not match ${configuredIcon}`);
    }
    for (const expectedLine of [
      `Exec=${installedExecutable} %U`,
      'Icon=piskie',
      'StartupWMClass=dev.piskie',
    ]) {
      if (!desktopEntry.split(/\r?\n/).includes(expectedLine)) {
        throw new Error(`Installed desktop entry is missing: ${expectedLine}`);
      }
    }
    for (const expectedPath of [installedExecutable, installedCommand]) {
      if (!postInstallScript.includes(expectedPath)) {
        throw new Error(`DEB post-install script is missing launcher path: ${expectedPath}`);
      }
    }

    return {
      executable: path.join(applicationRoot, 'piskie.bin'),
      appRoot: path.join(applicationRoot, 'resources', 'app.asar'),
      runtimeFiles: [
        [path.join(applicationRoot, 'piskie'), 'Packaged Linux launcher'],
        [
          path.join(applicationRoot, 'resources', 'launcher', 'electron-launcher.mjs'),
          'Packaged Electron launcher',
        ],
      ],
    };
  }
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    const root = path.join(outputDirectory, 'mac-arm64', 'Piskie.app', 'Contents');
    return {
      executable: path.join(root, 'MacOS', 'Piskie'),
      appRoot: path.join(root, 'Resources', 'app.asar'),
      runtimeFiles: [],
    };
  }
  throw new Error(`No native package layout is defined for ${process.platform}-${process.arch}`);
}

function readControlField(control, fieldName) {
  const lines = control.split(/\r?\n/);
  const prefix = `${fieldName}:`;
  const index = lines.findIndex((line) => line.startsWith(prefix));
  if (index < 0) throw new Error(`DEB control metadata is missing ${fieldName}`);
  const values = [lines[index].slice(prefix.length).trim()];
  for (let cursor = index + 1; cursor < lines.length && /^\s/.test(lines[cursor]); cursor += 1) {
    values.push(lines[cursor].trim());
  }
  return values.join(' ');
}

function assertControlField(control, fieldName, expected) {
  const actual = readControlField(control, fieldName);
  if (actual !== expected) {
    throw new Error(`DEB ${fieldName} must be ${expected}, received ${actual}`);
  }
}

async function assertRegularFile(filePath, label) {
  const stats = await fs.stat(filePath).catch(() => undefined);
  if (!stats?.isFile() || stats.size === 0) {
    throw new Error(`${label} is missing or empty: ${filePath}`);
  }
}

function runVerifier(executable, appRoot, smokeRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [packageVerifier, appRoot, smokeRoot], {
      cwd: projectRoot,
      stdio: 'inherit',
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_PATH: '',
      },
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Package verifier exited unsuccessfully (${code ?? signal ?? 'unknown'})`));
    });
  });
}

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'package-verification-'));
try {
  const { executable, appRoot, runtimeFiles } = await getPackageLayout(temporaryRoot);
  await Promise.all([
    assertRegularFile(executable, 'Packaged application executable'),
    assertRegularFile(appRoot, 'ASAR application archive'),
    ...runtimeFiles.map(([filePath, label]) => assertRegularFile(filePath, label)),
  ]);
  await runVerifier(executable, appRoot, path.join(temporaryRoot, 'smoke'));
  if (process.platform === 'linux') console.log('DEB metadata and desktop integration checks passed');
} finally {
  await fs.rm(temporaryRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 250,
  });
}
