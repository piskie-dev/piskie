import { z } from 'zod';
import type { TaskDefinition } from '../../../shared/types/index.js';
import type { ConfigValidationIssue } from '../../../shared/types/config.js';
import type {
  ConfigDomainIntegrations,
  ConfigDomainReader,
} from './integrations.js';
import { createManagedDomain } from './domain-factory.js';

const definitionIdSchema = z.string().trim().min(1)
  .describe('Immutable non-empty Task Definition ID.');

const taskDefinitionPurposeSchema = z.enum(['general', 'messaging'])
  .describe('Exclusive runtime surface this Task Definition is intended for.');

const runtimeFingerprintFields = {
  platform: z.enum(['macos', 'windows', 'linux'])
    .describe('Browser fingerprint operating-system family.').optional(),
  clientHintsFromUA: z.boolean()
    .describe('Derive browser client hints from the configured user agent.').optional(),
  webrtc: z.enum(['proxy', 'real'])
    .describe('WebRTC network identity policy.').optional(),
  hardwareConcurrency: z.number()
    .describe('Browser fingerprint logical processor count.').optional(),
  geoMode: z.enum(['block', 'real'])
    .describe('Browser geolocation exposure policy.').optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
};

const runtimeFingerprintWriteSchema = z.strictObject(runtimeFingerprintFields);
const runtimeFingerprintStoredSchema = z.object(runtimeFingerprintFields);

const taskAdvancedSettingsFields = {
  language: z.string().describe('Preferred browser language.').optional(),
  userAgent: z.string().describe('Browser user-agent override.').optional(),
  backgroundMode: z.boolean().describe('Whether browser work starts in background mode.').optional(),
};

const taskAdvancedSettingsWriteSchema = z.strictObject({
  ...taskAdvancedSettingsFields,
  fingerprint: runtimeFingerprintWriteSchema.optional(),
});
const taskAdvancedSettingsStoredSchema = z.object({
  ...taskAdvancedSettingsFields,
  fingerprint: runtimeFingerprintStoredSchema.optional(),
});

const taskBindingsFields = {
  type: z.literal('standard').describe('Standard Task Definition binding shape.'),
  boundEnvironmentIds: z.array(
    z.string().trim().min(1).describe('Browser environment ID available to this task.'),
  ).describe('Browser environments available to future AgentRuns.').optional(),
};
const taskBindingsWriteSchema = z.strictObject(taskBindingsFields);
const taskBindingsStoredSchema = z.object(taskBindingsFields);

const mcpServersSchema = z.array(
  z.string().trim().min(1).describe('MCP server name available to this task.'),
).describe('MCP server selection copied into future AgentRuns.').check((context) => {
  if (new Set(context.value).size !== context.value.length) {
    context.issues.push({
      code: 'custom',
      message: 'MCP server names must be unique.',
      input: context.value,
    });
  }
});

const definitionWriteFields = {
  name: z.string().trim().min(1).describe('User-visible Task Definition name.'),
  description: z.string().describe('User-visible explanation of the reusable task.'),
  category: z.string().trim().min(1).describe('Optional Task Definition category.').optional(),
  purpose: taskDefinitionPurposeSchema,
  promptTemplate: z.string().describe('Initial task instruction copied into each AgentRun.'),
  systemPrompt: z.string().describe('Optional system instruction copied into each AgentRun.').optional(),
  defaultModeId: z.enum(['normal', 'plan'])
    .describe('Default initial mode for future AgentRuns.').default('normal'),
  defaultApprovalMode: z.enum(['auto', 'confirm'])
    .describe('Default approval policy for future AgentRuns.').default('confirm'),
  workspace: z.string().trim().min(1)
    .describe('Default workspace copied into future AgentRuns.').optional(),
  metadata: taskBindingsWriteSchema.optional(),
  advancedSettings: taskAdvancedSettingsWriteSchema.optional(),
  mcpServers: mcpServersSchema.optional(),
};

const definitionWriteSchema = z.strictObject(definitionWriteFields);
const definitionReadSchema = z.object({
  ...definitionWriteFields,
  createdAt: z.string().datetime(),
});
const definitionStoredSchema = z.object({
  ...definitionWriteFields,
  purpose: taskDefinitionPurposeSchema.optional(),
  metadata: taskBindingsStoredSchema.optional(),
  advancedSettings: taskAdvancedSettingsStoredSchema.optional(),
  createdAt: z.string().datetime(),
}).transform((definition) => ({
  ...definition,
  purpose: definition.purpose ?? legacyTaskDefinitionPurpose(definition),
}));

const recordMetadata = {
  'x-piskie': {
    keyPlaceholder: 'definitionId',
    changeImpact: 'Changes affect only future AgentRun snapshots.',
  },
};

export const taskDefinitionsWriteSchema = z.strictObject({
  definitions: z.record(definitionIdSchema, definitionWriteSchema)
    .describe('Reusable task definitions keyed by immutable ID.')
    .meta(recordMetadata),
});

export const taskDefinitionsReadSchema = z.object({
  revision: z.number().int().nonnegative(),
  definitions: z.record(definitionIdSchema, definitionReadSchema).meta(recordMetadata),
});

