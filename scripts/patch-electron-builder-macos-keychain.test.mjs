import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { patchElectronBuilderMacKeychainSource } from './patch-electron-builder-macos-keychain.mjs';

const vulnerableSource = `
return await importCerts(keychainFile, certPaths, cscPasswords);
async function importCerts(keychainFile, paths, keyPasswords) {
  const password = keyPasswords[i] ?? "";
  await exec("/usr/bin/security", ["import", paths[i], "-P", password]);
  await exec("/usr/bin/security", ["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychainFile]);
}
`;

test('uses the temporary keychain password for the partition list', () => {
  const result = patchElectronBuilderMacKeychainSource(vulnerableSource);

  assert.equal(result.changed, true);
  assert.match(result.source, /cscPasswords, keychainPassword/);
  assert.match(result.source, /keyPasswords, keychainPassword/);
  assert.match(result.source, /"import"[^\n]+"-P", password/);
  assert.match(result.source, /"set-key-partition-list"[^\n]+"-k", keychainPassword/);
});

test('leaves an upstream-fixed implementation unchanged', () => {
  const fixedSource = patchElectronBuilderMacKeychainSource(vulnerableSource).source;
  const result = patchElectronBuilderMacKeychainSource(fixedSource);

  assert.equal(result.changed, false);
  assert.equal(result.source, fixedSource);
});

test('supports the installed app-builder-lib implementation', async () => {
  const installedSource = await readFile(new URL(
    '../node_modules/app-builder-lib/out/codeSign/macCodeSign.js',
    import.meta.url,
  ), 'utf8');
  const result = patchElectronBuilderMacKeychainSource(installedSource);

  assert.match(result.source, /cscPasswords, keychainPassword/);
  assert.match(result.source, /"set-key-partition-list"[^\n]+"-k", keychainPassword/);
});

test('rejects an unknown implementation', () => {
  assert.throws(
    () => patchElectronBuilderMacKeychainSource('export const changedUpstream = true;'),
    /Unsupported app-builder-lib/,
  );
});
