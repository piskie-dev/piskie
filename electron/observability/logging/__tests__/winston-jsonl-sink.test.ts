import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LogEvent } from '../contracts.js';
import { WinstonJsonlSink } from '../winston-jsonl-sink.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.promises.rm(directory, { recursive: true, force: true }))
  );
});

describe('WinstonJsonlSink', () => {
  it('flushes accepted records as canonical one-line JSON', async () => {
    const directory = await makeDirectory();
    const sink = new WinstonJsonlSink({ directory, level: 'info', console: false });

    sink.write(event('debug-event', 'debug'));
    sink.write(event('info-event', 'info'));
    sink.write(event('error-event', 'error'));
    await sink.flush();
    await sink.close();

    const lines = (await fs.promises.readFile(path.join(directory, 'app.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as LogEvent);
    expect(lines.map(({ id }) => id)).toEqual(['info-event', 'error-event']);
    expect(lines.every(({ timestamp }) => timestamp.endsWith('Z'))).toBe(true);
  });
});

async function makeDirectory(): Promise<string> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'piskie-winston-sink-'));
  temporaryDirectories.push(directory);
  return directory;
}

function event(id: string, level: LogEvent['level']): LogEvent {
  return {
    id,
    timestamp: '2026-08-18T00:00:00.000Z',
    level,
    event: 'logging.sink.write.completed',
    message: 'Application log written',
    scope: 'logging.sink',
    origin: 'main',
  };
}
