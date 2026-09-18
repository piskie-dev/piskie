import { describe, expect, it } from 'vitest';
import type { Schedule, ScheduleTaskState } from '../../../shared/types/schedules.js';
import {
  checkCron,
  latestCronRun,
  nextCronRun,
  nextOccurrence,
  nextRunAt,
} from '../next-fire.js';

const cronSchedule = (overrides: Partial<Schedule> = {}): Schedule => ({
  scheduleId: 'sch-a',
  name: 'daily',
  enabled: true,
  trigger: { kind: 'cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai' },
  runIfMissed: false,
  action: { kind: 'new_run', launch: { kind: 'definition', definitionId: 'td-1' } },
  createdBy: { kind: 'user' },
  createdAt: '2026-09-17T00:00:00.000Z',
  ...overrides,
});

const idle: ScheduleTaskState = { consecutiveFailures: 0 };

describe('checkCron', () => {
  it('accepts a standard 5-field expression with a real timezone', () => {
    expect(checkCron('0 9 * * 1-5', 'Asia/Shanghai')).toBeNull();
  });

  it('rejects anything but exactly five fields, including aliases', () => {
    expect(checkCron('0 0 9 * * *', 'UTC')).toBe('field-count');
    expect(checkCron('0 9 * *', 'UTC')).toBe('field-count');
    expect(checkCron('@daily', 'UTC')).toBe('field-count');
  });

  it('reports invalid values, unknown timezones and impossible dates', () => {
    expect(checkCron('60 9 * * *', 'UTC')).toBe('syntax');
    expect(checkCron('0 9 * * *', 'Mars/Olympus')).toBe('timezone');
    expect(checkCron('0 0 30 2 *', 'UTC')).toBe('never');
  });
});

describe('nextCronRun / latestCronRun', () => {
  it('computes the next run strictly after the anchor in the given timezone', () => {
    expect(nextCronRun('0 9 * * *', 'Asia/Shanghai', new Date('2026-09-18T01:00:00Z'))?.toISOString())
      .toBe('2026-09-19T01:00:00.000Z');
    expect(nextCronRun('0 9 * * *', 'Asia/Shanghai', new Date('2026-09-18T00:59:59Z'))?.toISOString())
      .toBe('2026-09-18T01:00:00.000Z');
  });

  it('follows daylight saving transitions of the schedule timezone', () => {
    expect(nextCronRun('0 9 * * *', 'America/New_York', new Date('2026-10-31T13:00:00Z'))?.toISOString())
      .toBe('2026-11-01T14:00:00.000Z');
  });

  it('finds the latest run at or before a moment', () => {
    expect(latestCronRun('*/1 * * * *', 'UTC', new Date('2026-09-18T01:00:00Z'))?.toISOString())
      .toBe('2026-09-18T01:00:00.000Z');
    expect(latestCronRun('*/1 * * * *', 'UTC', new Date('2026-09-18T01:00:40Z'))?.toISOString())
      .toBe('2026-09-18T01:00:00.000Z');
  });
});

describe('nextOccurrence / nextRunAt', () => {
  it('anchors a fresh cron schedule on createdAt', () => {
    expect(nextOccurrence(cronSchedule(), idle)?.toISOString()).toBe('2026-09-17T01:00:00.000Z');
  });

  it('anchors on lastFiredAt once the schedule has fired', () => {
    expect(nextOccurrence(cronSchedule(), {
      consecutiveFailures: 0,
      lastFiredAt: '2026-09-18T01:00:03.000Z',
    })?.toISOString()).toBe('2026-09-19T01:00:00.000Z');
  });

  it('returns the absolute moment for once schedules even when it is in the past', () => {
    const once = cronSchedule({ trigger: { kind: 'once', at: '2026-09-10T00:00:00.000Z' } });
    expect(nextOccurrence(once, idle)?.toISOString()).toBe('2026-09-10T00:00:00.000Z');
  });

  it('hides the next run for disabled, suspended and fired schedules', () => {
    expect(nextRunAt(cronSchedule({ enabled: false }), idle)).toBeNull();
    expect(nextRunAt(cronSchedule(), {
      consecutiveFailures: 3,
      suspended: { code: 'consecutive-failures', count: 3, message: 'boom' },
    })).toBeNull();
    expect(nextRunAt(
      cronSchedule({ trigger: { kind: 'once', at: '2026-09-20T00:00:00.000Z' } }),
      { consecutiveFailures: 0, firedAt: '2026-09-20T00:00:02.000Z' },
    )).toBeNull();
    expect(nextRunAt(cronSchedule(), idle)).not.toBeNull();
  });
});
