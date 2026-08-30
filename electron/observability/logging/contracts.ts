export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogOrigin = 'main' | 'renderer' | 'cli' | 'pilot';

export type JsonLogValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonLogValue[]
  | { readonly [key: string]: JsonLogValue };

export type LogFields = Readonly<Record<string, unknown>>;

export interface LogRecordInput {
  readonly event: string;
  readonly message: string;
  readonly context?: LogFields;
  readonly error?: unknown;
}

export interface NormalizedLogError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly code?: string;
  readonly cause?: NormalizedLogError;
  readonly fields?: Readonly<Record<string, JsonLogValue>>;
}

export interface LogEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly event: string;
  readonly message: string;
  readonly scope?: string;
  readonly origin: LogOrigin;
  readonly context?: Readonly<Record<string, JsonLogValue>>;
  readonly error?: NormalizedLogError;
}

export interface AppLog {
  debug(record: LogRecordInput): void;
  info(record: LogRecordInput): void;
  warn(record: LogRecordInput): void;
  error(record: LogRecordInput): void;
  child(context: LogFields): AppLog;
}

export interface LogSink {
  write(event: LogEvent): void;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}
