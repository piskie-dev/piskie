import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LogEvent } from '../../observability/logging/contracts.js';
import { createBootstrapLogSink } from '../bootstrap-log-sink.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.promises.rm(directory, { recursive: true, force: true }))
  );
});

describe('createBootstrapLogSink', () => {
  it('falls back to stderr when the log directory cannot be created', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'piskie-log-bootstrap-'));
    temporaryDirectories.push(root);
    await fs.promises.writeFile(path.join(root, 'logs'), 'not a directory');
    const stderr: string[] = [];

    const sink = createBootstrapLogSink(
      { directory: path.join(root, 'logs', 'app'), level: 'info' },
      (message) => stderr.push(message)
    );
    expect(stderr[0]).toContain('File logging unavailable');

    expect(() => sink.write(event())).not.toThrow();
    expect(JSON.parse(stderr[1] ?? '')).toMatchObject({
      id: 'event-1',
      event: 'desktop.runtime.start.completed',
    });
  });
});

function event(): LogEvent {
  return {
    id: 'event-1',
    timestamp: '2026-08-18T00:00:00.000Z',
    level: 'info',
    event: 'desktop.runtime.start.completed',
    message: 'Desktop runtime started',
    scope: 'desktop.runtime',
    origin: 'main',
  };
}
