import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const modulePath = fileURLToPath(new URL(
  '../node_modules/app-builder-lib/out/codeSign/macCodeSign.js',
  import.meta.url,
));

// Remove this compatibility patch after a published app-builder-lib includes electron-builder#10101.
const vulnerableCall = 'return await importCerts(keychainFile, certPaths, cscPasswords);';
const fixedCall = 'return await importCerts(keychainFile, certPaths, cscPasswords, keychainPassword);';
const vulnerableSignature = 'async function importCerts(keychainFile, paths, keyPasswords) {';
const fixedSignature = 'async function importCerts(keychainFile, paths, keyPasswords, keychainPassword) {';
const vulnerableCommand = '["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychainFile]';
const fixedCommand = '["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", keychainPassword, keychainFile]';

export function patchElectronBuilderMacKeychainSource(source) {
  const fixedMarkers = [fixedCall, fixedSignature, fixedCommand];
  if (fixedMarkers.every((marker) => source.includes(marker))) {
    return { changed: false, source };
  }

  const vulnerableMarkers = [vulnerableCall, vulnerableSignature, vulnerableCommand];
  if (!vulnerableMarkers.every((marker) => source.includes(marker))) {
    throw new Error('Unsupported app-builder-lib macOS keychain implementation; update the release patch.');
  }

  let patched = source;
  for (const [from, to] of [
    [vulnerableCall, fixedCall],
    [vulnerableSignature, fixedSignature],
    [vulnerableCommand, fixedCommand],
  ]) {
    patched = patched.replace(from, to);
  }

  return { changed: true, source: patched };
}

export async function applyElectronBuilderMacKeychainPatch(target = modulePath) {
  const source = await readFile(target, 'utf8');
  const result = patchElectronBuilderMacKeychainSource(source);
  if (result.changed) {
    await writeFile(target, result.source);
    console.log('Applied the electron-builder macOS keychain signing fix.');
  }
  return result.changed;
}
