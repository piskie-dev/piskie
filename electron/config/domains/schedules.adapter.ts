import { z } from 'zod';
import type { ConfigValidationIssue } from '../../../shared/types/config.js';
import type { Schedule } from '../../../shared/types/schedules.js';
import { checkCron } from '../../schedules/next-fire.js';
import type {
  ConfigDomainIntegrations,
  ConfigDomainReader,
} from './integrations.js';
import { createManagedDomain } from './domain-factory.js';
import {
  mcpServersSchema,
  taskAdvancedSettingsStoredSchema,
  taskAdvancedSettingsWriteSchema,
  taskBindingsStoredSchema,
  taskBindingsWriteSchema,
} from './task-definitions.adapter.js';

const scheduleIdSchema = z.string().trim().min(1)
  .describe('Immutable non-empty Schedule ID.');

const SCHEDULE_NAME_MAX = 40;

const triggerSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('once').describe('Fires once at `at`.'),
    at: z.string().datetime({ offset: true })
      .describe('Absolute moment (ISO 8601) this Schedule fires once.'),
  }),
  z.strictObject({
    kind: z.literal('cron').describe('Fires repeatedly on a cron expression.'),
    expression: z.string().trim().min(1)
      .describe('Standard 5-field cron expression: minute hour day month weekday.'),
    timezone: z.string().trim().min(1)
      .describe('IANA timezone the cron expression is evaluated in.'),
  }),
]).describe('When the Schedule fires.');

const approvalModeSchema = z.enum(['auto', 'confirm']);

const inlineLaunchFields = {
  kind: z.literal('inline').describe('Run settings captured from the creating session.'),
  workspace: z.string().trim().min(1).optional()
    .describe('Working directory for the new AgentRun.'),
  mcpServers: mcpServersSchema.optional(),
  approvalMode: approvalModeSchema.describe('Approval policy for the new AgentRun.'),
  model: z.string().trim().min(1).optional()
    .describe('Model the new AgentRun starts with; omitted means the default selection.'),
};
const inlineLaunchWriteSchema = z.strictObject({
  ...inlineLaunchFields,
  bindings: taskBindingsWriteSchema.optional(),
  advancedSettings: taskAdvancedSettingsWriteSchema.optional(),
});
const inlineLaunchStoredSchema = z.object({
  ...inlineLaunchFields,
  bindings: taskBindingsStoredSchema.optional(),
  advancedSettings: taskAdvancedSettingsStoredSchema.optional(),
});

const definitionLaunchSchema = z.strictObject({
  kind: z.literal('definition').describe('Prompt and run settings come from a Task Definition.'),
  definitionId: z.string().trim().min(1)
    .describe('Task Definition whose prompt and run settings this Schedule uses.'),
});

function actionSchema<TInline extends z.ZodType>(inline: TInline) {
  return z.union([
    z.strictObject({
      kind: z.literal('new_run').describe('Starts a new top-level AgentRun.'),
      launch: definitionLaunchSchema,
    }),
    z.strictObject({
      kind: z.literal('new_run').describe('Starts a new top-level AgentRun.'),
      prompt: z.string().trim().min(1).describe('Task instruction for the new AgentRun.'),
      launch: inline,
    }),
    z.strictObject({
      kind: z.literal('inject').describe('Delivers the prompt into an existing session.'),
      prompt: z.string().trim().min(1).describe('Instruction delivered into the target session.'),
      agentId: z.string().trim().min(1).describe('Session that receives the instruction.'),
    }),
  ]).describe('What happens when the Schedule fires.');
}

const creatorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user').describe('Created from the Schedules page.') }),
  z.strictObject({
    kind: z.literal('agent').describe('Created by an Agent with the schedule tool.'),
    agentId: z.string().trim().min(1).describe('Session whose Agent created the Schedule.'),
  }),
]).describe('Who created the Schedule.');

const scheduleWriteFields = {
  name: z.string().trim().min(1).max(SCHEDULE_NAME_MAX)
    .describe('User-visible Schedule name.'),
  enabled: z.boolean().describe('Whether the Schedule may fire.').default(true),
  trigger: triggerSchema,
  runIfMissed: z.boolean()
    .describe('Fire once for a slot missed while the app was closed, instead of skipping it.'),
  action: actionSchema(inlineLaunchWriteSchema),
  createdBy: creatorSchema,
};

const scheduleWriteSchema = z.strictObject(scheduleWriteFields);
const scheduleReadSchema = z.object({
  ...scheduleWriteFields,
  createdAt: z.string().datetime(),
});
const scheduleStoredSchema = z.object({
  ...scheduleWriteFields,
  action: actionSchema(inlineLaunchStoredSchema),
  createdBy: creatorSchema.default({ kind: 'user' }),
  createdAt: z.string().datetime(),
});

const recordMetadata = {
  'x-piskie': {
    keyPlaceholder: 'scheduleId',
    changeImpact: 'Changes affect only future fires; the running AgentRun is not touched.',
  },
};

export const schedulesWriteSchema = z.strictObject({
  schedules: z.record(scheduleIdSchema, scheduleWriteSchema)
    .describe('Scheduled tasks keyed by immutable ID.')
    .meta(recordMetadata),
});

export const schedulesReadSchema = z.object({
  revision: z.number().int().nonnegative(),
  schedules: z.record(scheduleIdSchema, scheduleReadSchema).meta(recordMetadata),
});

export const schedulesStoredSchema = z.object({
  revision: z.number().int().nonnegative(),
  schedules: z.record(scheduleIdSchema, scheduleStoredSchema),
});

