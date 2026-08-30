import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileLogStore } from '../file-log-store.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.promises.rm(directory, { recursive: true, force: true }))
  );
});

describe('FileLogStore', () => {
  it('queries only current JSONL files and preserves writer IDs', async () => {
    const directory = await makeDirectory();
    const events = [
      event('event-a', '2026-08-18T01:00:00.000Z', 'info', 'agent.runtime.start.completed'),
      event('event-b', '2026-08-18T02:00:00.000Z', 'error', 'agent.runtime.execute.failed'),
    ];
    await writeEvents(path.join(directory, 'app.jsonl'), events, '{broken json}\n');
    await fs.promises.writeFile(path.join(directory, 'combined.log'), JSON.stringify(events[0]));
    await fs.promises.writeFile(path.join(directory, 'diagnostics.log'), JSON.stringify(events[1]));

    const store = new FileLogStore(directory);
    const first = await store.queryLogs({ scopes: ['agent.runtime'], limit: 1 });
    const repeated = await store.queryLogs({ scopes: ['agent.runtime'], limit: 1 });
    const second = await store.queryLogs({ events: ['agent.runtime.execute.failed'] });

    expect(first).toMatchObject({ total: 2, hasMore: true });
    expect(first.logs[0]?.id).toBe('event-b');
    expect(repeated.logs).toEqual(first.logs);
    expect(second.logs.map(({ id }) => id)).toEqual(['event-b']);
    expect((await store.getLogFiles()).map(({ filename }) => filename)).toEqual(['app.jsonl']);
  });

  it('combines filters and keeps pagination stable across rotated files', async () => {
    const directory = await makeDirectory();
    await writeEvents(path.join(directory, 'app2.jsonl'), [
      event('event-a', '2026-08-18T01:00:00.000Z', 'info', 'agent.runtime.start.completed'),
      event('event-c', '2026-08-18T02:00:00.000Z', 'error', 'agent.runtime.execute.failed', {
        marker: 'needle',
      }),
    ]);
    await writeEvents(path.join(directory, 'app.jsonl'), [
      event('event-b', '2026-08-18T02:00:00.000Z', 'error', 'agent.runtime.execute.failed'),
      event(
        'event-d',
        '2026-08-18T03:00:00.000Z',
        'warn',
        'config.domain.refresh.failed',
        {},
        'config.domain'
      ),
    ]);

    const store = new FileLogStore(directory);
    const filtered = await store.queryLogs({
      startTime: new Date('2026-08-18T01:30:00.000Z'),
      endTime: new Date('2026-08-18T02:30:00.000Z'),
      levels: ['error'],
      scopes: ['agent.runtime'],
      events: ['agent.runtime.execute.failed'],
      searchText: 'NEEDLE',
    });
    const page = await store.queryLogs({ limit: 1, offset: 1 });

    expect(filtered).toMatchObject({ total: 1, hasMore: false });
    expect(filtered.logs.map(({ id }) => id)).toEqual(['event-c']);
    expect(page).toMatchObject({ total: 4, hasMore: true });
    expect(page.logs.map(({ id }) => id)).toEqual(['event-c']);
  });

  it('exports every matching current event without the former 10,000 row cap', async () => {
    const directory = await makeDirectory();
    const events = Array.from({ length: 10_005 }, (_, index) =>
      event(
        `event-${index.toString().padStart(5, '0')}`,
        new Date(Date.UTC(2026, 7, 18, 0, 0, 0, index)).toISOString(),
        index % 2 === 0 ? 'info' : 'error',
        index % 2 === 0 ? 'agent.runtime.start.completed' : 'agent.runtime.execute.failed'
      )
    );
    await writeEvents(path.join(directory, 'app.jsonl'), events);
    await fs.promises.writeFile(
      path.join(directory, 'diagnostics.log'),
      JSON.stringify(
        event('legacy', '2026-08-18T04:00:00.000Z', 'error', 'agent.runtime.execute.failed')
      )
    );
    const outputPath = path.join(directory, 'export.json');

    const exportedCount = await new FileLogStore(directory).exportLogs({}, outputPath);
    const exported = JSON.parse(await fs.promises.readFile(outputPath, 'utf8')) as Array<{
      id: string;
    }>;

    expect(exportedCount).toBe(10_005);
    expect(exported).toHaveLength(10_005);
    expect(exported[0]?.id).toBe('event-10004');
    expect(exported.some(({ id }) => id === 'legacy')).toBe(false);
  });
});

async function makeDirectory(): Promise<string> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'piskie-log-store-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeEvents(
  filePath: string,
  events: readonly object[],
  suffix = ''
): Promise<void> {
  await fs.promises.writeFile(
    filePath,
    `${events.map((value) => JSON.stringify(value)).join('\n')}\n${suffix}`
  );
}

function event(
  id: string,
  timestamp: string,
  level: 'info' | 'warn' | 'error',
  name: string,
  context: Record<string, unknown> = {},
  scope = 'agent.runtime'
) {
  return {
    id,
    timestamp,
    level,
    event: name,
    message: level === 'error' ? 'Agent runtime execution failed' : 'Application event recorded',
    scope,
    origin: 'main',
    context,
  };
}
