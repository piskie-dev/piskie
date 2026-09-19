import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { UsageCleanupPreview, UsageRecord, UsageStorageStatus } from '../../../shared/types/model-usage.js';
import { usageRecordSchema } from './record-schema.js';

const DAY = 86_400_000;
const MAX_DAY_RECORDS = 250_000;
const MAX_CACHED_RECORDS = 20_000;
interface DayIndex {
  stamp: string;
  records: Map<string, UsageRecord>;
  corrupt: number;
}
const stamp = (stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }) =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);
export function usageCutoff(days: number | null, now: number): string | undefined {
  return days === null ? undefined : dayOf(Date.parse(`${dayOf(now)}T00:00:00Z`) - (days - 1) * DAY);
}

/** One owner per backend. CLI probes use the running ConfigHost, like desktop probes.
 * The serial queue coordinates append, readers and deletion; no extra storage/lock service.
 */
export class FileUsageStore {
  readonly directory: string;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private readonly active = new Map<string, string>();
  private readonly indexes = new Map<string, DayIndex>();
  revision = 0;
  writeError?: string;
  lastCleanupAt?: number;

  constructor(rootDirectory: string, private readonly now = Date.now) {
    this.directory = path.join(rootDirectory, 'usage', 'records');
  }

  track(record: UsageRecord): void {
    if (record.status === 'running') this.active.set(record.id, dayOf(record.startedAt));
    else this.active.delete(record.id);
  }

  append(record: UsageRecord): void {
    if (this.pending >= 4096) {
      this.writeError = 'Usage write queue is full; some records are incomplete.';
      if (record.status !== 'running') this.active.delete(record.id);
      return;
    }
    const copy = structuredClone(record);
    this.pending++;
    void this.serial(async () => {
      try {
        const parsed = usageRecordSchema.parse(copy);
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        const name = `${dayOf(parsed.startedAt)}.jsonl`;
        const file = await fs.open(path.join(this.directory, name), 'a+', 0o600);
        try {
          // A process crash may leave an incomplete final line. Preserve it as a damaged line.
          const before = await file.stat();
          const { size } = before;
          if (size) {
            const last = Buffer.alloc(1);
            await file.read(last, 0, 1, size - 1);
            if (last[0] !== 10) await file.write('\n');
          }
          await file.write(`${JSON.stringify(parsed)}\n`);
          await file.sync();
          const index = this.indexes.get(name);
          if (index?.stamp === stamp(before)) {
            index.records.set(parsed.id, parsed);
            index.stamp = stamp(await file.stat());
            this.cache(name, index);
          } else this.indexes.delete(name);
          this.revision++;
        } finally { await file.close(); }
      } catch {
        this.writeError = 'Usage records could not be persisted; reported totals may be incomplete.';
      } finally {
        if (copy.status !== 'running') this.active.delete(copy.id);
        this.pending--;
      }
    });
  }

  async flush(): Promise<void> { await this.tail; }

  async status(): Promise<UsageStorageStatus> {
    return this.serial(async () => this.statusUnlocked());
  }

  async read<T>(range: { from?: number; to?: number }, consume: (records: UsageRecord[]) => void, finish: (status: UsageStorageStatus, corrupt: number) => T, signal?: AbortSignal): Promise<T> {
    return this.serial(async () => {
      let corrupt = 0;
      for (const name of await this.fileNames()) {
        signal?.throwIfAborted();
        const day = name.slice(0, 10);
        if (range.from !== undefined && day < dayOf(range.from)) continue;
        if (range.to !== undefined && day > dayOf(range.to - 1)) continue;
        const read = await this.readDay(name, signal);
        corrupt += read.corrupt;
        consume(read.records);
      }
      return finish(await this.statusUnlocked(), corrupt);
    });
  }

  async cleanup(days: number | null, remove: boolean, all = false): Promise<UsageCleanupPreview> {
    return this.serial(async () => {
      const cutoff = usageCutoff(days, this.now());
      const preview: UsageCleanupPreview = { cutoff, files: 0, records: 0, bytes: 0, skippedFiles: 0 };
      const activeDays = new Set(this.active.values());
      for (const name of await this.fileNames()) {
        const day = name.slice(0, 10);
        if (!all && (!cutoff || day >= cutoff)) continue;
        if (activeDays.has(day)) { preview.skippedFiles++; continue; }
        const file = path.join(this.directory, name);
        const records = (await this.readDay(name)).records;
        // An attempt can start while an asynchronous scan is underway.
        if ([...this.active.values()].includes(day)) { preview.skippedFiles++; continue; }
        preview.files++;
        preview.records += records.length;
        preview.bytes += (await fs.stat(file)).size;
        if (remove) { await fs.unlink(file); this.indexes.delete(name); this.revision++; }
      }
      if (remove) this.lastCleanupAt = this.now();
      return preview;
    });
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async fileNames(): Promise<string[]> {
    try {
      return (await fs.readdir(this.directory)).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async statusUnlocked(): Promise<UsageStorageStatus> {
    const names = await this.fileNames();
    let bytes = 0;
    for (const name of names) bytes += (await fs.stat(path.join(this.directory, name))).size;
    return { revision: this.revision, bytes, files: names.length,
      earliestDay: names[0]?.slice(0, 10), latestDay: names.at(-1)?.slice(0, 10),
      lastCleanupAt: this.lastCleanupAt, writeError: this.writeError };
  }

  private async readDay(name: string, signal?: AbortSignal): Promise<{ records: UsageRecord[]; corrupt: number }> {
    const file = path.join(this.directory, name);
    const before = stamp(await fs.stat(file));
    const cached = this.indexes.get(name);
    if (cached?.stamp === before) {
      this.cache(name, cached);
      return this.project(cached);
    }
    this.indexes.delete(name);
    const stream = createReadStream(file, { encoding: 'utf8', signal });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let readError: Error | undefined;
    stream.on('error', (error) => { readError = error; lines.close(); });
    const records = new Map<string, UsageRecord>();
    let corrupt = 0;
    try {
      for await (const line of lines) {
        signal?.throwIfAborted();
        if (!line.trim()) continue;
        try {
          const parsed = usageRecordSchema.parse(JSON.parse(line));
          if (dayOf(parsed.startedAt) !== name.slice(0, 10) || parsed.id !== `${parsed.runId}:${parsed.attempt}`) { corrupt++; continue; }
          records.set(parsed.id, parsed);
        } catch { corrupt++; }
        if (records.size > MAX_DAY_RECORDS) throw new Error('A usage day exceeds the in-memory query limit. Export or remove older report files before querying.');
      }
    } finally { lines.close(); stream.destroy(); }
    if (readError) throw readError;
    if (before !== stamp(await fs.stat(file))) throw new Error('Usage history changed during reading. Refresh the report.');
    const index = { stamp: before, records, corrupt };
    this.cache(name, index);
    return this.project(index);
  }

  private cache(name: string, index: DayIndex): void {
    this.indexes.delete(name);
    if (index.records.size > MAX_CACHED_RECORDS) return;
    this.indexes.set(name, index);
    const size = () => [...this.indexes.values()].reduce((n, day) => n + day.records.size, 0);
    while (this.indexes.size > 8 || size() > MAX_CACHED_RECORDS) this.indexes.delete(this.indexes.keys().next().value!);
  }

  private project(index: DayIndex): { records: UsageRecord[]; corrupt: number } {
    return { corrupt: index.corrupt, records: [...index.records.values()].map((r) => r.status === 'running' && !this.active.has(r.id)
      ? { ...r, status: 'interrupted' as const } : r) };
  }
}
