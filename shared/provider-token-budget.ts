import type { ProviderTokenBudget } from './types/model-usage.js';

const WEEK_MS = 7 * 24 * 60 * 60_000;

function boundary(budget: ProviderTokenBudget, offset: number): number {
  const anchor = new Date(budget.resetAt);
  if (budget.period === 'weekly') {
    const date = new Date(anchor);
    date.setDate(anchor.getDate() + offset * 7);
    return date.getTime();
  }
  const month = anchor.getFullYear() * 12 + anchor.getMonth() + offset;
  const year = Math.floor(month / 12);
  const monthOfYear = month - year * 12;
  const lastDay = new Date(year, monthOfYear + 1, 0).getDate();
  return new Date(year, monthOfYear, Math.min(anchor.getDate(), lastDay),
    anchor.getHours(), anchor.getMinutes(), anchor.getSeconds(), anchor.getMilliseconds()).getTime();
}

export function providerBudgetPeriod(budget: ProviderTokenBudget, now: number): { start: number; end: number } {
  const anchor = new Date(budget.resetAt);
  let offset = budget.period === 'weekly'
    ? Math.floor((now - budget.resetAt) / WEEK_MS)
    : (new Date(now).getFullYear() - anchor.getFullYear()) * 12
      + new Date(now).getMonth() - anchor.getMonth();
  while (boundary(budget, offset) > now) offset--;
  while (boundary(budget, offset + 1) <= now) offset++;
  return { start: boundary(budget, offset), end: boundary(budget, offset + 1) };
}

export function nextDefaultBudgetReset(period: ProviderTokenBudget['period'], now = Date.now()): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  if (period === 'weekly') date.setDate(date.getDate() + ((8 - date.getDay()) % 7 || 7));
  else date.setMonth(date.getMonth() + 1, 1);
  return date.getTime();
}
