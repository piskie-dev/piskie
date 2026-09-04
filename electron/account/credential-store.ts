import fs from 'node:fs/promises';
import path from 'node:path';

import type { PiskieAccountUser } from '../../shared/electron-contracts/account.js';
import { configFileWriter, type AtomicFileWriter } from '../config/core/atomic-file-writer.js';

export interface AccountCredential {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: number;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: number;
  readonly user: PiskieAccountUser;
}

export interface AccountCredentialRecord {
  readonly credential: AccountCredential;
  readonly storage: 'secure' | 'session';
}

export interface AccountCredentialVault {
  load(): Promise<AccountCredentialRecord | null>;
  save(credential: AccountCredential): Promise<AccountCredentialRecord>;
  clear(): Promise<void>;
}

interface SafeStoragePort {
  decryptString(encrypted: Buffer): string;
  encryptString(plainText: string): Buffer;
  getSelectedStorageBackend(): 'basic_text' | 'gnome_libsecret' | 'kwallet' | 'kwallet5' | 'kwallet6' | 'unknown';
  isEncryptionAvailable(): boolean;
}

export class ElectronAccountCredentialVault implements AccountCredentialVault {
  private readonly filePath: string;
  private volatileRecord?: AccountCredentialRecord;

  constructor(private readonly options: {
    userDataDirectory: string;
    safeStorage: SafeStoragePort;
    platform?: NodeJS.Platform;
    writer?: AtomicFileWriter;
  }) {
    this.filePath = path.join(options.userDataDirectory, 'account', 'credential.v1');
  }

  async load(): Promise<AccountCredentialRecord | null> {
    if (this.volatileRecord) return this.volatileRecord;
    if (!this.secureStorageAvailable()) return null;

    let encoded: string;
    try {
      encoded = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return null;
      throw error;
    }

    try {
      const encrypted = Buffer.from(encoded.trim(), 'base64');
      if (encrypted.length === 0) return null;
      const parsed = JSON.parse(this.options.safeStorage.decryptString(encrypted));
      const credential = parseCredential(parsed);
      if (!credential) {
        await this.removeFile();
        return null;
      }
      this.volatileRecord = Object.freeze({ credential, storage: 'secure' });
      return this.volatileRecord;
    } catch {
      // An unreadable credential is never exposed or treated as an authenticated session.
      await this.removeFile();
      return null;
    }
  }

  async save(credential: AccountCredential): Promise<AccountCredentialRecord> {
    const normalized = parseCredential(credential);
    if (!normalized) throw new Error('Invalid account credential');

    if (!this.secureStorageAvailable()) {
      await fs.unlink(this.filePath).catch((error) => {
        if (!isNodeError(error, 'ENOENT')) throw error;
      });
      this.volatileRecord = Object.freeze({ credential: normalized, storage: 'session' });
      return this.volatileRecord;
    }

    const encrypted = this.options.safeStorage.encryptString(JSON.stringify(normalized));
    await (this.options.writer ?? configFileWriter).replace(
      this.filePath,
      encrypted.toString('base64'),
    );
    this.volatileRecord = Object.freeze({ credential: normalized, storage: 'secure' });
    return this.volatileRecord;
  }

  async clear(): Promise<void> {
    this.volatileRecord = undefined;
    await this.removeFile();
  }

  private async removeFile(): Promise<void> {
    await fs.unlink(this.filePath).catch((error) => {
      if (!isNodeError(error, 'ENOENT')) throw error;
    });
  }

  private secureStorageAvailable(): boolean {
    if (!this.options.safeStorage.isEncryptionAvailable()) return false;
    if ((this.options.platform ?? process.platform) !== 'linux') return true;
    const backend = this.options.safeStorage.getSelectedStorageBackend();
    return backend !== 'basic_text' && backend !== 'unknown';
  }
}

function parseCredential(value: unknown): AccountCredential | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.accessToken !== 'string'
    || candidate.accessToken.length < 16
    || candidate.accessToken.length > 16_384
    || typeof candidate.accessTokenExpiresAt !== 'number'
    || !Number.isFinite(candidate.accessTokenExpiresAt)
    || typeof candidate.refreshToken !== 'string'
    || candidate.refreshToken.length < 16
    || candidate.refreshToken.length > 16_384
    || typeof candidate.refreshTokenExpiresAt !== 'number'
    || !Number.isFinite(candidate.refreshTokenExpiresAt)
  ) return null;
  const user = parseUser(candidate.user);
  if (!user) return null;
  return Object.freeze({
    accessToken: candidate.accessToken,
    accessTokenExpiresAt: candidate.accessTokenExpiresAt,
    refreshToken: candidate.refreshToken,
    refreshTokenExpiresAt: candidate.refreshTokenExpiresAt,
    user,
  });
}

function parseUser(value: unknown): PiskieAccountUser | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== 'string' || candidate.id.length === 0 || candidate.id.length > 512
    || typeof candidate.email !== 'string' || candidate.email.length === 0 || candidate.email.length > 320
    || typeof candidate.name !== 'string' || candidate.name.length > 512
    || (candidate.image !== undefined && typeof candidate.image !== 'string')
  ) return null;
  return Object.freeze({
    id: candidate.id,
    email: candidate.email,
    name: candidate.name,
    ...(typeof candidate.image === 'string' && candidate.image && { image: candidate.image }),
  });
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
