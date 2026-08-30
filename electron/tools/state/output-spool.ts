import { createUuid } from '@shared/utils/identifiers.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { OutputSpoolPort } from '../types.js';

const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024;
const DEFAULT_PREVIEW_BYTES = 2 * 1024;
const DEFAULT_TAIL_BYTES = 16 * 1024;
const DEFAULT_CALL_DISK_LIMIT_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_GLOBAL_DISK_LIMIT_BYTES = 16 * 1024 * 1024 * 1024;
const DEFAULT_MIN_FREE_DISK_BYTES = 512 * 1024 * 1024;

export type OutputSpoolOptions = Readonly<{
  tempDir: string;
  tempRootDir?: string;
  memoryLimitBytes?: number;
  previewBytes?: number;
  tailBytes?: number;
  callDiskLimitBytes?: number;
  globalDiskLimitBytes?: number;
  minFreeDiskBytes?: number;
  onWarning?: (message: string, error?: unknown) => void;
}>;

type DiskBudget = Readonly<{
  bytes: number;
  reason: string;
}>;

/** Per-call bounded buffer. Disk limits are sampled without shared counters or locks. */
export class OutputSpool implements OutputSpoolPort {
  private readonly memoryLimitBytes: number;
  private readonly previewBytes: number;
  private readonly tailBytes: number;
  private readonly callDiskLimitBytes: number;
  private readonly globalDiskLimitBytes: number;
  private readonly minFreeDiskBytes: number;
  private readonly tempDir: string;
  private readonly tempRootDir: string;
  private readonly onWarning?: (message: string, error?: unknown) => void;
  private buffered: Buffer[] = [];
  private bufferedBytes = 0;
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private totalBytes = 0;
  private diskBytes = 0;
  private diskBudgetBytes = 0;
  private diskLimitReason = '';
  private filePath: string | null = null;
  private fd: number | null = null;
  private degradationReason: string | null = null;
  private sealed = false;
  private reported = false;
  private abandoned = false;

  constructor(options: OutputSpoolOptions) {
    this.tempDir = options.tempDir;
    this.tempRootDir = options.tempRootDir ?? options.tempDir;
    this.memoryLimitBytes = options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES;
    this.previewBytes = options.previewBytes ?? DEFAULT_PREVIEW_BYTES;
    this.tailBytes = options.tailBytes ?? DEFAULT_TAIL_BYTES;
    this.callDiskLimitBytes = options.callDiskLimitBytes ?? DEFAULT_CALL_DISK_LIMIT_BYTES;
    this.globalDiskLimitBytes = options.globalDiskLimitBytes ?? DEFAULT_GLOBAL_DISK_LIMIT_BYTES;
    this.minFreeDiskBytes = options.minFreeDiskBytes ?? DEFAULT_MIN_FREE_DISK_BYTES;
    this.onWarning = options.onWarning;

    for (const [name, value] of Object.entries({
      memoryLimitBytes: this.memoryLimitBytes,
      previewBytes: this.previewBytes,
      tailBytes: this.tailBytes,
      callDiskLimitBytes: this.callDiskLimitBytes,
      globalDiskLimitBytes: this.globalDiskLimitBytes,
      minFreeDiskBytes: this.minFreeDiskBytes,
    })) {
      if (!Number.isSafeInteger(value) || value < (name === 'minFreeDiskBytes' ? 0 : 1)) {
        throw new RangeError(`OutputSpool ${name} must be a safe positive byte count`);
      }
    }
  }

  write(chunk: Buffer, _stream: 'out' | 'err'): void {
    if (this.sealed) throw new Error('OutputSpool is already sealed');
    if (chunk.length === 0) return;

    this.totalBytes += chunk.length;
    this.capturePreview(chunk);

    if (this.degradationReason !== null) return;
    if (this.filePath === null && this.bufferedBytes + chunk.length <= this.memoryLimitBytes) {
      this.buffered.push(Buffer.from(chunk));
      this.bufferedBytes += chunk.length;
      return;
    }

    if (this.filePath === null && !this.openSpillFile()) return;
    if (this.buffered.length > 0) this.flushBuffered();
    if (this.degradationReason === null) this.writeToDisk(chunk);
  }

  textForModel(): string {
    if (this.filePath === null && this.degradationReason === null) {
      return Buffer.concat(this.buffered).toString('utf8');
    }
    const head = this.head.toString('utf8');
    const tail = this.tail.toString('utf8');
    const preview = tail && tail !== head ? `${head}\n...\n${tail}` : head;
    if (this.degradationReason === null) return preview;

    const retainedTail = Math.min(this.tail.length, this.tailBytes);
    const note = `[输出不完整：共收到 ${this.totalBytes} 字节，磁盘仅保留 ${this.diskBytes} 字节；${this.degradationReason}，已停止落盘。仅保留头部预览和末尾 ${retainedTail} 字节，中间内容已丢失。]`;
    return preview ? `${preview}\n${note}` : note;
  }

  spilled(): ReturnType<OutputSpoolPort['spilled']> {
    if (this.abandoned) return null;
    this.seal();
    if (this.filePath === null || this.diskBytes === 0) return null;
    this.reported = true;
    return {
      path: this.filePath,
      bytes: this.diskBytes,
      preview: this.head.toString('utf8'),
      ...(this.degradationReason === null ? {} : {
        incomplete: {
          observedBytes: this.totalBytes,
          reason: this.degradationReason,
        },
      }),
    };
  }

