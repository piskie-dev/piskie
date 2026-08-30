export interface SystemLogQuery {
  startTime?: Date;
  endTime?: Date;
  levels?: ('debug' | 'info' | 'warn' | 'error')[];
  scopes?: string[];
  events?: string[];
  searchText?: string;
  limit?: number;
  offset?: number;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  event: string;
  message: string;
  scope?: string;
  origin: 'main' | 'renderer' | 'cli' | 'pilot';
  context?: Readonly<Record<string, unknown>>;
  error?: SystemLogError;
}

export interface SystemLogError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly code?: string;
  readonly cause?: SystemLogError;
  readonly fields?: Readonly<Record<string, unknown>>;
}

export interface LogQueryResponse {
  logs: LogEntry[];
  total: number;
  hasMore: boolean;
}

export interface SystemLogFileSummary {
  filename: string;
  size: number;
  modifiedAt: Date;
}
