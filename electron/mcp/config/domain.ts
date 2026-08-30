/**
 * config domain 'mcp'（全局显式层）
 *
 * 存放全局 MCP server 配置、上下文预算比例与项目级信任表；
 * 项目级 {workspace}/.piskie/mcp.json 不在此域（随 workspace 走的素材，无 revision 体系）。
 */

import { z } from 'zod';
import type { McpConfigDocument, McpServerConfig, McpTrustRecord } from '../../../shared/types/mcp.js';
import { mcpServerConfigSchema } from '../../../shared/schemas/mcp.js';
import type {
  ConfigDomainIntegrations,
  ConfigDomainReader,
} from '../../config/domains/integrations.js';
import { createManagedDomain } from '../../config/domains/domain-factory.js';

const serversSchema = z.record(z.string().trim().min(1), mcpServerConfigSchema)
  .describe('MCP servers keyed by user-chosen server name.')
  .meta({
    'x-piskie': {
      keyPlaceholder: 'serverName',
      applyMode: 'next-injection',
      changeImpact: 'Config changes affect the next injection moment (new agent or session resume); running agents keep their snapshot.',
    },
  });

const trustRecordSchema = z.strictObject({
  workspace: z.string().min(1).describe('Workspace realpath the trusted server belongs to.'),
  server: z.string().min(1).describe('Server name inside that workspace.'),
  trustedAt: z.string().describe('ISO timestamp of the trust decision.'),
});

const trustTableSchema = z.record(z.string(), trustRecordSchema)
  .describe('Project-level server trust table keyed by hash(workspace + server name + config content).');

const budgetRatioSchema = z.number().gt(0).lt(1)
  .describe('Share of the model context window reserved for MCP tool schemas, defaults to 0.05.');

export const mcpWriteSchema = z.strictObject({
  mcpServers: serversSchema,
  context_budget_ratio: budgetRatioSchema.optional(),
  trusted_project_servers: trustTableSchema.optional(),
});

export const mcpReadSchema = z.strictObject({
  revision: z.number().int().nonnegative().describe('Monotonic mcp-domain revision.'),
  mcpServers: serversSchema,
  context_budget_ratio: budgetRatioSchema.optional(),
  trusted_project_servers: trustTableSchema.optional(),
});

type McpWrite = z.infer<typeof mcpWriteSchema>;
type McpRead = z.infer<typeof mcpReadSchema>;
type McpDocument = McpRead;

export interface McpDomainSnapshot extends McpConfigDocument {
  revision: number
  contextBudgetRatio?: number
  trustedProjectServers: Record<string, McpTrustRecord>
}

export function toMcpDomainSnapshot(document: McpDocument): McpDomainSnapshot {
  return {
    revision: document.revision,
    mcpServers: document.mcpServers as Record<string, McpServerConfig>,
    contextBudgetRatio: document.context_budget_ratio,
    trustedProjectServers: (document.trusted_project_servers ?? {}) as Record<string, McpTrustRecord>,
  };
}

export function createMcpDomain(
  rootDirectory: string,
  integration: ConfigDomainIntegrations['mcp'],
  readDomain?: ConfigDomainReader,
) {
  return createManagedDomain<McpDocument, McpRead, McpWrite>(rootDirectory, {
    contract: {
      id: 'mcp',
      title: 'MCP servers',
      description: 'Global MCP server connections, context budget ratio and the project-server trust table. Project-level overlays live in each workspace, not here.',
      schemaVersion: 1,
      readSchema: mcpReadSchema,
      writeSchema: mcpWriteSchema,
      capabilities: ['show', 'plan', 'validate', 'apply', 'verify', 'history', 'rollback'],
    },
    codec: { parse: (raw) => mcpReadSchema.parse(raw) },
    bootstrap: () => ({ revision: 0, mcpServers: {} }),
    adapter: {
      projectRead: (stored) => stored,
      normalizeCandidate: (current, patched) => ({ ...patched, revision: current.revision }),
      ...(readDomain && {
        dependencyRevisions: async () => ({
          proxies: revisionOf(await readDomain('proxies')),
        }),
        validateSemantic: async (candidate: McpDocument) => validateProxyReferences(
          candidate,
          await readDomain('proxies'),
        ),
      }),
      publish: (candidate, context) => integration.publish(toMcpDomainSnapshot(candidate), context),
    },
  });
}

function validateProxyReferences(candidate: McpDocument, proxies: unknown) {
  const proxyIds = recordKeys(proxies, 'proxies');
  const issues = Object.entries(candidate.mcpServers).flatMap(([name, server]) => (
    server.proxyId && !proxyIds.has(server.proxyId)
      ? [{
          stage: 'reference' as const,
          code: 'MCP_PROXY_NOT_FOUND',
          path: `/mcpServers/${escapePointer(name)}/proxyId`,
          message: `MCP server ${name} references missing global proxy ${server.proxyId}.`,
        }]
      : []
  ));
  return { valid: issues.length === 0, issues };
}

function recordKeys(value: unknown, field: string): Set<string> {
  if (!isRecord(value) || !isRecord(value[field])) return new Set();
  return new Set(Object.keys(value[field]));
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
