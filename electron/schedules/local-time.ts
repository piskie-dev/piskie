/**
 * 定时任务的本地时间换算：全部经 Intl 按 IANA 时区计算，不依赖进程时区。
 */

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
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

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClockOf(date: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): number => (
    Number(parts.find((part) => part.type === type)?.value ?? '0')
  );
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

function wallClockAsUtc(clock: WallClock): number {
  return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second);
}

/** `2026-09-18 09:00`，按给定时区的墙上时间。 */
export function formatLocalDateTime(date: Date, timeZone: string): string {
  const clock = wallClockOf(date, timeZone);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${clock.year}-${pad(clock.month)}-${pad(clock.day)} ${pad(clock.hour)}:${pad(clock.minute)}`;
}

/**
 * 解析模型给出的时刻。带偏移或 Z 的按其本身解析；不带偏移的按 `timeZone` 的墙上时间解析。
 * 返回 null 表示格式无法识别。
 */
export function parseLocalDateTime(input: string, timeZone: string): Date | null {
  const trimmed = input.trim();
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) {
    const absolute = new Date(trimmed);
    return Number.isNaN(absolute.getTime()) ? null : absolute;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(trimmed);
  if (!match) return null;
  const clock: WallClock = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4] ?? '0'),
    minute: Number(match[5] ?? '0'),
    second: Number(match[6] ?? '0'),
  };
  if (clock.hour > 23 || clock.minute > 59 || clock.second > 59) return null;
  const wall = wallClockAsUtc(clock);
  if (Number.isNaN(wall)) return null;
  const probe = new Date(wall);
  if (probe.getUTCMonth() !== clock.month - 1 || probe.getUTCDate() !== clock.day) return null;
  // 先假设墙上时间就是 UTC，再用该时刻的时区偏移修正；夏令时边界上再迭代一次收敛。
  let guess = wall;
  for (let round = 0; round < 2; round += 1) {
    const offset = wallClockAsUtc(wallClockOf(new Date(guess), timeZone)) - guess;
    guess = wall - offset;
  }
  return new Date(guess);
}
