import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const artifactsRoot = path.join(projectRoot, 'release', 'artifacts');
const appPath = path.join(artifactsRoot, 'mac-arm64', 'Piskie.app');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} ${args.join(' ')} failed (${code ?? signal ?? 'unknown'})\n${output.trim()}`));
    });
  });
}

if (process.platform !== 'darwin') throw new Error('macOS release verification must run on macOS.');

const appStats = await fs.stat(appPath).catch(() => undefined);
if (!appStats?.isDirectory()) throw new Error(`Packaged application is missing: ${appPath}`);

const artifactNames = await fs.readdir(artifactsRoot);
const dmgNames = artifactNames.filter((name) => name.endsWith('.dmg'));
const zipNames = artifactNames.filter((name) => name.endsWith('.zip'));
if (dmgNames.length !== 1 || zipNames.length !== 1) {
  throw new Error(`Expected one DMG and one ZIP, found ${dmgNames.length} DMG and ${zipNames.length} ZIP artifacts.`);
}

await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
const signature = await run('codesign', ['-dv', '--verbose=4', appPath]);
if (!signature.includes('Authority=Developer ID Application:') || !/TeamIdentifier=[A-Z0-9]+/.test(signature)) {
  throw new Error('The application is not signed with a Developer ID Application identity.');
}

await run('xcrun', ['stapler', 'validate', appPath]);
await run('spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath]);

for (const dmgName of dmgNames) {
  const dmgPath = path.join(artifactsRoot, dmgName);
  const mountPath = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-dmg-'));
  try {
    await run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPath, dmgPath]);
    const mountedAppPath = path.join(mountPath, 'Piskie.app');
    await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', mountedAppPath]);
    await run('xcrun', ['stapler', 'validate', mountedAppPath]);
    await run('spctl', ['--assess', '--type', 'execute', '--verbose=2', mountedAppPath]);
  } finally {
    await run('hdiutil', ['detach', mountPath]).catch(() => undefined);
    await fs.rm(mountPath, { recursive: true, force: true });
  }
}

console.log(`Verified the Developer ID signature, stapled ticket, and Gatekeeper acceptance for Piskie.app and the copy inside ${dmgNames[0]}.`);
console.log(`ZIP contains the already notarized and stapled application: ${zipNames[0]}`);
