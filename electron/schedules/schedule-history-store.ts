import fs from 'node:fs/promises';
import path from 'node:path';
import type { ScheduleFireRecord } from '../../shared/types/schedules.js';
import type { ScheduleHistoryQuery } from '../../shared/electron-contracts/schedules.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * 触发记录：每个任务一个目录，按 firedAt 的 UTC 月份分文件，只追加 JSONL。
 * 读取按行宽容：坏行跳过，不影响其它记录。
 */
export class ScheduleHistoryStore {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string) {}

  append(record: ScheduleFireRecord): Promise<void> {
    if (!SAFE_ID.test(record.scheduleId)) {
      return Promise.reject(new Error(`Invalid schedule ID for history: ${record.scheduleId}`));
    }
    const filePath = this.fileFor(record.scheduleId, record.firedAt);
    const line = `${JSON.stringify(record)}\n`;
    const write = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
        await fs.appendFile(filePath, line, { encoding: 'utf8', mode: 0o600 });
      });
    this.writeChain = write;
    return write;
  }

  async query(query: ScheduleHistoryQuery): Promise<ScheduleFireRecord[]> {
    const from = new Date(query.from);
    const to = new Date(query.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return [];
    if (query.scheduleId !== undefined && !SAFE_ID.test(query.scheduleId)) return [];
    await this.writeChain.catch(() => undefined);

    const scheduleIds = query.scheduleId ? [query.scheduleId] : await this.listScheduleIds();
    const months = monthsBetween(from, to);
    const fromIso = from.toISOString();
    const toIso = to.toISOString();
    const records: ScheduleFireRecord[] = [];
    for (const scheduleId of scheduleIds) {
      for (const month of months) {
        const lines = await readLines(path.join(this.directory, scheduleId, `${month}.jsonl`));
        for (const line of lines) {
          const record = parseRecord(line);
          if (!record || record.scheduleId !== scheduleId) continue;
          if (record.firedAt < fromIso || record.firedAt > toIso) continue;
          records.push(record);
        }
      }
    }
    return records.sort((left, right) => left.firedAt.localeCompare(right.firedAt));
  }

  async remove(scheduleId: string): Promise<void> {
    if (!SAFE_ID.test(scheduleId)) return;
    await this.writeChain.catch(() => undefined);
    await fs.rm(path.join(this.directory, scheduleId), { recursive: true, force: true });
  }

  flush(): Promise<void> {
    return this.writeChain;
  }

  private fileFor(scheduleId: string, firedAt: string): string {
    return path.join(this.directory, scheduleId, `${monthKey(new Date(firedAt))}.jsonl`);
  }

  private async listScheduleIds(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.directory, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && SAFE_ID.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return [];
      throw error;
    }
  }
}

function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function monthsBetween(from: Date, to: Date): string[] {
  const months: string[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const last = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1);
  while (cursor.getTime() <= last) {
    months.push(monthKey(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

async function readLines(filePath: string): Promise<string[]> {
  try {
    const contents = await fs.readFile(filePath, 'utf8');
    return contents.split('\n');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return [];
    throw error;
  }
}

function parseRecord(line: string): ScheduleFireRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (typeof value.scheduleId !== 'string' || typeof value.firedAt !== 'string') return null;
  if (typeof value.scheduledFor !== 'string' || !isRecord(value.outcome)) return null;
  if (typeof value.outcome.kind !== 'string') return null;
  return value as unknown as ScheduleFireRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