type ScheduleRead = z.infer<typeof scheduleReadSchema>;
type SchedulesWrite = z.infer<typeof schedulesWriteSchema>;
type SchedulesRead = z.infer<typeof schedulesReadSchema>;

interface SchedulesDocument {
  revision: number;
  schedules: Record<string, ScheduleRead>;
}

export function createSchedulesDomain(
  rootDirectory: string,
  integration: ConfigDomainIntegrations['schedules'],
  readDomain: ConfigDomainReader,
  now: () => Date = () => new Date(),
) {
  return createManagedDomain<SchedulesDocument, SchedulesRead, SchedulesWrite>(
    rootDirectory,
    {
      contract: {
        id: 'schedules',
        title: 'Schedules',
        description: 'Scheduled tasks that start Agent runs or notify sessions at planned moments.',
        schemaVersion: 1,
        readSchema: schedulesReadSchema,
        writeSchema: schedulesWriteSchema,
        capabilities: ['show', 'plan', 'validate', 'apply', 'verify', 'history', 'rollback'],
      },
      codec: { parse: (raw) => schedulesStoredSchema.parse(raw) },
      bootstrap: () => ({ revision: 0, schedules: {} }),
      adapter: {
        projectRead: (stored) => stored,
        normalizeCandidate: (current, patched) => ({
          ...patched,
          revision: current.revision,
          schedules: Object.fromEntries(Object.entries(patched.schedules)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([id, schedule]) => [id, {
              ...schedule,
              createdAt: current.schedules[id]?.createdAt ?? now().toISOString(),
            }])),
        }),
        dependencyRevisions: async () => ({
          'task-definitions': revisionOf(await readDomain('task-definitions')),
        }),
        validateSemantic: async (candidate) => {
          const definitions = await readDomain('task-definitions');
          const issues: ConfigValidationIssue[] = [];
          for (const [id, schedule] of Object.entries(candidate.schedules)) {
            issues.push(...validateTrigger(id, schedule));
            issues.push(...validateAction(id, schedule, definitions, integration));
          }
          return { valid: issues.every((issue) => issue.severity === 'warning'), issues };
        },
        analyzeImpact: async (current, candidate) => Object.keys(current.schedules)
          .filter((id) => !candidate.schedules[id])
          .map((id) => ({
            code: 'SCHEDULE_REMOVED',
            severity: 'warning' as const,
            path: `/schedules/${escapePointer(id)}`,
            message: `Schedule ${id} will be removed together with its fire history.`,
          })),
        publish: async (candidate, context) => {
          await integration.publish(
            Object.entries(candidate.schedules).map(([id, schedule]) => toSchedule(id, schedule)),
            context,
          );
        },
      },
    },
  );
}

function toSchedule(scheduleId: string, schedule: ScheduleRead): Schedule {
  return { scheduleId, ...schedule } as Schedule;
}

function validateTrigger(id: string, schedule: ScheduleRead): ConfigValidationIssue[] {
  const path = `/schedules/${escapePointer(id)}/trigger`;
  const { trigger } = schedule;
  if (trigger.kind === 'once') {
    if (Number.isNaN(new Date(trigger.at).getTime())) {
      return [issue('SCHEDULE_TRIGGER_INVALID', `${path}/at`, 'Fire moment is not a valid date.')];
    }
    return [];
  }
  const problem = checkCron(trigger.expression, trigger.timezone);
  if (!problem) return [];
  if (problem === 'timezone') {
    return [issue('SCHEDULE_TIMEZONE_INVALID', `${path}/timezone`, `Unknown timezone ${trigger.timezone}.`)];
  }
  const messages: Record<Exclude<typeof problem, 'timezone'>, string> = {
    'field-count': 'Cron expression must have exactly five fields: minute hour day month weekday.',
    syntax: 'Cron expression contains an invalid field value.',
    never: 'Cron expression never matches any moment.',
  };
  return [issue('SCHEDULE_CRON_INVALID', `${path}/expression`, messages[problem])];
}

function validateAction(
  id: string,
  schedule: ScheduleRead,
  definitions: unknown,
  integration: ConfigDomainIntegrations['schedules'],
): ConfigValidationIssue[] {
  const path = `/schedules/${escapePointer(id)}/action`;
  const { action } = schedule;
  if (action.kind === 'inject') {
    if (integration.sessionExists && !integration.sessionExists(action.agentId)) {
      return [{
        ...issue('SCHEDULE_TARGET_MISSING', `${path}/agentId`, `Session ${action.agentId} no longer exists; the Schedule will be suspended when it fires.`),
        severity: 'warning',
      }];
    }
    return [];
  }
  if (action.launch.kind !== 'definition') return [];
  if (!definitionExists(definitions, action.launch.definitionId)) {
    return [issue(
      'SCHEDULE_TEMPLATE_MISSING',
      `${path}/launch/definitionId`,
      `Task Definition ${action.launch.definitionId} does not exist.`,
    )];
  }
  return [];
}

function issue(code: string, path: string, message: string): ConfigValidationIssue {
  return { stage: 'semantic', code, path, message };
}

function definitionExists(value: unknown, definitionId: string): boolean {
  return isRecord(value) && isRecord(value.definitions) && isRecord(value.definitions[definitionId]);
}

function revisionOf(value: unknown): number {
  return isRecord(value) && Number.isInteger(value.revision) ? value.revision as number : 0;
}

function escapePointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