export const taskDefinitionsStoredSchema = z.object({
  revision: z.number().int().nonnegative(),
  definitions: z.record(definitionIdSchema, definitionStoredSchema),
});

type DefinitionRead = z.infer<typeof definitionReadSchema>;
type DefinitionsWrite = z.infer<typeof taskDefinitionsWriteSchema>;
type DefinitionsRead = z.infer<typeof taskDefinitionsReadSchema>;

interface TaskDefinitionsDocument {
  revision: number;
  definitions: Record<string, DefinitionRead>;
}

export function createTaskDefinitionsDomain(
  rootDirectory: string,
  integration: ConfigDomainIntegrations['taskDefinitions'],
  readDomain: ConfigDomainReader,
  now: () => Date = () => new Date(),
) {
  let published: Record<string, DefinitionRead> = {};
  return createManagedDomain<TaskDefinitionsDocument, DefinitionsRead, DefinitionsWrite>(
    rootDirectory,
    {
      contract: {
        id: 'task-definitions',
        title: 'Task Definitions',
        description: 'Reusable user-created task definitions for future Agent runs.',
        schemaVersion: 2,
        readSchema: taskDefinitionsReadSchema,
        writeSchema: taskDefinitionsWriteSchema,
        capabilities: ['show', 'plan', 'validate', 'apply', 'verify', 'history', 'rollback'],
      },
      codec: { parse: (raw) => taskDefinitionsStoredSchema.parse(raw) },
      bootstrap: () => ({ revision: 0, definitions: {} }),
      adapter: {
        projectRead: (stored) => stored,
        normalizeCandidate: (current, patched) => ({
          ...patched,
          revision: current.revision,
          definitions: Object.fromEntries(Object.entries(patched.definitions)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([id, definition]) => [id, {
              ...definition,
              createdAt: current.definitions[id]?.createdAt ?? now().toISOString(),
            }])),
        }),
        dependencyRevisions: async () => ({
          'im-bots': revisionOf(await readDomain('im-bots')),
        }),
        validateSemantic: async (candidate) => {
          const issues = validateBoundDefinitionPurposes(
            candidate,
            await readDomain('im-bots'),
          );
          return { valid: issues.length === 0, issues };
        },
        analyzeImpact: async (current, candidate) => {
          const bots = await readDomain('im-bots');
          return Object.keys(current.definitions)
            .filter((id) => !candidate.definitions[id])
            .map((id) => {
              const affectedBots = botsBoundToDefinition(bots, id);
              return {
                code: 'TASK_DEFINITION_REMOVED',
                severity: 'high' as const,
                path: `/definitions/${escapePointer(id)}`,
                message: affectedBots.length > 0
                  ? `Task Definition ${id} will be removed and ${affectedBots.length} bound IM Bot(s) will become invalid.`
                  : `Task Definition ${id} will be removed; existing AgentRun snapshots are retained.`,
                details: { affectedBots },
              };
            });
        },
        publish: async (candidate, context) => {
          const removed = Object.keys(published).filter((id) => !candidate.definitions[id]);
          await integration.publish(
            Object.entries(candidate.definitions).map(([id, definition]) => (
              toTaskDefinition(id, definition)
            )),
            removed,
            context,
          );
          published = structuredClone(candidate.definitions);
        },
      },
    },
  );
}

function toTaskDefinition(definitionId: string, definition: DefinitionRead): TaskDefinition {
  return { definitionId, ...definition };
}

function legacyTaskDefinitionPurpose(
  definition: Pick<TaskDefinition, 'promptTemplate'>,
): TaskDefinition['purpose'] {
  return definition.promptTemplate === '' ? 'messaging' : 'general';
}

function botsBoundToDefinition(value: unknown, definitionId: string): string[] {
  if (!isRecord(value) || !isRecord(value.bots)) return [];
  return Object.entries(value.bots)
    .filter(([, bot]) => isRecord(bot) && bot.definitionId === definitionId)
    .map(([id]) => id)
    .sort();
}

function validateBoundDefinitionPurposes(
  document: TaskDefinitionsDocument,
  botsValue: unknown,
): ConfigValidationIssue[] {
  if (!isRecord(botsValue) || !isRecord(botsValue.bots)) return [];
  const issues: ConfigValidationIssue[] = [];
  for (const [botId, bot] of Object.entries(botsValue.bots)) {
    if (!isRecord(bot) || typeof bot.definitionId !== 'string') continue;
    const definition = document.definitions[bot.definitionId];
    if (!definition || definition.purpose === 'messaging') continue;
    issues.push({
      stage: 'semantic',
      code: 'TASK_DEFINITION_PURPOSE_INCOMPATIBLE_WITH_IM_BINDING',
      path: `/definitions/${escapePointer(bot.definitionId)}/purpose`,
      message: `Task Definition ${bot.definitionId} is bound to IM Bot ${botId} and must retain messaging purpose.`,
      details: { definitionId: bot.definitionId, botId, purpose: definition.purpose },
    });
  }
  return issues;
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
