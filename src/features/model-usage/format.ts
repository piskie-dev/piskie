import type { UsageSummary } from '../../../shared/types/model-usage';

export const number = (value: number | undefined) => value === undefined ? '—' : new Intl.NumberFormat(undefined, { maximumFractionDigits: 1, notation: value >= 10_000 ? 'compact' : 'standard' }).format(value);
export const percent = (value: number | undefined) => value === undefined ? '—' : `${(value * 100).toFixed(1)}%`;
export const duration = (ms: number | undefined) => ms === undefined ? '—' : `${(ms / 1000).toFixed(2)}s`;
export const successRate = (s: UsageSummary) => s.calls > s.running ? s.success / (s.calls - s.running) : undefined;
export const cacheRate = (s: UsageSummary) => s.cacheInput > 0 ? s.cacheHit / s.cacheInput : undefined;
export const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export function dateRange(days: number): { from?: number; to?: number } {
  if (!days) return {};
  const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - days + 1);
  const end = new Date(); end.setHours(0, 0, 0, 0); end.setDate(end.getDate() + 1);
  return { from: start.getTime(), to: end.getTime() };
}
