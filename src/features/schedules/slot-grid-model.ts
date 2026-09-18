/**
 * 时刻 × 天网格（原型 B7）的纯模型。
 *
 * 行只列本周真正出现的触发时刻；同一任务当天 ≥ FOLD_THRESHOLD 次的折进顶部「全天」带按天一格；
 * 「现在」是一行，插在对应时刻之间。过去用触发记录，将来用 cron 推算。
 */

import type { ScheduleFireRecord, ScheduleView } from '@shared/types/schedules';
import { cronOccurrences } from './cron-cadence';
import { addDays, dayOffset, isWeekend, minuteOfDay, sameDay, startOfWeek } from './local-days';
import {
  fireTone,
  isScheduleActive,
  recordAgentId,
  type FireTone,
} from './schedule-presenter';

export const FOLD_THRESHOLD = 4;
export const DAYS_PER_WEEK = 7;

export interface DayColumn {
  readonly date: Date;
  readonly isToday: boolean;
  readonly isWeekend: boolean;
}

export type SlotEntry =
  | {
    readonly kind: 'past';
    readonly scheduleId: string;
    readonly name: string;
    readonly at: Date;
    readonly tone: FireTone;
    readonly record: ScheduleFireRecord;
    readonly agentId?: string;
  }
  | {
    readonly kind: 'future';
    readonly scheduleId: string;
    readonly name: string;
    readonly at: Date;
    readonly once: boolean;
    /** 已暂停或已挂起的任务：本该触发但不会触发。 */
    readonly paused: boolean;
  };

export interface SlotRow {
  readonly minuteOfDay: number;
  readonly at: Date;
  /** 七天各自的条目，已按时间排序。 */
  readonly cells: readonly (readonly SlotEntry[])[];
  readonly count: number;
}

export interface BandEntry {
  readonly scheduleId: string;
  readonly name: string;
  readonly total: number;
  readonly past: number;
  readonly future: number;
  readonly paused: boolean;
  readonly tones: Readonly<Record<FireTone, number>>;
}

export interface WeekSummary {
  readonly started: number;
  readonly failed: number;
  readonly skipped: number;
  readonly future: number;
}

export interface SlotGridModel {
  readonly weekStart: Date;
  readonly days: readonly DayColumn[];
  readonly band: readonly (readonly BandEntry[])[];
  readonly rows: readonly SlotRow[];
  /** 「现在」行插在第几行之前；本周不含今天时为 null。 */
  readonly nowRowIndex: number | null;
  readonly summaryByScheduleId: Readonly<Record<string, WeekSummary>>;
  readonly summary: WeekSummary;
}

export interface SlotGridInput {
  readonly weekStart: Date;
  readonly now: Date;
  readonly items: readonly ScheduleView[];
  readonly records: readonly ScheduleFireRecord[];
}

const EMPTY_SUMMARY: WeekSummary = Object.freeze({ started: 0, failed: 0, skipped: 0, future: 0 });

