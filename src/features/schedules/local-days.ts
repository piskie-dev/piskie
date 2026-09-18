/** 按渲染进程所在时区的本地日历做的日期算术；定时任务页只在这一处碰 Date 的本地字段。 */

export const DAY_MS = 86_400_000;

export function startOfDay(date: Date): Date {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

/** 周一为一周之始。 */
export function startOfWeek(date: Date): Date {
  const day = startOfDay(date);
  const offset = (day.getDay() + 6) % 7;
  day.setDate(day.getDate() - offset);
  return day;
}

export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export function sameDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

export function minuteOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

export function isWeekend(date: Date): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

/** 与 `date` 相差的整天数（按本地日历，今天 = 0，明天 = 1，昨天 = -1）。 */
export function dayOffset(date: Date, from: Date): number {
  return Math.round((startOfDay(date).getTime() - startOfDay(from).getTime()) / DAY_MS);
}

export function dayKey(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `<input type="datetime-local">` 的值：本地时间，精确到分。 */
export function toDateTimeLocalValue(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${dayKey(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromDateTimeLocalValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number) as [number, number, number, number, number, number];
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}
