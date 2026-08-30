import fs from 'node:fs';
import path from 'node:path';
import winston from 'winston';
import type { LogEvent, LogSink } from './contracts.js';

export interface WinstonJsonlSinkOptions {
  readonly directory: string;
  readonly level: LogEvent['level'];
  readonly maxFileBytes?: number;
  readonly maxFiles?: number;
  readonly console?: boolean;
}

export class WinstonJsonlSink implements LogSink {
  private readonly logger: winston.Logger;
  private readonly level: LogEvent['level'];
  private pendingFileWrites = 0;
  private readonly flushWaiters = new Set<() => void>();
  private closed = false;

  constructor(options: WinstonJsonlSinkOptions) {
    this.level = options.level;
    fs.mkdirSync(options.directory, { recursive: true });
    const fileTransport = new winston.transports.File({
      filename: path.join(options.directory, 'app.jsonl'),
      level: options.level,
      maxsize: options.maxFileBytes ?? 10 * 1024 * 1024,
      maxFiles: options.maxFiles ?? 5,
      tailable: true,
      format: winston.format.printf((info) => JSON.stringify(stripWinstonSymbols(info))),
    });
    fileTransport.on('logged', () => this.completeFileWrite());
    const transports: winston.transport[] = [fileTransport];
    if (options.console !== false) {
      transports.push(
        new winston.transports.Console({
          level: options.level,
          format: winston.format.printf((info) => {
            const event = info as unknown as LogEvent;
            const scope = event.scope ? ` [${event.scope}]` : '';
            return `${event.timestamp} ${event.level.toUpperCase()} ${event.event}${scope} ${event.message}`;
          }),
        })
      );
    }
    for (const transport of transports) {
      transport.on('error', (error) => writeTransportError(error));
    }
    this.logger = winston.createLogger({ level: options.level, transports });
    this.logger.on('error', (error) => writeTransportError(error));
  }

  write(event: LogEvent): void {
    if (this.closed) return;
    const tracked = acceptsLevel(event.level, this.level);
    if (tracked) this.pendingFileWrites += 1;
    try {
      this.logger.log({ ...event });
    } catch (error) {
      if (tracked) this.completeFileWrite();
      writeTransportError(error);
    }
  }

  async flush(): Promise<void> {
    if (this.pendingFileWrites === 0 || this.closed) return;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.flushWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, 1_000);
      this.flushWaiters.add(done);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      timer.unref?.();
      this.logger.once('finish', () => {
        clearTimeout(timer);
        this.pendingFileWrites = 0;
        this.resolveFlushWaiters();
        resolve();
      });
      this.logger.end();
    });
  }

  private completeFileWrite(): void {
    if (this.pendingFileWrites > 0) this.pendingFileWrites -= 1;
    if (this.pendingFileWrites === 0) this.resolveFlushWaiters();
  }

  private resolveFlushWaiters(): void {
    for (const resolve of [...this.flushWaiters]) resolve();
  }
}

const LEVEL_PRIORITY: Record<LogEvent['level'], number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function acceptsLevel(eventLevel: LogEvent['level'], configuredLevel: LogEvent['level']): boolean {
  return LEVEL_PRIORITY[eventLevel] <= LEVEL_PRIORITY[configuredLevel];
}

function stripWinstonSymbols(info: winston.Logform.TransformableInfo): Record<string, unknown> {
  return Object.fromEntries(Object.entries(info));
}

let transportErrorCount = 0;

function writeTransportError(error: unknown): void {
  if (transportErrorCount >= 3) return;
  transportErrorCount += 1;
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[app-log] Winston sink failed: ${detail.slice(0, 512)}\n`);
}
