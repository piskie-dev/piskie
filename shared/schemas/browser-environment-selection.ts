import { z } from 'zod';

/** Browser environments a user message joins to the session: trimmed, non-empty, order-preserving unique IDs. */
export const browserEnvironmentSelectionSchema = z.array(z.string().trim().min(1))
  .transform((ids) => [...new Set(ids)]);

export function uniqueBrowserEnvironmentIds(ids: readonly string[] | undefined): string[] {
  if (!ids?.length) return [];
  return [...new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0))];
}
