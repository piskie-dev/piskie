import { z } from 'zod';

export const userFileRefSchema = z.object({
  name: z.string().min(1),
  path: z.string().regex(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/, 'Expected an absolute file path'),
}).strict();
