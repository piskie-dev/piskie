import { z } from 'zod';
import type {
  BotState,
  MessagingAgentBindings,
  MessagingConnectionConfig,
} from '../../../shared/types/im-gateway.js';
import type { ConfigValidationIssue } from '../../../shared/types/config.js';
import { CHANNEL_DESCRIPTORS } from '../../im-gateway/channel-descriptors.js';
import type {
  ConfigDomainIntegrations,
  ConfigDomainReader,
} from './integrations.js';
import { createManagedDomain } from './domain-factory.js';

const channelKeys = CHANNEL_DESCRIPTORS.map((descriptor) => descriptor.channelKey) as [
  (typeof CHANNEL_DESCRIPTORS)[number]['channelKey'],
  ...(typeof CHANNEL_DESCRIPTORS)[number]['channelKey'][],
];

const channelTypeSchema = z.enum(channelKeys)
  .describe('Registered IM channel implementation used by this Bot.');

const forwardAssistantTextSchema = z.boolean()
  .describe('Whether complete assistant text is forwarded to the conversation.');

const toolFilterFields = {
  mode: z.enum(['include', 'exclude']).describe('Whether listed tool names are included or excluded.'),
  tools: z.array(z.string().trim().min(1).describe('Tool name used by the forwarding filter.'))
    .describe('Tool names used by the forwarding filter.'),
};

const replyForwardShape = {
  forwardAssistantText: forwardAssistantTextSchema,
  forwardToolCalls: z.boolean().describe('Whether tool calls are forwarded to the conversation.'),
  forwardToolResults: z.boolean().describe('Whether tool results are forwarded to the conversation.'),
  toolFilter: z.strictObject(toolFilterFields)
    .describe('Optional tool forwarding filter.')
    .optional(),
};

const replyForwardSchema = z.strictObject(replyForwardShape);

const storedReplyForwardSchema = z.object({
  ...replyForwardShape,
  forwardAssistantText: forwardAssistantTextSchema.default(true),
  toolFilter: z.object(toolFilterFields).optional(),
});

const appSecretSchema = z.string()
  .describe('Channel application secret returned unchanged by config show and Plan output.')
  .meta({
    'x-piskie': {
      changeImpact: 'Takes effect the next time the Connector starts.',
      applyMode: 'next-connector-start',
    },
  });

const channelCredentialContracts = {
  application: {
    schema: z.strictObject({
      appId: z.string().trim().min(1).describe('Channel application or Bot identifier.'),
      appSecret: appSecretSchema.refine((value) => value.length > 0, 'Channel application secret is required.'),
    }),
    project: (bot: { appId?: string; appSecret?: string }) => ({
      appId: bot.appId,
      appSecret: bot.appSecret,
    }),
  },
  account: {
    schema: z.strictObject({}),
    project: () => ({}),
  },
} as const;

const botWriteSchema = z.strictObject({
  channelType: channelTypeSchema,
  name: z.string().trim().min(1).describe('User-visible Bot name.'),
  definitionId: z.string().trim().min(1)
    .describe('Optional Task Definition used for incoming messages.')
    .optional(),
  replyForward: replyForwardSchema.describe('Reply forwarding policy.').optional(),
  appId: z.string().describe('Channel application or Bot identifier.').optional(),
  appSecret: appSecretSchema.optional(),
  corpId: z.string().describe('Optional enterprise organization identifier.').optional(),
  agentId: z.number().int().describe('Optional enterprise application Agent ID.').optional(),
  dmPolicy: z.enum(['open', 'pairing', 'allowlist', 'disabled'])
    .describe('Direct-message access policy.').optional(),
  allowFrom: z.array(z.string().describe('Allowed direct-message sender identifier.'))
    .describe('Direct-message sender allowlist.').optional(),
  groupPolicy: z.enum(['open', 'allowlist', 'disabled'])
    .describe('Group-message access policy.').optional(),
  groupAllowFrom: z.array(z.string().describe('Allowed group identifier.'))
    .describe('Allowed group identifiers.').optional(),
  groupSenderAllowFrom: z.array(z.string().describe('Allowed group sender identifier.'))
    .describe('Allowed group sender identifiers.').optional(),
  requireMention: z.boolean().describe('Whether group messages must mention the Bot.').optional(),
}).superRefine((bot, context) => {
  for (const issue of botCredentialIssues(bot)) context.addIssue({ ...issue });
});

