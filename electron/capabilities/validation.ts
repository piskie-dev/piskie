import { z } from 'zod';

export const identifier = z.string().trim().min(1).max(512);
const finiteInteger = z.number().int().finite();
export const nonNegativeInteger = finiteInteger.min(0);
export const plainRecord = z.record(z.string(), z.unknown());

export function args(items: readonly z.ZodType[]): z.ZodType<unknown[]> {
  if (items.length === 0) return z.tuple([]) as z.ZodType<unknown[]>;
  return z.tuple(items as [z.ZodType, ...z.ZodType[]]) as z.ZodType<unknown[]>;
}
