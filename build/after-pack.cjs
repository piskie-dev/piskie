const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function installLinuxElectronLauncher(context) {
  if (context.electronPlatformName !== 'linux') return;

  const executablePath = path.join(context.appOutDir, context.packager.executableName);
  const realBinaryPath = `${executablePath}.bin`;
  const launcherPath = path.join(__dirname, 'linux-electron-launcher.sh');
  const launcherResourceDirectory = path.join(context.appOutDir, 'resources', 'launcher');

  await fs.rename(executablePath, realBinaryPath);
  await fs.mkdir(launcherResourceDirectory, { recursive: true });
  await fs.copyFile(
    path.join(__dirname, '..', 'scripts', 'electron-launcher.mjs'),
    path.join(launcherResourceDirectory, 'electron-launcher.mjs')
  );
  await fs.copyFile(launcherPath, executablePath);
  await fs.chmod(executablePath, 0o755);
};