const botStoredSchema = z.object({
  ...botWriteSchema.shape,
  replyForward: storedReplyForwardSchema.optional(),
}).superRefine((bot, context) => {
  for (const issue of botCredentialIssues(bot)) context.addIssue({ ...issue });
});

const botReadSchema = z.strictObject({
  ...botWriteSchema.shape,
}).extend({
  pluginAccountId: z.string()
    .describe('Observed channel account identifier created by the login lifecycle.')
    .optional(),
  status: z.enum(['stopped', 'starting', 'running', 'stopping', 'stop_failed', 'error'])
    .describe('Observed Connector runtime status.'),
  error: z.string().describe('Observed Connector or configuration error.').optional(),
  startedAt: z.string().describe('Observed Connector start timestamp.').optional(),
});

const botRecordMetadata = {
  'x-piskie': { keyPlaceholder: 'botId', applyMode: 'next-connector-start' },
};

const agentBindingWriteSchema = z.strictObject({
  peerKind: z.enum(['direct', 'group'])
    .describe('Natural IM peer kind.'),
  peerId: z.string().trim().min(1)
    .describe('Natural IM peer identifier supplied by the channel.'),
  agentId: z.string().trim().min(1)
    .describe('Existing Agent ID bound to this natural IM conversation.'),
});

const agentBindingsWriteSchema = z.record(
  z.string().trim().min(1),
  z.array(agentBindingWriteSchema),
).default({});

export const imBotsWriteSchema = z.strictObject({
  bots: z.record(z.string().trim().min(1), botWriteSchema)
    .describe('IM Bot configurations keyed by immutable Bot ID.')
    .meta(botRecordMetadata),
  agentBindings: agentBindingsWriteSchema
    .describe('System-maintained natural IM conversation bindings keyed by Bot ID.'),
});

export const imBotsReadSchema = z.strictObject({
  revision: z.number().int().nonnegative().describe('Monotonic im-bots revision.'),
  bots: z.record(z.string().trim().min(1), botReadSchema)
    .describe('IM Bot configuration plus read-only Connector status.')
    .meta(botRecordMetadata),
  agentBindings: agentBindingsWriteSchema
    .describe('Natural IM conversation bindings keyed by Bot ID.'),
});

type BotWrite = z.infer<typeof botWriteSchema>;
type ImBotsWrite = z.infer<typeof imBotsWriteSchema>;
type ImBotsRead = z.infer<typeof imBotsReadSchema>;
interface ImBotsDocument {
  revision: number;
  bots: Record<string, BotWrite>;
  agentBindings: MessagingAgentBindings;
}