  dispose(): void {
    this.seal();
    if (this.reported || this.filePath === null) return;
    try {
      fs.unlinkSync(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.onWarning?.('OutputSpool failed to remove abandoned output', error);
      }
    }
    this.filePath = null;
    this.diskBytes = 0;
    this.abandoned = true;
  }

  private openSpillFile(): boolean {
    try {
      fs.mkdirSync(this.tempDir, { recursive: true });
      fs.mkdirSync(this.tempRootDir, { recursive: true });
      const budget = this.sampleDiskBudget();
      this.diskBudgetBytes = budget.bytes;
      this.diskLimitReason = budget.reason;
      if (budget.bytes === 0) {
        this.stopDisk(budget.reason);
        return false;
      }

      const candidate = path.join(this.tempDir, `output-${createUuid()}.log`);
      const fd = fs.openSync(candidate, 'wx', 0o600);
      this.filePath = candidate;
      this.fd = fd;
      return true;
    } catch (error) {
      this.stopDisk('磁盘额度检查或输出文件创建失败', error);
      return false;
    }
  }

  private sampleDiskBudget(): DiskBudget {
    const usedByTempRoot = directorySize(this.tempRootDir);
    const globalRemaining = Math.max(0, this.globalDiskLimitBytes - usedByTempRoot);
    const stats = fs.statfsSync(this.tempRootDir, { bigint: true });
    const freeBytes = stats.bavail * stats.bsize;
    const freeRemaining = clampBigIntToNumber(
      freeBytes - BigInt(this.minFreeDiskBytes),
    );
    const bytes = Math.min(
      this.callDiskLimitBytes,
      globalRemaining,
      Math.max(0, freeRemaining),
    );

    if (bytes === this.callDiskLimitBytes) {
      return { bytes, reason: '达到单次调用输出磁盘配额' };
    }
    if (bytes === globalRemaining) {
      return { bytes, reason: '达到全局输出磁盘配额' };
    }
    return { bytes, reason: '达到磁盘剩余空间保护线' };
  }

  private flushBuffered(): void {
    const chunks = this.buffered;
    this.buffered = [];
    this.bufferedBytes = 0;
    for (const chunk of chunks) {
      if (this.degradationReason !== null) break;
      this.writeToDisk(chunk);
    }
  }

  private writeToDisk(chunk: Buffer): void {
    if (this.fd === null || this.degradationReason !== null) return;
    const remaining = this.diskBudgetBytes - this.diskBytes;
    if (remaining <= 0) {
      this.stopDisk(this.diskLimitReason);
      return;
    }

    const allowed = Math.min(chunk.length, remaining);
    let offset = 0;
    try {
      while (offset < allowed) {
        const written = fs.writeSync(this.fd, chunk, offset, allowed - offset);
        if (written <= 0) throw new Error('writeSync made no progress');
        offset += written;
        this.diskBytes += written;
      }
    } catch (error) {
      this.stopDisk('磁盘写入失败', error);
      return;
    }

    if (allowed < chunk.length) this.stopDisk(this.diskLimitReason);
  }

  private stopDisk(reason: string, error?: unknown): void {
    if (this.degradationReason === null) {
      this.degradationReason = reason;
      this.onWarning?.(`OutputSpool degraded: ${reason}`, error);
    }
    this.buffered = [];
    this.bufferedBytes = 0;
    this.closeFile(true);
    if (this.diskBytes === 0 && this.filePath !== null) {
      try { fs.unlinkSync(this.filePath); } catch { /* best-effort empty-file cleanup */ }
      this.filePath = null;
    }
  }

  private capturePreview(chunk: Buffer): void {
    if (this.head.length < this.previewBytes) {
      const needed = this.previewBytes - this.head.length;
      this.head = Buffer.concat([this.head, chunk.subarray(0, needed)]);
    }
    this.tail = Buffer.concat([this.tail, chunk]);
    if (this.tail.length > this.tailBytes) {
      this.tail = this.tail.subarray(this.tail.length - this.tailBytes);
    }
  }

  private seal(): void {
    if (this.sealed) return;
    this.sealed = true;
    this.closeFile(true);
  }

  private closeFile(sync: boolean): void {
    const fd = this.fd;
    if (fd === null) return;
    this.fd = null;
    if (sync) {
      try {
        fs.fsyncSync(fd);
      } catch (error) {
        if (this.degradationReason === null) {
          this.degradationReason = '磁盘同步失败';
          this.onWarning?.('OutputSpool degraded: 磁盘同步失败', error);
        }
      }
    }
    try {
      fs.closeSync(fd);
    } catch (error) {
      this.onWarning?.('OutputSpool failed to close its output file', error);
    }
  }
}

function directorySize(root: string): number {
  let bytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(target);
      } else if (entry.isFile()) {
        bytes += fs.statSync(target).size;
      }
      if (bytes >= Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
    }
  }
  return bytes;
}

function clampBigIntToNumber(value: bigint): number {
  if (value <= 0n) return 0;
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  return value >= max ? Number.MAX_SAFE_INTEGER : Number(value);
}
