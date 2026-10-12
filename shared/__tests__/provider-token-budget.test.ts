import { describe, expect, it } from 'vitest';
import { providerBudgetPeriod } from '../provider-token-budget.js';

describe('provider token budget periods', () => {
  it('repeats weekly from the selected reset boundary', () => {
    const resetAt = new Date(2026, 9, 5, 9).getTime();
    const budget = { period: 'weekly' as const, limit: 1000, resetAt };
    expect(providerBudgetPeriod(budget, resetAt - 1)).toEqual({
      start: new Date(2026, 8, 28, 9).getTime(), end: resetAt,
    });
    expect(providerBudgetPeriod(budget, resetAt)).toEqual({
      start: resetAt, end: new Date(2026, 9, 12, 9).getTime(),
    });
  });

  it('clamps monthly resets to the last day of short months', () => {
    const resetAt = new Date(2026, 0, 31, 10).getTime();
    const budget = { period: 'monthly' as const, limit: 1000, resetAt };
    expect(providerBudgetPeriod(budget, new Date(2026, 1, 28, 10).getTime())).toEqual({
      start: new Date(2026, 1, 28, 10).getTime(),
      end: new Date(2026, 2, 31, 10).getTime(),
    });
  });
});
