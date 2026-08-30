import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SANDBOX_FALLBACK_ENV = 'PISKIE_ELECTRON_SANDBOX_FALLBACK';

const require = createRequire(import.meta.url);

export function resolveElectronBinary(loadElectronPackage = () => require('electron')) {
  const binaryPath = loadElectronPackage();
  if (typeof binaryPath !== 'string' || binaryPath.length === 0) {
    throw new Error('The electron package did not resolve to an executable path');
  }
  return binaryPath;
}

export function assessLinuxSandbox({
  binaryPath,
  statHelper = fs.statSync,
  probeUserNamespace = probeUnprivilegedUserNamespace,
}) {
  const helperPath = path.join(path.dirname(binaryPath), 'chrome-sandbox');
  let helperState;
  try {
    const stat = statHelper(helperPath);
    helperState =
      stat.isFile() && stat.uid === 0 && (stat.mode & 0o7777) === 0o4755
        ? 'available'
        : 'invalid-setuid-helper';
  } catch (error) {
    helperState = error?.code === 'ENOENT' ? 'missing-setuid-helper' : 'unreadable-setuid-helper';
  }
  if (helperState === 'available') return Object.freeze({ mode: 'setuid', args: [] });
  return resolveWithoutSetuidHelper(helperState, probeUserNamespace);
}

export function buildElectronInvocation({
  binaryPath,
  appPath,
  passthroughArgs = [],
  platform = process.platform,
  environment = process.env,
  sandboxAssessment,
}) {
  const explicitNoSandbox = passthroughArgs.some(
    (argument) => argument === '--no-sandbox' || argument.startsWith('--no-sandbox=')
  );
  const sandbox = explicitNoSandbox
    ? Object.freeze({ mode: 'disabled', args: [], reason: 'explicit-no-sandbox-switch' })
    : platform === 'linux'
      ? (sandboxAssessment ?? assessLinuxSandbox({ binaryPath }))
      : Object.freeze({ mode: 'default', args: [] });
  const childEnvironment = { ...environment };
  delete childEnvironment.ELECTRON_RUN_AS_NODE;
  delete childEnvironment[SANDBOX_FALLBACK_ENV];
  if (sandbox.mode === 'disabled') childEnvironment[SANDBOX_FALLBACK_ENV] = '1';

  return Object.freeze({
    binaryPath,
    args: Object.freeze([...sandbox.args, ...(appPath ? [appPath] : []), ...passthroughArgs]),
    environment: Object.freeze(childEnvironment),
    sandbox,
  });
}

export function parseLauncherArguments(argumentsList) {
  let binaryPath;
  let appPath;
  let index = 0;
  for (; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--') {
      index += 1;
      break;
    }
    if (argument === '--binary' || argument === '--app') {
      const value = argumentsList[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === '--binary') binaryPath = value;
      else appPath = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown launcher argument: ${argument}`);
  }
  return Object.freeze({
    binaryPath: binaryPath ? path.resolve(binaryPath) : undefined,
    appPath: appPath ? path.resolve(appPath) : undefined,
    passthroughArgs: Object.freeze(argumentsList.slice(index)),
  });
}

function resolveWithoutSetuidHelper(helperState, probeUserNamespace) {
  const userNamespace = probeUserNamespace();
  if (userNamespace === 'available') {
    return Object.freeze({
      mode: 'user-namespace',
      args: Object.freeze(['--disable-setuid-sandbox']),
      reason: helperState,
    });
  }
  if (userNamespace === 'unavailable') {
    return Object.freeze({
      mode: 'disabled',
      args: Object.freeze(['--no-sandbox', '--disable-setuid-sandbox']),
      reason: `${helperState}-and-user-namespace-unavailable`,
    });
  }
  return Object.freeze({
    mode: 'unknown',
    args: Object.freeze([]),
    reason: `${helperState}-and-user-namespace-probe-inconclusive`,
  });
}

function probeUnprivilegedUserNamespace() {
  const unsharePath = ['/usr/bin/unshare', '/bin/unshare'].find(fs.existsSync);
  const truePath = ['/usr/bin/true', '/bin/true'].find(fs.existsSync);
  if (!unsharePath || !truePath) return 'unknown';
  const result = spawnSync(unsharePath, ['--user', '--map-root-user', truePath], {
    stdio: 'ignore',
    timeout: 1_000,
  });
  if (result.error) return 'unknown';
  if (result.status === 0) return 'available';
  return typeof result.status === 'number' || result.signal ? 'unavailable' : 'unknown';
}

async function main() {
  let parsed;
  try {
    const argumentsConfig = parseLauncherArguments(process.argv.slice(2));
    parsed = Object.freeze({
      ...argumentsConfig,
      binaryPath: argumentsConfig.binaryPath ?? resolveElectronBinary(),
    });
  } catch (error) {
    process.stderr.write(`[electron-launcher] ${error.message}\n`);
    process.exitCode = 2;
    return;
  }

  const invocation = buildElectronInvocation(parsed);
  if (invocation.sandbox.mode === 'disabled') {
    process.stderr.write(
      `[electron-launcher] Chromium sandbox unavailable (${invocation.sandbox.reason}); ` +
        'starting Electron with --no-sandbox\n'
    );
  }

  const child = spawn(invocation.binaryPath, invocation.args, {
    env: invocation.environment,
    stdio: 'inherit',
  });
  const forwardedSignals = ['SIGINT', 'SIGTERM'];
  const signalHandlers = new Map(
    forwardedSignals.map((signal) => [
      signal,
      () => {
        if (!child.killed) child.kill(signal);
      },
    ])
  );
  for (const [signal, handler] of signalHandlers) process.on(signal, handler);

  const exitCode = await new Promise((resolve) => {
    child.once('error', (error) => {
      process.stderr.write(`[electron-launcher] Failed to start Electron: ${error.message}\n`);
      resolve(1);
    });
    child.once('exit', (code, signal) => {
      resolve(code ?? (signal ? 128 : 1));
    });
  });
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  process.exitCode = exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
