import type {
  AppLog,
  LogEvent,
  LogFields,
  LogLevel,
  LogOrigin,
  LogRecordInput,
  LogSink,
} from './contracts.js';
import { normalizeLogEvent } from './event-normalizer.js';

const EARLY_BUFFER_CAPACITY = 200;

export interface AppLogOptions {
  readonly sink?: LogSink;
  readonly origin?: LogOrigin;
  readonly defaultContext?: LogFields;
  readonly knownSecrets?: readonly string[];
}

export interface AppLogController {
  readonly log: AppLog;
  install(sink: LogSink, options?: Omit<AppLogOptions, 'sink'>): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

class EarlyBufferSink implements LogSink {
  private readonly events: LogEvent[] = [];
  private droppedCount = 0;

  write(event: LogEvent): void {
    if (this.events.length >= EARLY_BUFFER_CAPACITY) {
      const discardIndex = this.events.findIndex((candidate) => (
        candidate.level === 'debug' || candidate.level === 'info'
      ));
      this.events.splice(discardIndex >= 0 ? discardIndex : 0, 1);
      this.droppedCount += 1;
    }
    this.events.push(event);
  }

  drain(): { events: readonly LogEvent[]; droppedCount: number } {
    return { events: this.events.splice(0), droppedCount: this.droppedCount };
  }
}

class AppLogRuntime {
  private sink: LogSink;
  private readonly earlyBuffer?: EarlyBufferSink;
  private origin: LogOrigin;
  private defaultContext: LogFields;
  private knownSecrets: readonly string[];
  private installed: boolean;

  constructor(options: AppLogOptions = {}) {
    const earlyBuffer = options.sink ? undefined : new EarlyBufferSink();
    this.earlyBuffer = earlyBuffer;
    this.sink = options.sink ?? earlyBuffer!;
    this.origin = options.origin ?? 'main';
    this.defaultContext = options.defaultContext ?? {};
    this.knownSecrets = options.knownSecrets ?? [];
    this.installed = options.sink !== undefined;
  }

  logger(context: LogFields = {}): AppLog {
    const emit = (level: LogLevel, record: LogRecordInput): void => {
      try {
        const event = normalizeLogEvent(level, record, {
          origin: this.origin,
          inheritedContext: { ...this.defaultContext, ...context },
          knownSecrets: this.knownSecrets,
        });
        this.write(event);
      } catch (error) {
        writeFallback('Log record was rejected', error);
      }
    };
    return Object.freeze({
      debug: (record: LogRecordInput) => emit('debug', record),
      info: (record: LogRecordInput) => emit('info', record),
      warn: (record: LogRecordInput) => emit('warn', record),
      error: (record: LogRecordInput) => emit('error', record),
      child: (childContext: LogFields) => this.logger({ ...context, ...childContext }),
    });
  }

  install(sink: LogSink, options: Omit<AppLogOptions, 'sink'> = {}): void {
    if (this.installed) throw new Error('Application log sink is already installed');
    this.installed = true;
    this.sink = sink;
    this.origin = options.origin ?? this.origin;
    this.defaultContext = options.defaultContext ?? this.defaultContext;
    this.knownSecrets = options.knownSecrets ?? this.knownSecrets;
    const buffered = this.earlyBuffer?.drain();
    for (const event of buffered?.events ?? []) this.write(event);
    if ((buffered?.droppedCount ?? 0) > 0) {
      this.logger({ scope: 'logging.buffer' }).warn({
        event: 'logging.buffer.flush.completed',
        message: 'Early log buffer dropped records',
        context: { droppedCount: buffered!.droppedCount },
      });
    }
  }

  async flush(): Promise<void> {
    await this.sink.flush?.();
  }

  async close(): Promise<void> {
    await this.sink.close?.();
  }

  private write(event: LogEvent): void {
    try {
      this.sink.write(event);
    } catch (error) {
      writeFallback('Application log sink failed', error);
    }
  }
}

export class MemoryLogSink implements LogSink {
  readonly events: LogEvent[] = [];

  write(event: LogEvent): void {
    this.events.push(structuredClone(event));
  }
}

export function createAppLog(options: AppLogOptions = {}): AppLog {
  return new AppLogRuntime(options).logger();
}

export function createAppLogController(options: AppLogOptions = {}): AppLogController {
  const runtime = new AppLogRuntime(options);
  return Object.freeze({
    log: runtime.logger(),
    install: (sink: LogSink, installOptions?: Omit<AppLogOptions, 'sink'>) => (
      runtime.install(sink, installOptions)
    ),
    flush: () => runtime.flush(),
    close: () => runtime.close(),
  });
}

const globalController = createAppLogController();
export const appLog = globalController.log;

export function installAppLogSink(
  sink: LogSink,
  options: Omit<AppLogOptions, 'sink'> = {},
): void {
  globalController.install(sink, options);
}

export function closeAppLog(): Promise<void> {
  return globalController.close();
}

function writeFallback(summary: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[app-log] ${summary}: ${detail.slice(0, 512)}\n`);
}
