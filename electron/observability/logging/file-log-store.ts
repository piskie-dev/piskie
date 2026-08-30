import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type {
  LogEntry,
  LogQueryResponse,
  SystemLogFileSummary,
  SystemLogQuery,
} from '@shared/types/index.js';
import type { LogEvent } from './contracts.js';
import { LOG_EVENT_PATTERN } from './event-normalizer.js';

const CURRENT_LOG_FILE_PATTERN = /^app\d*\.jsonl$/;
const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const LOG_ORIGINS = new Set(['main', 'renderer', 'cli', 'pilot']);

export class FileLogStore {
  private parseIssueCount = 0;

  constructor(private readonly appLogDirectory: string) {}

  async getLogFiles(): Promise<SystemLogFileSummary[]> {
    const files = await this.discoverFiles();
    const summaries = await Promise.all(
      files.map(async (filePath) => {
        const stat = await fs.promises.stat(filePath);
        return {
          filename: path.basename(filePath),
          size: stat.size,
          modifiedAt: stat.mtime,
        };
      })
    );
    return summaries.sort((left, right) => right.modifiedAt.getTime() - left.modifiedAt.getTime());
  }

  async queryLogs(filter: SystemLogQuery = {}): Promise<LogQueryResponse> {
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 100;
    const retained: LogEntry[] = [];
    const retainedLimit = offset + limit;
    let total = 0;
    for (const filePath of await this.discoverFiles()) {
      await this.readFile(filePath, (entry) => {
        if (!matchesFilter(entry, filter)) return;
        total += 1;
        retainNewest(retained, entry, retainedLimit);
      });
    }
    return {
      logs: retained.slice(offset, offset + limit),
      total,
      hasMore: offset + limit < total,
    };
  }

  async exportLogs(
    filter: SystemLogQuery | undefined,
    outputPath: string
  ): Promise<number | undefined> {
    try {
      const matches: LogEntry[] = [];
      for (const filePath of await this.discoverFiles()) {
        await this.readFile(filePath, (entry) => {
          if (matchesFilter(entry, filter ?? {})) matches.push(entry);
        });
      }
      matches.sort(compareNewestFirst);
      await fs.promises.writeFile(outputPath, JSON.stringify(matches, null, 2), 'utf8');
      return matches.length;
    } catch (error) {
      this.reportIssue(outputPath, error);
      return undefined;
    }
  }

  private async discoverFiles(): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.appLogDirectory);
    } catch (error) {
      if (isMissingPath(error)) return [];
      this.reportIssue(this.appLogDirectory, error);
      return [];
    }
    return names
      .filter((name) => CURRENT_LOG_FILE_PATTERN.test(name))
      .sort((left, right) => rotationOrder(left) - rotationOrder(right))
      .map((name) => path.join(this.appLogDirectory, name));
  }

  private async readFile(filePath: string, accept: (entry: LogEntry) => void): Promise<void> {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = parseLogEvent(JSON.parse(line));
          if (event) accept(event);
          else this.reportIssue(filePath, new Error('Unsupported log event schema'));
        } catch (error) {
          this.reportIssue(filePath, error);
        }
      }
    } catch (error) {
      this.reportIssue(filePath, error);
    }
  }

  private reportIssue(filePath: string, error: unknown): void {
    if (this.parseIssueCount >= 3) return;
    this.parseIssueCount += 1;
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[file-log-store] Skipped invalid log data in ${path.basename(filePath)}: ${detail.slice(0, 256)}\n`
    );
  }
}

function retainNewest(entries: LogEntry[], candidate: LogEntry, limit: number): void {
  if (limit <= 0) return;
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareNewestFirst(candidate, entries[middle]) < 0) high = middle;
    else low = middle + 1;
  }
  entries.splice(low, 0, candidate);
  if (entries.length > limit) entries.pop();
}

function compareNewestFirst(left: LogEntry, right: LogEntry): number {
  return right.timestamp.localeCompare(left.timestamp) || right.id.localeCompare(left.id);
}

function parseLogEvent(value: unknown): LogEntry | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== 'string' ||
    typeof value.timestamp !== 'string' ||
    Number.isNaN(Date.parse(value.timestamp)) ||
    typeof value.level !== 'string' ||
    !LOG_LEVELS.has(value.level) ||
    typeof value.event !== 'string' ||
    !LOG_EVENT_PATTERN.test(value.event) ||
    typeof value.message !== 'string' ||
    typeof value.origin !== 'string' ||
    !LOG_ORIGINS.has(value.origin)
  )
    return undefined;
  if (value.scope !== undefined && typeof value.scope !== 'string') return undefined;
  if (value.context !== undefined && !isRecord(value.context)) return undefined;
  if (value.error !== undefined && !isRecord(value.error)) return undefined;

  const event = value as unknown as LogEvent;
  return {
    id: event.id,
    timestamp: event.timestamp,
    level: event.level,
    event: event.event,
    message: event.message,
    ...(event.scope && { scope: event.scope }),
    origin: event.origin,
    ...(event.context && { context: event.context }),
    ...(event.error && { error: event.error }),
  };
}

function matchesFilter(entry: LogEntry, filter: SystemLogQuery): boolean {
  const timestamp = Date.parse(entry.timestamp);
  if (filter.startTime && timestamp < filter.startTime.getTime()) return false;
  if (filter.endTime && timestamp > filter.endTime.getTime()) return false;
  if (filter.levels?.length && !filter.levels.includes(entry.level)) return false;
  if (filter.scopes?.length && (!entry.scope || !filter.scopes.includes(entry.scope))) return false;
  if (filter.events?.length && !filter.events.includes(entry.event)) return false;
  if (!filter.searchText) return true;
  const haystack = JSON.stringify({
    event: entry.event,
    message: entry.message,
    scope: entry.scope,
    context: entry.context,
    error: entry.error,
  }).toLowerCase();
  return haystack.includes(filter.searchText.toLowerCase());
}

function rotationOrder(filename: string): number {
  if (filename === 'app.jsonl') return Number.MAX_SAFE_INTEGER;
  const match = /^app(\d+)\.jsonl$/.exec(filename);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER - 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingPath(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
