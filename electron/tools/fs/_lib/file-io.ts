import { createUuid } from '@shared/utils/identifiers.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { FileGuardPort, GuardVerdict } from '../../types.js';
import { tokenFromStat } from '../../state/read-ledger.js';
import {
  decodeText,
  detectTextEncoding,
  type TextEncoding,
} from './encoding.js';

export type AtomicWriteResult =
  | { ok: true }
  | { ok: false; reason: 'staleAtCommit' | 'createdMeanwhile'; verdict: GuardVerdict };

export type MutationText =
  | { kind: 'missing'; text: ''; encoding: 'utf8'; bytes: 0 }
  | { kind: 'read'; text: string; encoding: TextEncoding; bytes: number };

/** Internal diff/edit reads never update the model's ReadLedger. */
export async function readMutationText(
  canonicalPath: string,
  maxBytes = 20 * 1024 * 1024,
): Promise<MutationText> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(canonicalPath, 'r');
  } catch (error) {
    if (isNotFound(error)) return { kind: 'missing', text: '', encoding: 'utf8', bytes: 0 };
    throw error;
  }

  try {
    const stat = await handle.stat();
    if (stat.size > maxBytes) {
      throw new RangeError(
        `File size exceeds the ${Math.floor(maxBytes / 1024 / 1024)}MB mutation limit: ${canonicalPath}`,
      );
    }
    const buffer = await handle.readFile();
    const encoding = detectTextEncoding(buffer);
    return {
      kind: 'read',
      text: decodeText(buffer, encoding),
      encoding,
      bytes: buffer.length,
    };
  } finally {
    await handle.close();
  }
}

export async function writeAtomic(options: {
  canonicalPath: string;
  content: string | Buffer;
  files: FileGuardPort;
  expected: 'current' | 'absent';
  onWarning?: (message: string, error?: unknown) => void;
}): Promise<AtomicWriteResult> {
  const { canonicalPath, content, files, expected, onWarning } = options;
  const directory = path.dirname(canonicalPath);
  const tempPath = path.join(directory, `.${path.basename(canonicalPath)}.${createUuid()}.tmp`);
  await fs.mkdir(directory, { recursive: true });

  let handle: fs.FileHandle | undefined;
  let tempExists = false;
  try {
    handle = await fs.open(tempPath, 'wx', 0o600);
    tempExists = true;
    await handle.writeFile(content);
    await handle.sync();
    let token = tokenFromStat(await handle.stat({ bigint: true }));
    await handle.close();
    handle = undefined;

    // This is the contract check; keep it adjacent to the filesystem commit.
    const verdict = await files.check(canonicalPath);
    if (verdict !== expected) {
      return { ok: false, reason: 'staleAtCommit', verdict };
    }

    if (expected === 'absent') {
      try {
        await fs.link(tempPath, canonicalPath);
      } catch (error) {
        if (isAlreadyExists(error)) {
          return { ok: false, reason: 'createdMeanwhile', verdict: 'unread' };
        }
        if (!isUnsupportedLink(error)) throw error;

        warnWithoutThrow(
          onWarning,
          `Hard-link creation is unavailable for ${canonicalPath}; falling back to exclusive non-atomic content creation.`,
          error,
        );

        let target: fs.FileHandle | undefined;
        let targetCreated = false;
        try {
          target = await fs.open(canonicalPath, 'wx', 0o600);
          targetCreated = true;
          await target.writeFile(content);
          await target.sync();
          token = tokenFromStat(await target.stat({ bigint: true }));
        } catch (fallbackError) {
          await target?.close().catch(() => undefined);
          target = undefined;
          if (isAlreadyExists(fallbackError)) {
            return { ok: false, reason: 'createdMeanwhile', verdict: 'unread' };
          }
          if (targetCreated) await fs.unlink(canonicalPath).catch(() => undefined);
          throw fallbackError;
        } finally {
          await target?.close().catch(() => undefined);
        }
      }
      try {
        await fs.unlink(tempPath);
        tempExists = false;
      } catch (error) {
        warnWithoutThrow(onWarning, `Failed to remove committed write temp file ${tempPath}.`, error);
      }
    } else {
      await fs.rename(tempPath, canonicalPath);
      tempExists = false;
    }

    files.record(canonicalPath, token, 'write');
    return { ok: true };
  } finally {
    await handle?.close().catch(() => undefined);
    if (tempExists) await fs.unlink(tempPath).catch(() => undefined);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}

function isUnsupportedLink(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return ['EMLINK', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV']
    .includes((error as NodeJS.ErrnoException).code ?? '');
}

function warnWithoutThrow(
  onWarning: ((message: string, error?: unknown) => void) | undefined,
  message: string,
  error: unknown,
): void {
  try {
    onWarning?.(message, error);
  } catch {
    // Observability must not turn a completed or supported degradation into a failed write.
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
