import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { EffectiveMcpServer } from '@shared/types/mcp.js'
import { getPilotRoot } from '../../piskiepilot/paths.js'
import { discoverPluginMcpContributions } from '../../plugins/mcp-members.js'
import { isProjectLayerActive } from '../../skills/store/layout.js'
import { mcpReadSchema, toMcpDomainSnapshot, type McpDomainSnapshot } from '../config/domain.js'
import { readProjectMcpOverlay } from '../config/project-overlay.js'
import { normalizeWorkspace } from '../config/trust.js'
import { evaluateEffectiveServers, type SkippedServer } from '../bridge/snapshot.js'
import {
  launchFingerprint,
  projectContextId,
  resolveMcpServerCredentialIdentities,
  stableFingerprint,
} from './identity.js'

let currentGlobalSnapshot: McpDomainSnapshot | undefined

export interface McpCapabilityDiagnostic {
  readonly server: string
  readonly origin: EffectiveMcpServer['origin']
  readonly transport: EffectiveMcpServer['transport']
  readonly reason: SkippedServer['reason']
  readonly message: string
}

export interface McpCapabilitySnapshot {
  readonly projectContextId: string
  readonly workspace?: string
  readonly servers: readonly EffectiveMcpServer[]
  readonly blocked: readonly McpCapabilityDiagnostic[]
  readonly warnings: readonly string[]
  readonly contextBudgetRatio?: number
  readonly fingerprint: string
}

export interface ResolveMcpCapabilityOptions {
  workspace?: string
  selection?: readonly string[]
}

export function publishGlobalMcpSnapshot(snapshot: McpDomainSnapshot): void {
  currentGlobalSnapshot = snapshot
}

async function loadGlobalSnapshot(): Promise<McpDomainSnapshot | undefined> {
  const file = path.join(path.dirname(getPilotRoot()), 'config', 'mcp.json')
  try {
    const raw: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
    return toMcpDomainSnapshot(mcpReadSchema.parse(raw))
  } catch {
    return currentGlobalSnapshot
  }
}

function cloneServer(
  server: EffectiveMcpServer,
  runtimeWorkspace?: string,
): EffectiveMcpServer {
  const config = {
    ...server.config,
    args: server.config.args ? [...server.config.args] : undefined,
    env: server.config.env ? { ...server.config.env } : undefined,
    http_headers: server.config.http_headers ? { ...server.config.http_headers } : undefined,
    env_http_headers: server.config.env_http_headers
      ? { ...server.config.env_http_headers }
      : undefined,
    oauth: server.config.oauth ? { ...server.config.oauth } : undefined,
    scopes: server.config.scopes ? [...server.config.scopes] : undefined,
    enabled_tools: server.config.enabled_tools ? [...server.config.enabled_tools] : undefined,
    disabled_tools: server.config.disabled_tools ? [...server.config.disabled_tools] : undefined,
  }
  Object.freeze(config.args)
  Object.freeze(config.env)
  Object.freeze(config.http_headers)
  Object.freeze(config.env_http_headers)
  Object.freeze(config.oauth)
  Object.freeze(config.scopes)
  Object.freeze(config.enabled_tools)
  Object.freeze(config.disabled_tools)
  return Object.freeze({
    ...server,
    // Runtime launch context is the active Agent workspace even when the winning config is global.
    workspace: runtimeWorkspace,
    config: Object.freeze(config),
  })
}

function freezeCapability(input: {
  workspace?: string
  runtimeWorkspace?: string
  servers: readonly EffectiveMcpServer[]
  blocked?: readonly McpCapabilityDiagnostic[]
  warnings?: readonly string[]
  contextBudgetRatio?: number
}): McpCapabilitySnapshot {
  const servers = Object.freeze(input.servers.map((server) =>
    cloneServer(server, input.runtimeWorkspace ?? server.workspace)))
  const blocked = Object.freeze((input.blocked ?? []).map((item) => Object.freeze({ ...item })))
  const warnings = Object.freeze([...(input.warnings ?? [])])
  return Object.freeze({
    projectContextId: projectContextId(input.workspace),
    workspace: input.workspace,
    servers,
    blocked,
    warnings,
    contextBudgetRatio: input.contextBudgetRatio,
    fingerprint: stableFingerprint({
      projectContextId: projectContextId(input.workspace),
      servers: servers.map((server) => ({
        name: server.name,
        launch: launchFingerprint(server),
        // Exact prewarm adoption also fences projection and timeout semantics that do not
        // necessarily change the physical transport identity.
        capability: stableFingerprint({
          origin: server.origin,
          plugin: server.plugin,
          config: server.config,
        }),
      })),
      blocked,
      contextBudgetRatio: input.contextBudgetRatio,
    }),
  })
}

/** Resolves config/trust/plugin layers using local I/O only; this never opens an MCP connection. */
export async function resolveMcpCapability(
  options: ResolveMcpCapabilityOptions = {},
): Promise<McpCapabilitySnapshot> {
  const global = await loadGlobalSnapshot()
  const configRoot = path.dirname(getPilotRoot())
  const warnings: string[] = []
  const defaultWorkspace = await normalizeWorkspace(path.join(configRoot, 'workspace'))
  const runtimeWorkspace = options.workspace
    ? await normalizeWorkspace(options.workspace)
    : defaultWorkspace
  const projectActive = options.workspace
    ? await isProjectLayerActive(runtimeWorkspace, defaultWorkspace)
    : false
  const workspace = projectActive ? runtimeWorkspace : undefined
  const overlay = workspace
    ? await readProjectMcpOverlay(workspace)
    : { servers: {}, warnings: [] }
  warnings.push(...overlay.warnings)
  const plugins = await discoverPluginMcpContributions({ configRoot, workspace })
  warnings.push(...plugins.warnings)
  const effective = evaluateEffectiveServers({
    global: global?.mcpServers ?? {},
    globalPlugins: plugins.global,
    projectExplicit: overlay.servers,
    projectPlugins: plugins.project,
    workspace,
    trustTable: global?.trustedProjectServers ?? {},
    selection: options.selection,
  })
  const servers = await resolveMcpServerCredentialIdentities(configRoot, effective.servers)
  const blocked = effective.skipped.map((item) => ({
    server: item.name,
    origin: item.origin,
    transport: item.transport,
    reason: item.reason,
    message: item.message,
  }))
  warnings.push(...blocked.map((item) => item.message))
  return freezeCapability({
    workspace,
    runtimeWorkspace,
    servers,
    blocked,
    warnings,
    contextBudgetRatio: global?.contextBudgetRatio,
  })
}

/** Worker capability derivation: ordered subset only, with no disk/plugin/config rescan. */
export function narrowMcpCapability(
  parent: McpCapabilitySnapshot,
  selection?: readonly string[],
): McpCapabilitySnapshot {
  if (selection === undefined) return parent
  const selected = new Set(selection)
  return freezeCapability({
    workspace: parent.workspace,
    // With no override each selected server retains the Main capability's launch context.
    servers: parent.servers.filter((server) => selected.has(server.name)),
    blocked: parent.blocked.filter((diagnostic) => selected.has(diagnostic.server)),
    warnings: parent.warnings,
    contextBudgetRatio: parent.contextBudgetRatio,
  })
}

export function capabilityFromServers(input: {
  workspace?: string
  runtimeWorkspace?: string
  servers: readonly EffectiveMcpServer[]
  warnings?: readonly string[]
}): McpCapabilitySnapshot {
  return freezeCapability({
    ...input,
    runtimeWorkspace: input.runtimeWorkspace ?? input.workspace,
  })
}
