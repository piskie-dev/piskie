import type { LogSink } from '../observability/logging/contracts.js';
import { WinstonJsonlSink } from '../observability/logging/winston-jsonl-sink.js';

export function createBootstrapLogSink(
  input: {
    directory: string;
    level: 'debug' | 'info' | 'warn' | 'error';
  },
  writeStderr: (message: string) => void = (message) => process.stderr.write(message)
): LogSink {
  try {
    return new WinstonJsonlSink({ directory: input.directory, level: input.level });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    writeStderr(`[app-log] File logging unavailable: ${detail.slice(0, 512)}\n`);
    return {
      write(event) {
        writeStderr(`${JSON.stringify(event)}\n`);
      },
    };
  }
}
