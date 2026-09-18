/**
 * 渲染层的 cron 工具：识别预设节律、生成表达式、枚举一段时间内的触发时刻。
 * 与主进程一样只接受 5 字段（分 时 日 月 周），按任务自带的 IANA 时区解释。
 */

import { Cron } from 'croner';

export type CronPreset = 'daily' | 'weekdays' | 'weekly' | 'hourly' | 'custom';

export type Cadence =
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekdays'; hour: number; minute: number }
  | { kind: 'weekly'; weekday: number; hour: number; minute: number }
  | { kind: 'hourly'; minute: number }
  | { kind: 'everyHours'; every: number; minute: number }
  | { kind: 'custom' };

export type CronProblem = 'field-count' | 'timezone' | 'syntax' | 'never';

export const CRON_FIELD_COUNT = 5;

const NUMBER = /^\d{1,2}$/;
const STEP_HOURS = /^\*\/(\d{1,2})$/;

export function normalizeCron(expression: string): string {
  return expression.trim().split(/\s+/).filter(Boolean).join(' ');
}

export function parseCadence(expression: string): Cadence {
  const fields = normalizeCron(expression).split(' ');
  if (fields.length !== CRON_FIELD_COUNT) return { kind: 'custom' };
  const [minuteField, hourField, dayField, monthField, weekdayField] = fields as [string, string, string, string, string];
  if (!NUMBER.test(minuteField) || dayField !== '*' || monthField !== '*') return { kind: 'custom' };
  const minute = Number(minuteField);
  if (minute > 59) return { kind: 'custom' };

  if (hourField === '*' && weekdayField === '*') return { kind: 'hourly', minute };
  const step = STEP_HOURS.exec(hourField);
  if (step && weekdayField === '*') {
    const every = Number(step[1]);
    return every >= 1 && every <= 23 ? { kind: 'everyHours', every, minute } : { kind: 'custom' };
  }
  if (!NUMBER.test(hourField)) return { kind: 'custom' };
  const hour = Number(hourField);
  if (hour > 23) return { kind: 'custom' };

  if (weekdayField === '*') return { kind: 'daily', hour, minute };
  if (weekdayField === '1-5') return { kind: 'weekdays', hour, minute };
  if (NUMBER.test(weekdayField)) {
    const weekday = Number(weekdayField);
    if (weekday <= 7) return { kind: 'weekly', weekday: weekday % 7, hour, minute };
  }
  return { kind: 'custom' };
}

export function presetOf(cadence: Cadence): CronPreset {
  switch (cadence.kind) {
    case 'daily':
    case 'weekdays':
    case 'weekly':
    case 'hourly':
      return cadence.kind;
    default:
      return 'custom';
  }
}

export interface PresetInput {
  hour: number;
  minute: number;
  /** 0 = 周日 … 6 = 周六 */
  weekday: number;
}

export function buildCron(preset: Exclude<CronPreset, 'custom'>, input: PresetInput): string {
  switch (preset) {
    case 'daily':
      return `${input.minute} ${input.hour} * * *`;
    case 'weekdays':
      return `${input.minute} ${input.hour} * * 1-5`;
    case 'weekly':
      return `${input.minute} ${input.hour} * * ${input.weekday}`;
    case 'hourly':
      return `${input.minute} * * * *`;
  }
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function checkCron(expression: string, timezone: string): CronProblem | null {
  const normalized = normalizeCron(expression);
  if (normalized.split(' ').length !== CRON_FIELD_COUNT) return 'field-count';
  if (!isValidTimeZone(timezone)) return 'timezone';
  let cron: Cron;
  try {
    cron = new Cron(normalized, { timezone });
  } catch {
    return 'syntax';
  }
  return cron.nextRun() ? null : 'never';
}

/** 严格晚于 `after` 的下一个匹配时刻；表达式无效时返回 null。 */
export function nextCronRun(expression: string, timezone: string, after: Date): Date | null {
  try {
    return new Cron(normalizeCron(expression), { timezone }).nextRun(after);
  } catch {
    return null;
  }
}

/** 闭区间 [from, to] 内的全部匹配时刻，升序；超过 `limit` 条截断，防止高频表达式拖垮界面。 */
export function cronOccurrences(
  expression: string,
  timezone: string,
  from: Date,
  to: Date,
  limit = 20_000,
): Date[] {
  let cron: Cron;
  try {
    cron = new Cron(normalizeCron(expression), { timezone });
  } catch {
    return [];
  }
  const result: Date[] = [];
  let cursor = new Date(from.getTime() - 1);
  while (result.length < limit) {
    const next = cron.nextRun(cursor);
    if (!next || next.getTime() > to.getTime()) break;
    result.push(next);
    cursor = next;
  }
  return result;
}
