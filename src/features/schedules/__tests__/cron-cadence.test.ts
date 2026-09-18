import { describe, expect, it } from 'vitest';

import { buildCron, checkCron, cronOccurrences, nextCronRun, normalizeCron, parseCadence, presetOf } from '../cron-cadence';

describe('parseCadence', () => {
  it('识别预设节律', () => {
    expect(parseCadence('0 9 * * *')).toEqual({ kind: 'daily', hour: 9, minute: 0 });
    expect(parseCadence('30 8 * * 1-5')).toEqual({ kind: 'weekdays', hour: 8, minute: 30 });
    expect(parseCadence('0 10 * * 1')).toEqual({ kind: 'weekly', weekday: 1, hour: 10, minute: 0 });
    expect(parseCadence('0 10 * * 7')).toEqual({ kind: 'weekly', weekday: 0, hour: 10, minute: 0 });
    expect(parseCadence('15 * * * *')).toEqual({ kind: 'hourly', minute: 15 });
    expect(parseCadence('0 */6 * * *')).toEqual({ kind: 'everyHours', every: 6, minute: 0 });
  });

  it('其他形状一律视为自定义', () => {
    expect(parseCadence('0 9 1 * *')).toEqual({ kind: 'custom' });
    expect(parseCadence('0 9,18 * * *')).toEqual({ kind: 'custom' });
    expect(parseCadence('*/5 * * * *')).toEqual({ kind: 'custom' });
    expect(parseCadence('0 9 * *')).toEqual({ kind: 'custom' });
    expect(parseCadence('0 25 * * *')).toEqual({ kind: 'custom' });
    expect(presetOf(parseCadence('0 */6 * * *'))).toBe('custom');
  });

  it('预设与表达式互相还原', () => {
    const input = { hour: 9, minute: 5, weekday: 3 };
    expect(parseCadence(buildCron('daily', input))).toEqual({ kind: 'daily', hour: 9, minute: 5 });
    expect(parseCadence(buildCron('weekdays', input))).toEqual({ kind: 'weekdays', hour: 9, minute: 5 });
    expect(parseCadence(buildCron('weekly', input))).toEqual({ kind: 'weekly', weekday: 3, hour: 9, minute: 5 });
    expect(parseCadence(buildCron('hourly', input))).toEqual({ kind: 'hourly', minute: 5 });
  });
});

describe('checkCron', () => {
  it('只接受 5 字段且能匹配到时刻的表达式', () => {
    expect(checkCron('0 9 * * *', 'Asia/Shanghai')).toBeNull();
    expect(checkCron('  0   9 * *  * ', 'Asia/Shanghai')).toBeNull();
    expect(checkCron('0 9 * *', 'Asia/Shanghai')).toBe('field-count');
    expect(checkCron('0 9 * * * *', 'Asia/Shanghai')).toBe('field-count');
    expect(checkCron('0 99 * * *', 'Asia/Shanghai')).toBe('syntax');
    expect(checkCron('0 9 31 2 *', 'Asia/Shanghai')).toBe('never');
    expect(checkCron('0 9 * * *', 'Mars/Olympus')).toBe('timezone');
    expect(normalizeCron(' 0  9 * * * ')).toBe('0 9 * * *');
  });
});

describe('cronOccurrences', () => {
  it('列出闭区间内的全部匹配时刻并在上限处截断', () => {
    const from = new Date('2026-09-14T00:00:00.000Z');
    const to = new Date('2026-09-14T03:00:00.000Z');
    const runs = cronOccurrences('0 * * * *', 'UTC', from, to);
    expect(runs.map((run) => run.toISOString())).toEqual([
      '2026-09-14T00:00:00.000Z',
      '2026-09-14T01:00:00.000Z',
      '2026-09-14T02:00:00.000Z',
      '2026-09-14T03:00:00.000Z',
    ]);
    expect(cronOccurrences('* * * * *', 'UTC', from, to, 5)).toHaveLength(5);
    expect(cronOccurrences('bad', 'UTC', from, to)).toEqual([]);
  });

  it('nextCronRun 严格晚于给定时刻', () => {
    const after = new Date('2026-09-14T09:00:00.000Z');
    expect(nextCronRun('0 9 * * *', 'UTC', after)?.toISOString()).toBe('2026-09-15T09:00:00.000Z');
    expect(nextCronRun('nope', 'UTC', after)).toBeNull();
  });
});
