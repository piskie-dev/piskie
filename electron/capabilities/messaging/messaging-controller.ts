import { z } from 'zod';
import {
  MESSAGING_OPERATIONS,
  MESSAGING_TOPICS,
} from '../../../shared/electron-contracts/messaging.js';
import type { SaveMessagingConnectionRequest } from '../../../shared/electron-contracts/messaging.js';
import type { OperationDefinition, TopicDefinition } from '../catalog.js';
import { args, identifier } from '../validation.js';
import type { MessagingApplication } from './messaging-application.js';

const botSchema = z.object({
  id: identifier,
  channelType: identifier,
  name: identifier,
  definitionId: identifier.optional(),
  replyForward: z.object({
    forwardAssistantText: z.boolean(),
    forwardToolCalls: z.boolean(),
    forwardToolResults: z.boolean(),
    toolFilter: z.object({
      mode: z.enum(['include', 'exclude']),
      tools: z.array(identifier).max(1_000),
    }).optional(),
  }).optional(),
  appId: z.string().max(8_192),
  appSecret: z.string().max(16_384).optional(),
  pluginAccountId: z.string().max(8_192).optional(),
  corpId: z.string().max(8_192).optional(),
  agentId: z.number().int().optional(),
  dmPolicy: z.enum(['open', 'pairing', 'allowlist', 'disabled']).optional(),
  allowFrom: z.array(z.string().max(4_096)).max(10_000).optional(),
  groupPolicy: z.enum(['open', 'allowlist', 'disabled']).optional(),
  groupAllowFrom: z.array(z.string().max(4_096)).max(10_000).optional(),
  groupSenderAllowFrom: z.array(z.string().max(4_096)).max(10_000).optional(),
  requireMention: z.boolean().optional(),
}).strict();

export function createMessagingController(
  application: MessagingApplication,
): { operations: readonly OperationDefinition[]; topics: readonly TopicDefinition[] } {
  const operations: OperationDefinition[] = [
    operation(MESSAGING_OPERATIONS.listConnectors, args([]), () => (
      application.listConnectors()
    )),
    operation(MESSAGING_OPERATIONS.saveBot, args([botSchema]), ([config]) => (
      application.saveBot(config as SaveMessagingConnectionRequest)
    )),
    operation(MESSAGING_OPERATIONS.deleteBot, args([identifier]), ([botId]) => (
      application.deleteBot(botId)
    )),
    operation(MESSAGING_OPERATIONS.startBot, args([identifier]), ([botId]) => (
      application.startBot(botId)
    )),
    operation(MESSAGING_OPERATIONS.stopBot, args([identifier]), ([botId]) => (
      application.stopBot(botId)
    )),
    operation(MESSAGING_OPERATIONS.status, args([]), () => application.status()),
    operation(MESSAGING_OPERATIONS.pendingAuthorization, args([]), () => (
      application.pendingAuthorization()
    )),
    operation(MESSAGING_OPERATIONS.approve, args([identifier]), ([requestId]) => (
      application.approve(requestId)
    )),
    operation(MESSAGING_OPERATIONS.reject, args([identifier]), ([requestId]) => (
      application.reject(requestId)
    )),
    operation(MESSAGING_OPERATIONS.authorizedUsers, args([]), () => application.authorizedUsers()),
    operation(
      MESSAGING_OPERATIONS.addAuthorizedUser,
      args([identifier, identifier, z.string().max(4_096).optional()]),
      ([botId, senderId, senderName]) => application.addAuthorizedUser(botId, senderId, senderName),
    ),
    operation(
      MESSAGING_OPERATIONS.removeAuthorizedUser,
      args([identifier, identifier]),
      ([botId, senderId]) => application.removeAuthorizedUser(botId, senderId),
    ),
    operation(
      MESSAGING_OPERATIONS.startQrLogin,
      args([identifier, identifier, z.boolean().optional()]),
      ([botId, channelType, force]) => application.startQrLogin(botId, channelType, force),
    ),
    operation(
      MESSAGING_OPERATIONS.waitForQrLogin,
      args([identifier, identifier]),
      ([botId, channelType]) => application.waitForQrLogin(botId, channelType),
    ),
    operation(
      MESSAGING_OPERATIONS.submitQrCode,
      args([identifier, identifier, z.string().trim().min(1).max(4_096)]),
      ([botId, channelType, code]) => application.submitQrCode(botId, channelType, code),
    ),
    operation(
      MESSAGING_OPERATIONS.cancelQrLogin,
      args([identifier, identifier]),
      ([botId, channelType]) => application.cancelQrLogin(botId, channelType),
    ),
    operation(MESSAGING_OPERATIONS.logoutAccount, args([identifier]), ([botId]) => (
      application.logoutAccount(botId)
    )),
  ];

  const topics: TopicDefinition[] = [
    {
      id: MESSAGING_TOPICS.status,
      capability: 'messaging',
      input: z.undefined(),
      async open(context, _input, emit) {
        const dispose = application.subscribeStatus(emit, context.signal);
        return { snapshot: await application.status(), dispose };
      },
    },
    {
      id: MESSAGING_TOPICS.authorization,
      capability: 'messaging',
      input: z.undefined(),
      open(context, _input, emit) {
        const dispose = application.subscribeAuthorization(emit, context.signal);
        return { snapshot: application.pendingAuthorization(), dispose };
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
  execute: (input: any[]) => unknown,
): OperationDefinition<unknown[]> {
  return {
    id,
    capability: 'messaging',
    input,
    execute: (_context, value) => execute(value),
  };
}
