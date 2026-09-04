import { spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const preflightOnly = process.argv.includes('--preflight-only');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: options.env ?? process.env,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} failed (${code ?? signal ?? 'unknown'})${stderr ? `\n${stderr.trim()}` : ''}`));
    });
  });
}

function hasAll(env, names) {
  return names.every((name) => Boolean(env[name]?.trim()));
}

async function prepareEnvironment() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error(`macOS release packaging requires darwin-arm64; current host is ${process.platform}-${process.arch}`);
  }

  await run('xcrun', ['-f', 'notarytool'], { capture: true });
  await run('xcrun', ['-f', 'stapler'], { capture: true });

  const env = { ...process.env };
  const usesApiKey = hasAll(env, ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']);
  const usesAppleId = hasAll(env, ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']);
  const usesKeychainProfile = Boolean(env.APPLE_KEYCHAIN_PROFILE?.trim());

  if (usesKeychainProfile) {
    const profileArgs = ['notarytool', 'history', '--keychain-profile', env.APPLE_KEYCHAIN_PROFILE.trim()];
    if (env.APPLE_KEYCHAIN?.trim()) profileArgs.push('--keychain', env.APPLE_KEYCHAIN.trim());
    await run('xcrun', profileArgs, { capture: true });
  }

  if (!usesApiKey && !usesAppleId && !usesKeychainProfile) {
    throw new Error('Missing notarization credentials. Configure an APPLE_KEYCHAIN_PROFILE, Apple ID credential set, or App Store Connect API key set.');
  }

  if (!env.CSC_LINK?.trim()) {
    const { stdout } = await run('security', ['find-identity', '-v', '-p', 'codesigning'], { capture: true });
    const identities = stdout.split('\n').filter((line) => line.includes('Developer ID Application:'));
    if (identities.length === 0) throw new Error('No valid Developer ID Application identity was found in the keychain.');
    if (env.CSC_NAME?.trim() && !identities.some((line) => line.includes(env.CSC_NAME.trim()))) {
      throw new Error(`CSC_NAME does not match an installed Developer ID Application identity: ${env.CSC_NAME}`);
    }
    if (usesAppleId && !identities.some((line) => line.includes(`(${env.APPLE_TEAM_ID.trim()})`))) {
      throw new Error('APPLE_TEAM_ID does not match any installed Developer ID Application identity.');
    }
  }

  return env;
}

try {
  const env = await prepareEnvironment();
  console.log('macOS signing and notarization preflight passed.');
  if (preflightOnly) process.exit(0);

  await run(process.execPath, ['scripts/assert-supported-kernel-host.mjs', 'darwin-arm64'], { env });
  await run('npm', ['run', 'build'], { env });
  await run('npx', ['electron-builder', '--mac', '--arm64'], { env });
  await run(process.execPath, ['scripts/verify-native-package.mjs'], { env });
  await run(process.execPath, ['scripts/verify-macos-release.mjs'], { env });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
