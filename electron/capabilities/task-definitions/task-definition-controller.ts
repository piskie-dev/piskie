import { z } from 'zod';
import {
  TASK_DEFINITION_OPERATIONS,
  type TaskDefinitionCreateInput,
  type TaskDefinitionUpdateInput,
} from '../../../shared/electron-contracts/task-definitions.js';
import type { ControllerContext, OperationDefinition } from '../catalog.js';
import { args, identifier } from '../validation.js';
import type { TaskDefinitionApplication } from './task-definition-application.js';

const fingerprintSchema = z.object({
  platform: z.enum(['macos', 'windows', 'linux']).optional(),
  clientHintsFromUA: z.boolean().optional(),
  webrtc: z.enum(['proxy', 'real']).optional(),
  hardwareConcurrency: z.number().optional(),
  geoMode: z.enum(['block', 'real']).optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
}).strict();
const advancedSettingsSchema = z.object({
  language: z.string().optional(),
  userAgent: z.string().optional(),
  backgroundMode: z.boolean().optional(),
  fingerprint: fingerprintSchema.optional(),
}).strict();
const metadataSchema = z.object({
  type: z.literal('standard'),
  boundEnvironmentIds: z.array(identifier).optional(),
}).strict();
const definitionFields = {
  name: z.string().trim().min(1),
  description: z.string(),
  category: z.string().trim().min(1).optional(),
  purpose: z.enum(['general', 'messaging']),
  promptTemplate: z.string(),
  systemPrompt: z.string().optional(),
  defaultModeId: z.enum(['normal', 'plan']).optional(),
  defaultApprovalMode: z.enum(['auto', 'confirm']).optional(),
  workspace: z.string().trim().min(1).optional(),
  metadata: metadataSchema.optional(),
  advancedSettings: advancedSettingsSchema.optional(),
  mcpServers: z.array(identifier).optional(),
};
const createSchema = z.object(definitionFields).strict();
const updateSchema = createSchema.partial();

export function createTaskDefinitionController(
  application: TaskDefinitionApplication,
): readonly OperationDefinition[] {
  return Object.freeze([
    operation(TASK_DEFINITION_OPERATIONS.list, args([]), () => application.list()),
    operation(TASK_DEFINITION_OPERATIONS.create, args([createSchema]), ([input]) => (
      application.create(input as TaskDefinitionCreateInput)
    )),
    operation(
      TASK_DEFINITION_OPERATIONS.update,
      args([identifier, updateSchema]),
      ([definitionId, updates]) => application.update(
        definitionId,
        updates as TaskDefinitionUpdateInput,
      ),
    ),
    operation(
      TASK_DEFINITION_OPERATIONS.delete,
      args([identifier]),
      ([definitionId]) => application.delete(definitionId),
    ),
  ]);
}

function operation(
  id: string,
  input: z.ZodType<unknown[]>,
  execute: (input: any[], context: ControllerContext) => unknown,
): OperationDefinition<unknown[]> {
  return {
    id,
    capability: 'task-definitions',
    input,
    execute: (context, value) => execute(value, context),
  };
}
