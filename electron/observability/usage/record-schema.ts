import { z } from 'zod';

const count = z.number().finite().nonnegative();
const text = z.string().max(1024);
export const usageRecordSchema = z.object({
  schemaVersion: z.literal(1), id: text, runId: text, attempt: z.number().int().positive(),
  startedAt: count, endedAt: count.optional(), firstResponseMs: count.optional(),
  mainAgentId: text.optional(), agentId: text.optional(), agentType: text.optional(),
  runName: text.optional(), requestId: text.optional(),
  purpose: z.enum(['inference', 'compaction', 'test']),
  providerId: text, providerName: text, modelId: text, modelName: text, protocol: text,
  reasoning: text.optional(), configRevision: count,
  status: z.enum(['running', 'success', 'failed', 'cancelled', 'interrupted']),
  usage: z.object({
    totalInputTokens: count.optional(), totalOutputTokens: count.optional(),
    cachedInputTokens: count.optional(), cacheWriteTokens: count.optional(), reasoningTokens: count.optional(),
  }),
  error: z.object({ source: text, stage: text, code: text.optional(), httpStatus: count.optional() }).optional(),
});