export function buildSlotGrid(input: SlotGridInput): SlotGridModel {
  const weekStart = startOfWeek(input.weekStart);
  const weekEnd = new Date(addDays(weekStart, DAYS_PER_WEEK).getTime() - 1);
  const { now } = input;
  const names = new Map(input.items.map((view) => [view.schedule.scheduleId, view.schedule.name]));

  const days: DayColumn[] = Array.from({ length: DAYS_PER_WEEK }, (_, index) => {
    const date = addDays(weekStart, index);
    return { date, isToday: sameDay(date, now), isWeekend: isWeekend(date) };
  });

  const entries: SlotEntry[] = [];
  for (const record of input.records) {
    const at = new Date(record.manual ? record.firedAt : record.scheduledFor);
    if (Number.isNaN(at.getTime()) || at < weekStart || at > weekEnd) continue;
    entries.push({
      kind: 'past',
      scheduleId: record.scheduleId,
      name: names.get(record.scheduleId) ?? record.scheduleId,
      at,
      tone: fireTone(record),
      record,
      agentId: recordAgentId(record),
    });
  }

  const futureFrom = new Date(Math.max(now.getTime() + 1, weekStart.getTime()));
  if (futureFrom <= weekEnd) {
    for (const view of input.items) {
      const { schedule, state } = view;
      if (state.firedAt) continue;
      const paused = !isScheduleActive(schedule, state);
      if (schedule.trigger.kind === 'once') {
        const at = new Date(schedule.trigger.at);
        if (Number.isNaN(at.getTime()) || at < futureFrom || at > weekEnd) continue;
        entries.push({ kind: 'future', scheduleId: schedule.scheduleId, name: schedule.name, at, once: true, paused });
        continue;
      }
      // 周期任务从锚点之后起算；锚点已在过去时，本周剩余时刻就是 futureFrom 之后的匹配。
      const anchor = new Date(Math.max(futureFrom.getTime(), Date.parse(state.lastFiredAt ?? schedule.createdAt) || 0));
      for (const at of cronOccurrences(schedule.trigger.expression, schedule.trigger.timezone, anchor, weekEnd)) {
        entries.push({ kind: 'future', scheduleId: schedule.scheduleId, name: schedule.name, at, once: false, paused });
      }
    }
  }

  // 折叠：按（任务，天）计数，≥ 阈值的进全天带。
  const perDay = new Map<string, SlotEntry[]>();
  for (const entry of entries) {
    const key = `${entry.scheduleId}\n${dayOffset(entry.at, weekStart)}`;
    const bucket = perDay.get(key);
    if (bucket) bucket.push(entry);
    else perDay.set(key, [entry]);
  }
  const band: BandEntry[][] = days.map(() => []);
  const rowEntries: SlotEntry[] = [];
  for (const bucket of perDay.values()) {
    const first = bucket[0]!;
    const dayIndex = dayOffset(first.at, weekStart);
    if (bucket.length < FOLD_THRESHOLD) {
      rowEntries.push(...bucket);
      continue;
    }
    const tones: Record<FireTone, number> = { ok: 0, err: 0, skip: 0 };
    let past = 0;
    let future = 0;
    let paused = false;
    for (const entry of bucket) {
      if (entry.kind === 'past') {
        past += 1;
        tones[entry.tone] += 1;
      } else {
        future += 1;
        paused = paused || entry.paused;
      }
    }
    band[dayIndex]!.push({
      scheduleId: first.scheduleId,
      name: first.name,
      total: bucket.length,
      past,
      future,
      paused,
      tones,
    });
  }
  for (const cell of band) cell.sort((left, right) => left.name.localeCompare(right.name));

  const byMinute = new Map<number, SlotEntry[][]>();
  for (const entry of rowEntries) {
    const minute = minuteOfDay(entry.at);
    let cells = byMinute.get(minute);
    if (!cells) {
      cells = days.map(() => []);
      byMinute.set(minute, cells);
    }
    cells[dayOffset(entry.at, weekStart)]!.push(entry);
  }
  const rows: SlotRow[] = [...byMinute.entries()]
    .sort(([left], [right]) => left - right)
    .map(([minute, cells]) => {
      for (const cell of cells) cell.sort((left, right) => left.at.getTime() - right.at.getTime());
      const at = new Date(weekStart);
      at.setMinutes(minute);
      return { minuteOfDay: minute, at, cells, count: cells.reduce((sum, cell) => sum + cell.length, 0) };
    });

  const todayIndex = days.findIndex((day) => day.isToday);
  const nowMinute = minuteOfDay(now);
  const nowRowIndex = todayIndex < 0
    ? null
    : rows.findIndex((row) => row.minuteOfDay > nowMinute) === -1
      ? rows.length
      : rows.findIndex((row) => row.minuteOfDay > nowMinute);

  const summaryByScheduleId: Record<string, WeekSummary> = {};
  const total = { ...EMPTY_SUMMARY };
  const bump = (scheduleId: string, key: keyof WeekSummary): void => {
    const current = summaryByScheduleId[scheduleId] ?? EMPTY_SUMMARY;
    summaryByScheduleId[scheduleId] = { ...current, [key]: current[key] + 1 };
    total[key] += 1;
  };
  for (const entry of entries) {
    if (entry.kind === 'future') {
      if (!entry.paused) bump(entry.scheduleId, 'future');
      continue;
    }
    switch (entry.tone) {
      case 'ok':
        bump(entry.scheduleId, 'started');
        break;
      case 'err':
        bump(entry.scheduleId, 'failed');
        break;
      case 'skip':
        bump(entry.scheduleId, 'skipped');
        break;
    }
  }

  return { weekStart, days, band, rows, nowRowIndex, summaryByScheduleId, summary: total };
}
