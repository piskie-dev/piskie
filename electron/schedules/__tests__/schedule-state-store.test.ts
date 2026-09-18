import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScheduleStateStore } from '../schedule-state-store.js';

let directory: string;
let filePath: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'schedule-state-'));
  filePath = path.join(directory, 'schedules', 'state.json');
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe('ScheduleStateStore', () => {
  it('starts empty when the file is missing and persists updates atomically', async () => {
    const store = new ScheduleStateStore(filePath);
    expect(await store.load()).toEqual({});
    expect(store.taskState('sch-a')).toEqual({ consecutiveFailures: 0 });

    await store.updateTask('sch-a', { lastFiredAt: '2026-09-18T01:00:00.000Z', lastAgentId: 'agent-1' });
    await store.apply((draft) => {
      draft.claim = {
        scheduleId: 'sch-a',
        scheduledFor: '2026-09-19T01:00:00.000Z',
        claimedAt: '2026-09-19T01:00:02.000Z',
      };
    });

    const reloaded = new ScheduleStateStore(filePath);
    await reloaded.load();
    expect(reloaded.taskState('sch-a')).toEqual({
      consecutiveFailures: 0,
      lastFiredAt: '2026-09-18T01:00:00.000Z',
      lastAgentId: 'agent-1',
    });
    expect(reloaded.claim()).toEqual({
      scheduleId: 'sch-a',
      scheduledFor: '2026-09-19T01:00:00.000Z',
      claimedAt: '2026-09-19T01:00:02.000Z',
    });
    const leftovers = (await fs.readdir(path.dirname(filePath))).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('removes keys patched with undefined', async () => {
    const store = new ScheduleStateStore(filePath);
    await store.load();
    await store.updateTask('sch-a', {
      consecutiveFailures: 3,
      suspended: { code: 'consecutive-failures', count: 3, message: 'boom' },
    });
    await store.updateTask('sch-a', { suspended: undefined, consecutiveFailures: 0 });
    const reloaded = new ScheduleStateStore(filePath);
    await reloaded.load();
    expect(reloaded.taskState('sch-a')).toEqual({ consecutiveFailures: 0 });
  });

  it('serializes concurrent writes so the file ends in the final state', async () => {
    const store = new ScheduleStateStore(filePath);
    await store.load();
    const writes = Array.from({ length: 20 }, (_, index) => (
      store.updateTask(`sch-${index}`, { consecutiveFailures: index })
    ));
    await Promise.all(writes);
    const reloaded = new ScheduleStateStore(filePath);
    await reloaded.load();
    expect(Object.keys(reloaded.tasks())).toHaveLength(20);
    expect(reloaded.taskState('sch-19').consecutiveFailures).toBe(19);
  });

  it('ignores unknown fields and drops broken entries while keeping the rest', async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({
      version: 7,
      retiredFlag: true,
      tasks: {
        'sch-a': { consecutiveFailures: 1, lastFiredAt: '2026-09-18T01:00:00.000Z', legacy: 'x' },
        'sch-b': 'not-an-object',
        'sch-c': { consecutiveFailures: 'many', suspended: { code: 'unknown-code' } },
      },
      claim: { scheduleId: 'sch-a' },
    }));
    const store = new ScheduleStateStore(filePath);
    expect(await store.load()).toEqual({});
    expect(store.tasks()).toEqual({
      'sch-a': { consecutiveFailures: 1, lastFiredAt: '2026-09-18T01:00:00.000Z' },
      'sch-c': { consecutiveFailures: 0 },
    });
    expect(store.claim()).toBeUndefined();
  });

  it('quarantines a corrupt file and starts empty', async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '{"tasks": {');
    const store = new ScheduleStateStore(filePath);
    const result = await store.load();
    expect(result.recoveredFrom).toMatch(/state\.json\.corrupt-\d+$/);
    expect(store.tasks()).toEqual({});
    const names = await fs.readdir(path.dirname(filePath));
    expect(names.some((name) => name.startsWith('state.json.corrupt-'))).toBe(true);
    expect(names).not.toContain('state.json');
  });

  it('removes a task together with its claim', async () => {
    const store = new ScheduleStateStore(filePath);
    await store.load();
    await store.updateTask('sch-a', { lastAgentId: 'agent-1' });
    await store.apply((draft) => {
      draft.claim = { scheduleId: 'sch-a', scheduledFor: 'x', claimedAt: 'y' } as never;
    });
    await store.removeTask('sch-a');
    expect(store.tasks()).toEqual({});
    expect(store.claim()).toBeUndefined();
  });
});
