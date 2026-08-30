/**
 * 上游：openclaw src/plugin-sdk/file-lock.ts + src/infra/tmp-openclaw-dir.ts +
 * src/shared/pid-alive.ts（MIT）
 * 消费方：weixin vendor（auth/pairing.ts 配对存储锁、channel/process-message/logger 的临时目录）
 *
 * resolvePreferredOpenClawTmpDir 为 PISKIE 简化版：保留"POSIX /tmp/openclaw 可信则用、
 * 否则 tmpdir()/openclaw-{uid}"的路径语义（与上游产出路径一致，本机实测 fallback 路径
 * 为 $TMPDIR/openclaw-501）；省略多用户安全告警细节。仅存放可丢弃数据（出站媒体临时
 * 文件、日志），路径漂移不影响登录态（凭证在 ~/.openclaw，见渠道 UPSTREAM.md）。
 */

import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// ── tmp dir ────────────────────────────────────────────────────────────────

const POSIX_OPENCLAW_TMP_DIR = '/tmp/openclaw';

function getUid(): number | undefined {
  try {
    return typeof process.getuid === 'function' ? process.getuid() : undefined;
  } catch {
    return undefined;
  }
}

export function resolvePreferredOpenClawTmpDir(): string {
  const uid = getUid();
  const fallback = path.join(os.tmpdir(), uid === undefined ? 'openclaw' : `openclaw-${uid}`);

  if (process.platform === 'win32') {
    ensureDir(fallback);
    return fallback;
  }

  try {
    const st = fsSync.lstatSync(POSIX_OPENCLAW_TMP_DIR);
    const secure =
      st.isDirectory() &&
      !st.isSymbolicLink() &&
      (uid === undefined || st.uid === uid) &&
      (st.mode & 0o022) === 0;
    if (secure) {
      fsSync.accessSync(POSIX_OPENCLAW_TMP_DIR, fsSync.constants.W_OK | fsSync.constants.X_OK);
      return POSIX_OPENCLAW_TMP_DIR;
    }
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') {
      try {
        fsSync.mkdirSync(POSIX_OPENCLAW_TMP_DIR, { recursive: true, mode: 0o700 });
        return POSIX_OPENCLAW_TMP_DIR;
      } catch {
        // 落到 fallback
      }
    }
  }

  ensureDir(fallback);
  return fallback;
}

function ensureDir(dir: string): void {
  try {
    fsSync.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // 已存在或不可创建——消费方自行处理后续 IO 失败
  }
}

// ── file lock（上游逐字移植；process-scoped map 简化为模块级 Map）────────────

export type FileLockOptions = {
  retries: {
    retries: number;
    factor: number;
    minTimeout: number;
    maxTimeout: number;
    randomize?: boolean;
  };
  stale: number;
};

type LockFilePayload = { pid: number; createdAt: string };
type HeldLock = { count: number; handle: fs.FileHandle; lockPath: string };

const HELD_LOCKS = new Map<string, HeldLock>();
let cleanupRegistered = false;

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === 'linux') {
    try {
      const status = fsSync.readFileSync(`/proc/${pid}/status`, 'utf8');
      if (status.match(/^State:\s+(\S)/m)?.[1] === 'Z') return false;
    } catch {
      // 读不到按存活处理
    }
  }
  return true;
}

function releaseAllLocksSync(): void {
  for (const [key, held] of HELD_LOCKS) {
    void held.handle.close().catch(() => undefined);
    try {
      fsSync.rmSync(held.lockPath, { force: true });
    } catch {
      // 退出清理尽力而为
    }
    HELD_LOCKS.delete(key);
  }
}

function ensureExitCleanupRegistered(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.on('exit', releaseAllLocksSync);
}

function computeDelayMs(retries: FileLockOptions['retries'], attempt: number): number {
  const base = Math.min(
    retries.maxTimeout,
    Math.max(retries.minTimeout, retries.minTimeout * retries.factor ** attempt),
  );
  const jitter = retries.randomize ? 1 + Math.random() : 1;
  return Math.min(retries.maxTimeout, Math.round(base * jitter));
}

async function readLockPayload(lockPath: string): Promise<LockFilePayload | null> {
  try {
    const raw = await fs.readFile(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LockFilePayload>;
    if (typeof parsed.pid !== 'number' || typeof parsed.createdAt !== 'string') return null;
    return { pid: parsed.pid, createdAt: parsed.createdAt };
  } catch {
    return null;
  }
}

async function resolveNormalizedFilePath(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  const dir = path.dirname(resolved);
  await fs.mkdir(dir, { recursive: true });
  try {
    const realDir = await fs.realpath(dir);
    return path.join(realDir, path.basename(resolved));
  } catch {
    return resolved;
  }
}

async function isStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  const payload = await readLockPayload(lockPath);
  if (payload?.pid && !isPidAlive(payload.pid)) return true;
  if (payload?.createdAt) {
    const createdAt = Date.parse(payload.createdAt);
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > staleMs) return true;
  }
  try {
    const stat = await fs.stat(lockPath);
    return Date.now() - stat.mtimeMs > staleMs;
  } catch {
    return true;
  }
}

export type FileLockHandle = { lockPath: string; release: () => Promise<void> };

async function releaseHeldLock(normalizedFile: string): Promise<void> {
  const current = HELD_LOCKS.get(normalizedFile);
  if (!current) return;
  current.count -= 1;
  if (current.count > 0) return;
  HELD_LOCKS.delete(normalizedFile);
  await current.handle.close().catch(() => undefined);
  await fs.rm(current.lockPath, { force: true }).catch(() => undefined);
}

/** Acquire a re-entrant process-local file lock backed by a `.lock` sidecar file. */
export async function acquireFileLock(
  filePath: string,
  options: FileLockOptions,
): Promise<FileLockHandle> {
  ensureExitCleanupRegistered();
  const normalizedFile = await resolveNormalizedFilePath(filePath);
  const lockPath = `${normalizedFile}.lock`;
  const held = HELD_LOCKS.get(normalizedFile);
  if (held) {
    held.count += 1;
    return { lockPath, release: () => releaseHeldLock(normalizedFile) };
  }

  const attempts = Math.max(1, options.retries.retries + 1);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2),
        'utf8',
      );
      HELD_LOCKS.set(normalizedFile, { count: 1, handle, lockPath });
      return { lockPath, release: () => releaseHeldLock(normalizedFile) };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'EEXIST') throw err;
      if (await isStaleLock(lockPath, options.stale)) {
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
        continue;
      }
      if (attempt >= attempts - 1) break;
      await new Promise((resolve) => setTimeout(resolve, computeDelayMs(options.retries, attempt)));
    }
  }

  throw new Error(`file lock timeout for ${normalizedFile}`);
}

/** Run an async callback while holding a file lock, always releasing the lock afterward. */
export async function withFileLock<T>(
  filePath: string,
  options: FileLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = await acquireFileLock(filePath, options);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