export function createImBotsDomain(
  rootDirectory: string,
  integration: ConfigDomainIntegrations['imBots'],
  readDomain: ConfigDomainReader,
) {
  return createManagedDomain<ImBotsDocument, ImBotsRead, ImBotsWrite>(rootDirectory, {
    contract: {
      id: 'im-bots',
      title: 'IM Bots',
      description: 'Channel credentials, access policy and Task Definition bindings; Connector lifecycle actions are excluded.',
      schemaVersion: 2,
      readSchema: imBotsReadSchema,
      writeSchema: imBotsWriteSchema,
      capabilities: ['show', 'plan', 'validate', 'apply', 'verify', 'history', 'rollback'],
      extensions: channelExtensions,
    },
      codec: { parse: (raw) => imBotsStoredSchema.parse(raw) },
    bootstrap: () => ({ revision: 0, bots: {}, agentBindings: {} }),
    adapter: {
      projectRead: (stored) => projectRead(stored, integration),
      normalizeCandidate: (current, patched) => ({
        ...patched,
        revision: current.revision,
        bots: Object.fromEntries(Object.entries(patched.bots)
          .sort(([left], [right]) => left.localeCompare(right))),
        agentBindings: normalizeAgentBindings(current, patched),
      }),
      dependencyRevisions: async () => ({
        'task-definitions': revisionOf(await readDomain('task-definitions')),
      }),
      validateSemantic: async (candidate) => {
        const issues = [
          ...validateTaskDefinitionBindings(
            candidate,
            await readDomain('task-definitions'),
          ),
          ...validateAgentBindings(candidate),
        ];
        if (issues.length === 0) await integration.validate(toBotConfigs(candidate));
        return { valid: issues.length === 0, issues };
      },
      analyzeImpact: (current, candidate) => {
        const impacts = Object.keys(current.bots)
          .filter((id) => !candidate.bots[id])
          .map((id) => ({
            code: 'IM_BOT_REMOVED',
            severity: 'high' as const,
            path: `/bots/${escapePointer(id)}`,
            message: `IM Bot ${id} will be removed and an active Connector will be stopped.`,
          }));
        for (const [id, bot] of Object.entries(candidate.bots)) {
          const previous = current.bots[id];
          if (previous && previous.definitionId !== bot.definitionId) impacts.push({
            code: 'IM_BOT_TASK_DEFINITION_CHANGED',
            severity: 'high' as const,
            path: `/bots/${escapePointer(id)}/definitionId`,
            message: bot.definitionId
              ? `IM Bot ${id} will bind to Task Definition ${bot.definitionId}; it must be quiescent.`
              : `IM Bot ${id} will be unbound; it must be quiescent.`,
          });
        }
        return impacts;
      },
      publish: (candidate, context) => integration.publish(toBotConfigs(candidate), context),
    },
  });
}

export const imBotsStoredSchema = z.object({
  revision: z.number().int().nonnegative(),
  bots: z.record(z.string().trim().min(1), botStoredSchema),
  agentBindings: z.record(
    z.string().trim().min(1),
    z.array(z.object({
      peerKind: z.enum(['direct', 'group']),
      peerId: z.string().trim().min(1),
      agentId: z.string().trim().min(1),
    })),
  ).default({}),
});

function projectRead(
  document: ImBotsDocument,
  integration: ConfigDomainIntegrations['imBots'],
): ImBotsRead {
  const configs = toBotConfigs(document);
  const observed: readonly BotState[] = integration.observe?.(configs) ?? configs.map((config) => ({
    config,
    status: 'stopped' as const,
  }));
  const states = new Map(observed.map((state) => [state.config.id, state]));
  return {
    ...document,
    revision: document.revision,
    bots: Object.fromEntries(Object.entries(document.bots).map(([id, bot]) => {
      const state = states.get(id);
      return [id, {
        ...bot,
        ...(state?.config.pluginAccountId && { pluginAccountId: state.config.pluginAccountId }),
        status: state?.status ?? 'stopped',
        ...(state?.error && { error: state.error }),
        ...(state?.startedAt && { startedAt: state.startedAt }),
      }];
    })),
  };
}

function toBotConfigs(document: ImBotsDocument): MessagingConnectionConfig[] {
  return Object.entries(document.bots).map(([id, bot]) => ({ id, ...bot } as MessagingConnectionConfig));
}

