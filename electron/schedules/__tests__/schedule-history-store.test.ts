import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ScheduleFireRecord } from '../../../shared/types/schedules.js';
import { ScheduleHistoryStore } from '../schedule-history-store.js';

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'schedule-history-'));
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

const record = (
  scheduleId: string,
  firedAt: string,
  outcome: ScheduleFireRecord['outcome'] = { kind: 'started', agentId: 'agent-1' },
): ScheduleFireRecord => ({ scheduleId, scheduledFor: firedAt, firedAt, outcome });

describe('ScheduleHistoryStore', () => {
  it('appends one JSONL file per schedule and month', async () => {
    const store = new ScheduleHistoryStore(directory);
    await store.append(record('sch-a', '2026-09-30T23:30:00.000Z'));
    await store.append(record('sch-a', '2026-10-01T01:00:00.000Z'));
    await store.append(record('sch-b', '2026-10-02T01:00:00.000Z'));

    expect((await fs.readdir(path.join(directory, 'sch-a'))).sort())
      .toEqual(['2026-09.jsonl', '2026-10.jsonl']);
    const lines = (await fs.readFile(path.join(directory, 'sch-a', '2026-10.jsonl'), 'utf8'))
      .trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ scheduleId: 'sch-a', outcome: { kind: 'started' } });
  });

  it('queries across months, filters by schedule and sorts by firedAt', async () => {
    const store = new ScheduleHistoryStore(directory);
    await store.append(record('sch-a', '2026-10-01T01:00:00.000Z'));
    await store.append(record('sch-a', '2026-09-30T23:30:00.000Z'));
    await store.append(record('sch-b', '2026-10-02T01:00:00.000Z', { kind: 'skipped', reason: 'missed' }));
    await store.append(record('sch-a', '2026-08-15T01:00:00.000Z'));

    const all = await store.query({ from: '2026-09-28T00:00:00.000Z', to: '2026-10-05T00:00:00.000Z' });
    expect(all.map((entry) => `${entry.scheduleId}@${entry.firedAt}`)).toEqual([
      'sch-a@2026-09-30T23:30:00.000Z',
      'sch-a@2026-10-01T01:00:00.000Z',
      'sch-b@2026-10-02T01:00:00.000Z',
    ]);
    const onlyB = await store.query({
      from: '2026-09-01T00:00:00.000Z', to: '2026-10-31T00:00:00.000Z', scheduleId: 'sch-b',
    });
    expect(onlyB).toHaveLength(1);
    expect(onlyB[0]?.outcome).toEqual({ kind: 'skipped', reason: 'missed' });
  });

  it('skips corrupt lines and returns nothing for unsafe ids or empty ranges', async () => {
    const store = new ScheduleHistoryStore(directory);
    await store.append(record('sch-a', '2026-09-18T01:00:00.000Z'));
    await fs.appendFile(path.join(directory, 'sch-a', '2026-09.jsonl'), '{"broken":\n\n');
    await store.append(record('sch-a', '2026-09-19T01:00:00.000Z'));

    const records = await store.query({ from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z' });
    expect(records.map((entry) => entry.firedAt)).toEqual([
      '2026-09-18T01:00:00.000Z',
      '2026-09-19T01:00:00.000Z',
    ]);
    expect(await store.query({
      from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z', scheduleId: '../sch-a',
    })).toEqual([]);
    expect(await store.query({ from: '2026-09-30T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' })).toEqual([]);
    await expect(store.append(record('../escape', '2026-09-18T01:00:00.000Z'))).rejects.toThrow();
  });

  it('removes the whole directory of a schedule', async () => {
    const store = new ScheduleHistoryStore(directory);
    await store.append(record('sch-a', '2026-09-18T01:00:00.000Z'));
    await store.remove('sch-a');
    await expect(fs.access(path.join(directory, 'sch-a'))).rejects.toThrow();
    await store.remove('sch-missing');
  });
});
