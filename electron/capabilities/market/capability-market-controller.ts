import { z } from 'zod';
import {
  CAPABILITY_OPERATIONS,
  CAPABILITY_TOPICS,
} from '../../../shared/electron-contracts/market.js';
import { mcpServerConfigSchema } from '../../../shared/schemas/mcp.js';
import type {
  MarketInstalledQuery,
  MarketInstallRequest,
  MarketListQuery,
  MarketManageRequest,
} from '../../../shared/types/market.js';
import type { McpServerConfig } from '../../../shared/types/mcp.js';
import type { OperationDefinition, TopicDefinition } from '../catalog.js';
import { args, identifier, nonNegativeInteger } from '../validation.js';
import type { CapabilityMarketApplication } from './capability-market-application.js';

const workspaceOptions = z.object({ workspace: identifier.optional() }).optional();
const mcpListOptions = z.object({
  scope: z.enum(['user', 'project', 'all']).optional(),
  workspace: identifier.optional(),
}).optional();
const marketKinds = z.array(z.enum(['skill', 'mcp', 'plugin'])).max(3).optional();
const marketListQuery = z.object({
  query: z.string().max(4_096).optional(),
  kinds: marketKinds,
  sourceIds: z.array(identifier).max(100).optional(),
  offset: nonNegativeInteger.optional(),
  limit: z.number().int().min(1).max(200).optional(),
  refreshIfStale: z.boolean().optional(),
}).optional();
const installedQuery = z.object({
  query: z.string().max(4_096).optional(),
  kinds: marketKinds,
  scopes: z.array(z.enum(['builtin', 'user', 'project'])).max(3).optional(),
  workspace: identifier.optional(),
  updatesOnly: z.boolean().optional(),
  offset: nonNegativeInteger.optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).optional();

export function createCapabilityMarketController(
  application: CapabilityMarketApplication,
): { operations: readonly OperationDefinition[]; topics: readonly TopicDefinition[] } {
  const operations: OperationDefinition[] = [
    operation(CAPABILITY_OPERATIONS.listMcp, args([mcpListOptions]), ([input]) => (
      application.listMcp(input)
    )),
    operation(CAPABILITY_OPERATIONS.getMcp, args([identifier, workspaceOptions]), ([name, input]) => (
      application.getMcp(name, input)
    )),
    operation(CAPABILITY_OPERATIONS.searchMcp, args([z.string().trim().min(1).max(4_096)]), ([query]) => (
      application.searchMcp(query)
    )),
    operation(
      CAPABILITY_OPERATIONS.addMcp,
      args([z.object({
        name: identifier,
        scope: z.enum(['user', 'project']),
        workspace: identifier.optional(),
        config: mcpServerConfigSchema,
        force: z.boolean().optional(),
      })]),
      ([input]) => application.addMcp(input as { name: string; scope: 'user' | 'project'; workspace?: string; config: McpServerConfig; force?: boolean }),
    ),
    operation(
      CAPABILITY_OPERATIONS.removeMcp,
      args([identifier, z.object({
        scope: z.enum(['user', 'project']),
        workspace: identifier.optional(),
      })]),
      ([name, input]) => application.removeMcp(name, input),
    ),
    operation(CAPABILITY_OPERATIONS.probeMcp, args([identifier, workspaceOptions]), ([name, input]) => (
      application.probeMcp(name, input)
    )),
    operation(
      CAPABILITY_OPERATIONS.mcpBudget,
      args([z.object({
        workspace: identifier.optional(),
        contextWindowTokens: z.number().int().positive().optional(),
      }).optional()]),
      ([input]) => application.mcpBudget(input),
    ),
    operation(CAPABILITY_OPERATIONS.trustMcp, args([identifier, identifier]), ([name, workspace]) => (
      application.trustMcp(name, workspace)
    )),
    operation(
      CAPABILITY_OPERATIONS.loginMcp,
      args([identifier, z.object({
        workspace: identifier.optional(),
        scopes: z.array(identifier).max(100).optional(),
      }).optional()]),
      ([name, input]) => application.loginMcp(name, input),
    ),
    operation(CAPABILITY_OPERATIONS.logoutMcp, args([identifier, workspaceOptions]), ([name, input]) => (
      application.logoutMcp(name, input)
    )),
    operation(CAPABILITY_OPERATIONS.mcpAuth, args([identifier, workspaceOptions]), ([name, input]) => (
      application.authMcp(name, input)
    )),
    operation(
      CAPABILITY_OPERATIONS.prewarmMcp,
      args([z.object({
        workspace: identifier.optional(),
        runSelection: z.array(identifier).max(100).optional(),
        specName: identifier,
      })]),
      ([input]) => application.prewarmMcp(input),
    ),
    operation(CAPABILITY_OPERATIONS.mcpPrewarmStatus, args([identifier]), ([token]) => (
      application.prewarmStatus(token)
    )),
    operation(CAPABILITY_OPERATIONS.releaseMcpPrewarm, args([identifier]), ([token]) => (
      application.releasePrewarm(token)
    )),
    {
      id: CAPABILITY_OPERATIONS.retryMcp,
      capability: 'capabilities',
      input: args([z.object({
        sessionRuntimeId: identifier,
        serverNames: z.array(identifier).max(100).optional(),
      })]),
      execute: (context, input) => application.retryMcp(
        (input as Array<{ sessionRuntimeId: string; serverNames?: string[] }>)[0],
        context.signal,
      ),
    },
    operation(
      CAPABILITY_OPERATIONS.mcpSessions,
      args([z.object({ workspace: identifier.optional(), serverName: identifier.optional() }).optional()]),
      ([input]) => application.activeMcpSessions(input),
    ),
    operation(CAPABILITY_OPERATIONS.listMarket, args([marketListQuery]), ([query]) => (
      application.listMarket(query as MarketListQuery | undefined)
    )),
    operation(CAPABILITY_OPERATIONS.installedMarket, args([installedQuery]), ([query]) => (
      application.installedMarket(query as MarketInstalledQuery | undefined)
    )),
    operation(
      CAPABILITY_OPERATIONS.refreshMarket,
      args([z.array(identifier).max(100).optional()]),
      ([sourceIds]) => application.refreshMarket(sourceIds),
    ),
    operation(CAPABILITY_OPERATIONS.marketDetail, args([identifier]), ([entryId]) => (
      application.marketDetail(entryId)
    )),
    operation(
      CAPABILITY_OPERATIONS.installMarket,
      args([z.object({
        entryId: identifier,
        scope: z.enum(['user', 'project']),
        workspaces: z.array(identifier).max(100).optional(),
        force: z.boolean().optional(),
        allowExecutable: z.boolean().optional(),
      })]),
      ([input]) => application.installMarket(input as MarketInstallRequest),
    ),
    operation(
      CAPABILITY_OPERATIONS.manageMarket,
      args([z.object({
        itemId: identifier,
        action: z.enum(['enable', 'disable', 'remove', 'probe']),
        workspace: identifier.optional(),
        purge: z.boolean().optional(),
      })]),
      ([input]) => application.manageMarket(input as MarketManageRequest),
    ),
    operation(CAPABILITY_OPERATIONS.marketSources, args([]), () => application.marketSources()),
    operation(
      CAPABILITY_OPERATIONS.addMarketSource,
      args([z.object({
        name: identifier,
        kind: z.enum([
          'git-skills',
          'mcp-registry',
          'openai-plugin-marketplace',
          'anthropic-plugin-marketplace',
        ]),
        url: z.string().url().max(8_192),
        ref: z.string().max(1_024).optional(),
      })]),
      ([input]) => application.addMarketSource(input),
    ),
    operation(CAPABILITY_OPERATIONS.removeMarketSource, args([identifier]), ([sourceId]) => (
      application.removeMarketSource(sourceId)
    )),
    operation(CAPABILITY_OPERATIONS.marketProjects, args([]), () => application.marketProjects()),
    operation(CAPABILITY_OPERATIONS.previewMarket, args([identifier.optional()]), ([workspace]) => (
      application.previewMarket(workspace)
    )),
  ];

  const changes: TopicDefinition = {
    id: CAPABILITY_TOPICS.marketChanges,
    capability: 'capabilities',
    input: z.undefined(),
    async open(context, _input, emit) {
      const dispose = application.changes.subscribe(emit, { signal: context.signal });
      return {
        snapshot: { sources: await application.marketSources() },
        dispose,
      };
    },
  };

  return Object.freeze({
    operations: Object.freeze(operations),
    topics: Object.freeze([changes]),
  });
}

function operation(
  id: string,
  input: z.ZodType<unknown[]>,
  execute: (input: any[]) => unknown,
): OperationDefinition<unknown[]> {
  return {
    id,
    capability: 'capabilities',
    input,
    execute: (_context, value) => execute(value),
  };
}