function validateTaskDefinitionBindings(
  document: ImBotsDocument,
  definitions: unknown,
): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  const owners = new Map<string, string>();
  for (const [id, bot] of Object.entries(document.bots)) {
    const definitionId = bot.definitionId;
    if (!definitionId) continue;
    const definition = recordEntry(definitions, 'definitions', definitionId);
    if (!definition) {
      issues.push({
        stage: 'reference',
        code: 'IM_BOT_TASK_DEFINITION_NOT_FOUND',
        path: `/bots/${escapePointer(id)}/definitionId`,
        message: `IM Bot ${id} references missing Task Definition ${definitionId}.`,
      });
      continue;
    }
    if (definition.purpose !== 'messaging') {
      issues.push({
        stage: 'semantic',
        code: 'IM_BOT_TASK_DEFINITION_NOT_MESSAGING',
        path: `/bots/${escapePointer(id)}/definitionId`,
        message: `Task Definition ${definitionId} is not intended for IM messaging.`,
        details: { definitionId, purpose: definition.purpose },
      });
      continue;
    }
    const ownerBotId = owners.get(definitionId);
    if (ownerBotId) {
      issues.push({
        stage: 'semantic',
        code: 'IM_BOT_TASK_DEFINITION_ALREADY_BOUND',
        path: `/bots/${escapePointer(id)}/definitionId`,
        message: `Task Definition ${definitionId} is already bound to IM Bot ${ownerBotId}.`,
        details: { definitionId, ownerBotId, conflictingBotId: id },
      });
      continue;
    }
    owners.set(definitionId, id);
  }
  return issues;
}

function normalizeAgentBindings(
  current: ImBotsDocument,
  patched: ImBotsWrite,
): MessagingAgentBindings {
  for (const [botId, bindings] of Object.entries(patched.agentBindings)) {
    if (bindings.length === 0) continue;
    const previous = current.bots[botId];
    const next = patched.bots[botId];
    if (previous && (!next || previous.definitionId !== next.definitionId)) {
      throw new Error(`Clear IM Agent bindings before changing Bot ${botId}'s definition`);
    }
  }
  return Object.fromEntries(Object.entries(patched.agentBindings)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([botId, bindings]) => [botId, [...bindings].sort((left, right) => (
      left.peerKind.localeCompare(right.peerKind)
        || left.peerId.localeCompare(right.peerId)
    ))]));
}

function validateAgentBindings(document: ImBotsDocument): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  for (const [botId, bindings] of Object.entries(document.agentBindings)) {
    const bot = document.bots[botId];
    if (!bot?.definitionId) {
      issues.push({
        stage: 'reference',
        code: 'IM_AGENT_BINDING_BOT_UNAVAILABLE',
        path: `/agentBindings/${escapePointer(botId)}`,
        message: `IM Agent bindings require Bot ${botId} to have a Task Definition.`,
      });
      continue;
    }
    const conversations = new Set<string>();
    for (const [index, binding] of bindings.entries()) {
      const key = JSON.stringify([binding.peerKind, binding.peerId]);
      if (!conversations.has(key)) {
        conversations.add(key);
        continue;
      }
      issues.push({
        stage: 'semantic',
        code: 'IM_AGENT_BINDING_DUPLICATE_CONVERSATION',
        path: `/agentBindings/${escapePointer(botId)}/${index}`,
        message: `Bot ${botId} has more than one binding for the same IM conversation.`,
      });
    }
  }
  return issues;
}

function channelExtensions() {
  return CHANNEL_DESCRIPTORS.map((descriptor) => ({
    id: `im-channel:${descriptor.channelKey}`,
    kind: 'im-channel',
    title: descriptor.channelKey,
    selector: { path: '/bots/{botId}/channelType', value: descriptor.channelKey },
    schemas: [{
      name: 'channelConfig',
      path: '/bots/{botId}',
      schema: z.toJSONSchema(channelCredentialContracts[descriptor.credentialKind].schema, { io: 'input' }) as Record<string, unknown>,
    }],
  }));
}

function recordEntry(
  value: unknown,
  collection: string,
  id: string,
): Record<string, unknown> | undefined {
  if (!isRecord(value) || !isRecord(value[collection])) return undefined;
  const entry = value[collection][id];
  return isRecord(entry) ? entry : undefined;
}

function botCredentialIssues(bot: {
  channelType: z.infer<typeof channelTypeSchema>;
  appId?: string;
  appSecret?: string;
}) {
  const descriptor = CHANNEL_DESCRIPTORS.find((entry) => entry.channelKey === bot.channelType)!;
  const credential = channelCredentialContracts[descriptor.credentialKind];
  const result = credential.schema.safeParse(credential.project(bot));
  return result.success ? [] : result.error.issues;
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
