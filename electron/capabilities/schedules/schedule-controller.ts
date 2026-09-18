import { z } from 'zod';
import {
  SCHEDULE_OPERATIONS,
  SCHEDULE_TOPICS,
  type ScheduleCreateInput,
  type ScheduleHistoryQuery,
  type ScheduleUpdateInput,
} from '../../../shared/electron-contracts/schedules.js';
import type { ControllerContext, OperationDefinition, TopicDefinition } from '../catalog.js';
import { args, identifier } from '../validation.js';
import type { ScheduleApplication } from './schedule-application.js';

const isoMoment = z.string().datetime({ offset: true });

const triggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), at: isoMoment }).strict(),
  z.object({
    kind: z.literal('cron'),
    expression: z.string().trim().min(1),
    timezone: z.string().trim().min(1),
  }).strict(),
]);

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
const bindingsSchema = z.object({
  type: z.literal('standard'),
  boundEnvironmentIds: z.array(identifier).optional(),
}).strict();

const inlineLaunchSchema = z.object({
  kind: z.literal('inline'),
  workspace: z.string().trim().min(1).optional(),
  bindings: bindingsSchema.optional(),
  advancedSettings: advancedSettingsSchema.optional(),
  mcpServers: z.array(identifier).optional(),
  approvalMode: z.enum(['auto', 'confirm']),
  model: z.string().trim().min(1).optional(),
}).strict();

const actionSchema = z.union([
  z.object({
    kind: z.literal('new_run'),
    launch: z.object({ kind: z.literal('definition'), definitionId: identifier }).strict(),
  }).strict(),
  z.object({
    kind: z.literal('new_run'),
    prompt: z.string().trim().min(1),
    launch: inlineLaunchSchema,
  }).strict(),
  z.object({
    kind: z.literal('inject'),
    prompt: z.string().trim().min(1),
    agentId: identifier,
  }).strict(),
]);

const createSchema = z.object({
  name: z.string().trim().min(1).max(40),
  trigger: triggerSchema,
  runIfMissed: z.boolean(),
  action: actionSchema,
  enabled: z.boolean().optional(),
}).strict();
const updateSchema = createSchema.partial();

const historyQuerySchema = z.object({
  from: isoMoment,
  to: isoMoment,
  scheduleId: identifier.optional(),
}).strict();

export function createScheduleController(
  application: ScheduleApplication,
): { operations: readonly OperationDefinition[]; topics: readonly TopicDefinition[] } {
  const operations: OperationDefinition[] = [
    operation(SCHEDULE_OPERATIONS.list, args([]), () => application.list()),
    operation(SCHEDULE_OPERATIONS.create, args([createSchema]), ([input]) => (
      application.create(input as ScheduleCreateInput)
    )),
    operation(SCHEDULE_OPERATIONS.update, args([identifier, updateSchema]), ([scheduleId, updates]) => (
      application.update(scheduleId, updates as ScheduleUpdateInput)
    )),
    operation(SCHEDULE_OPERATIONS.delete, args([identifier]), ([scheduleId]) => (
      application.delete(scheduleId)
    )),
    operation(SCHEDULE_OPERATIONS.runNow, args([identifier]), ([scheduleId]) => (
      application.runNow(scheduleId)
    )),
    operation(SCHEDULE_OPERATIONS.queryHistory, args([historyQuerySchema]), ([query]) => (
      application.queryHistory(query as ScheduleHistoryQuery)
    )),
  ];

  const topics: TopicDefinition[] = [
    {
      id: SCHEDULE_TOPICS.changes,
      capability: 'schedules',
      input: z.undefined(),
      open(context, _input, emit) {
        const dispose = application.subscribe(emit, context.signal);
        return { snapshot: application.list(), dispose };
      },
    },
  ];

  return Object.freeze({
    operations: Object.freeze(operations),
    topics: Object.freeze(topics),
  });
}

function operation(
  id: string,
  input: z.ZodType<unknown[]>,
  execute: (input: any[], context: ControllerContext) => unknown,
): OperationDefinition<unknown[]> {
  return {
    id,
    capability: 'schedules',
    input,
    execute: (context, value) => execute(value, context),
  };
}
