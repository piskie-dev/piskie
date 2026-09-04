import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ElectronAccountCredentialVault, type AccountCredential } from '../credential-store.js';

const roots: string[] = [];
const TOKEN = 'private-bearer-token-value';
const REFRESH_TOKEN = 'private-refresh-token-value';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piskie-account-vault-'));
  roots.push(root);
  return root;
}

function credential(): AccountCredential {
  return {
    accessToken: TOKEN,
    accessTokenExpiresAt: Date.now() + 60_000,
    refreshToken: REFRESH_TOKEN,
    refreshTokenExpiresAt: Date.now() + 30 * 24 * 60 * 60_000,
    user: { id: 'user-1', email: 'person@example.com', name: 'Person' },
  };
}

function safeStorage(backend: 'gnome_libsecret' | 'basic_text') {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString: (plainText: string) => Buffer.from(plainText, 'utf8').map((byte) => byte ^ 0x5a),
    decryptString: (encrypted: Buffer) => Buffer.from(encrypted).map((byte) => byte ^ 0x5a).toString('utf8'),
  };
}

describe('ElectronAccountCredentialVault', () => {
  it('persists only safeStorage ciphertext in a private file', async () => {
    const root = await temporaryRoot();
    const encryption = safeStorage('gnome_libsecret');
    const savedCredential = credential();
    const first = new ElectronAccountCredentialVault({
      userDataDirectory: root,
      safeStorage: encryption,
      platform: 'linux',
    });

    await expect(first.save(savedCredential)).resolves.toMatchObject({ storage: 'secure' });
    const file = path.join(root, 'account', 'credential.v1');
    const contents = await fs.readFile(file, 'utf8');
    const mode = (await fs.stat(file)).mode & 0o777;
    expect(contents).not.toContain(TOKEN);
    expect(contents).not.toContain(REFRESH_TOKEN);
    expect(mode).toBe(0o600);

    const second = new ElectronAccountCredentialVault({
      userDataDirectory: root,
      safeStorage: encryption,
      platform: 'linux',
    });
    await expect(second.load()).resolves.toEqual({
      credential: savedCredential,
      storage: 'secure',
    });
  });

  it('removes a legacy credential that has no rotating refresh token', async () => {
    const root = await temporaryRoot();
    const encryption = safeStorage('gnome_libsecret');
    const file = path.join(root, 'account', 'credential.v1');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const legacy = encryption.encryptString(JSON.stringify({
      accessToken: TOKEN,
      expiresAt: Date.now() + 60_000,
      user: { id: 'user-1', email: 'person@example.com', name: 'Person' },
    }));
    await fs.writeFile(file, legacy.toString('base64'));
    const vault = new ElectronAccountCredentialVault({
      userDataDirectory: root,
      safeStorage: encryption,
      platform: 'linux',
    });

    await expect(vault.load()).resolves.toBeNull();
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses memory only when Linux falls back to basic_text encryption', async () => {
    const root = await temporaryRoot();
    const encryption = safeStorage('basic_text');
    const vault = new ElectronAccountCredentialVault({
      userDataDirectory: root,
      safeStorage: encryption,
      platform: 'linux',
    });

    await expect(vault.save(credential())).resolves.toMatchObject({ storage: 'session' });
    await expect(vault.load()).resolves.toMatchObject({ storage: 'session' });
    await expect(fs.stat(path.join(root, 'account', 'credential.v1'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const restarted = new ElectronAccountCredentialVault({
      userDataDirectory: root,
      safeStorage: encryption,
      platform: 'linux',
    });
    await expect(restarted.load()).resolves.toBeNull();
  });
});
