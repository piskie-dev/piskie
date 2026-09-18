import { describe, expect, it } from 'vitest';

import type { ScheduleFireRecord, ScheduleView } from '@shared/types/schedules';
import { buildSlotGrid } from '../slot-grid-model';

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
/** 2026-09-17 周四 10:30（本地） */
const NOW = new Date(2026, 8, 17, 10, 30);
const WEEK_START = new Date(2026, 8, 14);

function local(day: number, hour: number, minute = 0): Date {
  return new Date(2026, 8, day, hour, minute);
}

function cronView(scheduleId: string, expression: string, overrides: Partial<ScheduleView['schedule']> = {}, state: Partial<ScheduleView['state']> = {}): ScheduleView {
  return {
    schedule: {
      scheduleId,
      name: scheduleId,
      enabled: true,
      trigger: { kind: 'cron', expression, timezone: TZ },
      runIfMissed: false,
      action: { kind: 'new_run', launch: { kind: 'definition', definitionId: 'td-1' } },
      createdBy: { kind: 'user' },
      createdAt: '2026-09-01T00:00:00.000Z',
      ...overrides,
    },
    state: { consecutiveFailures: 0, ...state },
    nextRunAt: null,
  };
}

function record(scheduleId: string, at: Date, outcome: ScheduleFireRecord['outcome'] = { kind: 'started', agentId: `ag-${scheduleId}` }): ScheduleFireRecord {
  return { scheduleId, scheduledFor: at.toISOString(), firedAt: new Date(at.getTime() + 4000).toISOString(), outcome };
}

describe('buildSlotGrid', () => {
  it('过去用记录、将来用 cron 推算，同一时刻合成一行', () => {
    const model = buildSlotGrid({
      weekStart: WEEK_START,
      now: NOW,
      items: [cronView('daily', '0 9 * * *')],
      records: [
        record('daily', local(14, 9)),
        record('daily', local(15, 9), { kind: 'failed', stage: 'start', message: '模型不可用' }),
        record('daily', local(16, 9), { kind: 'skipped', reason: 'missed' }),
        record('daily', local(17, 9)),
      ],
    });

    expect(model.days).toHaveLength(7);
    expect(model.days[3]!.isToday).toBe(true);
    expect(model.days[5]!.isWeekend).toBe(true);
    expect(model.rows).toHaveLength(1);
    const row = model.rows[0]!;
    expect(row.minuteOfDay).toBe(9 * 60);
    expect(row.count).toBe(7);
    expect(row.cells.map((cell) => cell[0]?.kind)).toEqual(['past', 'past', 'past', 'past', 'future', 'future', 'future']);
    expect(row.cells[0]![0]).toMatchObject({ kind: 'past', tone: 'ok' });
    expect(row.cells[1]![0]).toMatchObject({ kind: 'past', tone: 'err' });
    expect(row.cells[2]![0]).toMatchObject({ kind: 'past', tone: 'skip' });
    expect(model.summary).toEqual({ started: 2, failed: 1, skipped: 1, future: 3 });
    // 今天 10:30，唯一一行是 09:00，「现在」插在它后面
    expect(model.nowRowIndex).toBe(1);
  });

  it('日频 ≥ 4 的任务折进全天带，不占时刻行', () => {
    const hourlyRecords = [8, 9, 10].map((hour) => record('hourly', local(17, hour)));
    const model = buildSlotGrid({
      weekStart: WEEK_START,
      now: NOW,
      items: [cronView('hourly', '0 * * * *'), cronView('daily', '30 9 * * *')],
      records: hourlyRecords,
    });
    const todayBand = model.band[3]!;
    expect(todayBand).toHaveLength(1);
    expect(todayBand[0]).toMatchObject({ scheduleId: 'hourly', past: 3, future: 13, total: 16 });
    // 之后几天全是将来的 24 次，也折叠
    expect(model.band[4]![0]).toMatchObject({ scheduleId: 'hourly', future: 24 });
    // 过去几天没有记录也没有将来，不出现
    expect(model.band[0]).toHaveLength(0);
    expect(model.rows.every((row) => row.cells.some((cell) => cell.some((entry) => entry.scheduleId === 'daily')))).toBe(true);
    expect(model.rows.some((row) => row.cells.some((cell) => cell.some((entry) => entry.scheduleId === 'hourly')))).toBe(false);
  });

  it('暂停与挂起的任务仍推算时刻但标为 paused，不计入待触发', () => {
    const model = buildSlotGrid({
      weekStart: WEEK_START,
      now: NOW,
      items: [
        cronView('paused', '0 12 * * *', { enabled: false }),
        cronView('suspended', '0 13 * * *', {}, { suspended: { code: 'template-deleted' } }),
      ],
      records: [],
    });
    expect(model.rows).toHaveLength(2);
    expect(model.rows[0]!.cells[3]![0]).toMatchObject({ kind: 'future', paused: true });
    expect(model.summary.future).toBe(0);
  });

  it('一次性任务只在其时刻出现，已触发的不再推算', () => {
    const at = local(18, 15);
    const model = buildSlotGrid({
      weekStart: WEEK_START,
      now: NOW,
      items: [
        cronView('once', '', { trigger: { kind: 'once', at: at.toISOString() } }),
        cronView('done', '', { trigger: { kind: 'once', at: local(19, 15).toISOString() } }, { firedAt: local(19, 15).toISOString() }),
      ],
      records: [],
    });
    expect(model.rows).toHaveLength(1);
    expect(model.rows[0]!.cells[4]![0]).toMatchObject({ kind: 'future', once: true, scheduleId: 'once' });
  });

  it('本周不含今天时没有「现在」行', () => {
    const model = buildSlotGrid({
      weekStart: new Date(2026, 8, 7),
      now: NOW,
      items: [],
      records: [],
    });
    expect(model.nowRowIndex).toBeNull();
    expect(model.rows).toHaveLength(0);
  });
});
