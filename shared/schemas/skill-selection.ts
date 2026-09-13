import { z } from 'zod';

/** User selections retain their order after name normalization. */
export const skillSelectionSchema = z.array(z.string().trim().min(1))
  .transform((names) => [...new Set(names)]);
