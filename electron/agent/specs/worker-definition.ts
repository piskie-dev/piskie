import { z } from 'zod';

const nonempty = z.string().trim().min(1);
const duration = z.number().int().positive();

/** Serializable declarations accepted by the shared Worker registration entry. */
export const workerDefinitionSchema = z.strictObject({
  name: nonempty,
  description: nonempty,
  instructions: nonempty,
  assignment: z.enum(['question', 'task-board']),
  tools: z.array(z.strictObject({
    name: nonempty,
    options: z.record(z.string(), z.json()).optional(),
  })).min(1),
  resources: z.strictObject({
    browser: z.strictObject({ shareWithParent: z.boolean().optional() }).optional(),
    image: z.boolean().optional(),
  }).optional(),
  excludedTools: z.array(nonempty).optional(),
  includeSkillDocs: z.boolean().optional(),
  allowedParentSpecs: z.array(nonempty).min(1).optional(),
  mcpServers: z.array(nonempty).optional(),
  lifecycle: z.strictObject({
    onTerminal: z.enum(['grace', 'immediate']).optional(),
    graceMs: duration.optional(),
    deadlineMs: duration.optional(),
    stalledAfterMs: duration.optional(),
  }).optional(),
});

export type WorkerDefinition = z.infer<typeof workerDefinitionSchema>;
