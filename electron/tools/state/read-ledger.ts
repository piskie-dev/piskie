import * as fs from 'node:fs/promises';
import type {
  FileGuardPort,
  GuardVerdict,
  VersionToken,
} from '../types.js';

export function tokenFromStat(stat: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}): VersionToken {
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
  });
}

export function sameVersion(left: VersionToken, right: VersionToken): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs;
}

/** The only per-agent file-version state. */
export class ReadLedger {
  private readonly versions = new Map<string, VersionToken>();

  record(canonicalPath: string, token: VersionToken, _kind: 'read' | 'write'): void {
    this.versions.set(canonicalPath, token);
  }

  lookup(canonicalPath: string): VersionToken | undefined {
    return this.versions.get(canonicalPath);
  }

  forget(canonicalPath: string): void {
    this.versions.delete(canonicalPath);
  }
}

export class LedgerFileGuard implements FileGuardPort {
  constructor(private readonly ledger: ReadLedger) {}

  async check(canonicalPath: string): Promise<GuardVerdict> {
    const expected = this.ledger.lookup(canonicalPath);
    try {
      const current = tokenFromStat(await fs.stat(canonicalPath, { bigint: true }));
      if (!expected) return 'unread';
      return sameVersion(expected, current) ? 'current' : 'stale';
    } catch (error) {
      if (!isNotFound(error)) throw error;
      return expected ? 'stale' : 'absent';
    }
  }

  record(canonicalPath: string, token: VersionToken, kind: 'read' | 'write'): void {
    this.ledger.record(canonicalPath, token, kind);
  }

  forget(canonicalPath: string): void {
    this.ledger.forget(canonicalPath);
  }
}

export function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
