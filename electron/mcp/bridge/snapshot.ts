/**
 * 注入时刻的两步：① 四来源生效 server 集求值；② tools/list 快照（带缓存）。
 *
 * 同名整条覆盖优先级：项目显式 > 项目插件 > 全局显式 > 全局插件；
 * 项目级来源须已过信任门，未信任跳过并产出告警条目（不阻塞创建）。
 */

import { createHash } from 'node:crypto'

import type {
  EffectiveMcpServer,
  McpServerConfig,
  McpServerSnapshot,
  McpTrustRecord,
} from '@shared/types/mcp.js'
import { isTrusted } from '../config/trust.js'

export interface PluginMcpContribution {
  plugin: string
  version?: string
  servers: Record<string, McpServerConfig>
}

export interface EffectiveSetInput {
  /** 全局显式层（配置域 mcpServers） */
  global: Record<string, McpServerConfig>
  globalPlugins?: PluginMcpContribution[]
  /** 项目显式层（workspace overlay；项目层未激活时不传） */
  projectExplicit?: Record<string, McpServerConfig>
  projectPlugins?: PluginMcpContribution[]
  /** 项目级来源所属 workspace（realpath；有项目来源时必传） */
  workspace?: string
  /** 全局配置域 trusted_project_servers */
  trustTable: Readonly<Record<string, McpTrustRecord>>
  /** AgentRun/Spec 勾选列表；undefined = 不收窄 */
  selection?: readonly string[]
}

export interface SkippedServer {
  name: string
  origin: EffectiveMcpServer['origin']
  transport: EffectiveMcpServer['transport']
  reason: 'untrusted' | 'invalid'
  message: string
}

export interface EffectiveSetResult {
  servers: EffectiveMcpServer[]
  skipped: SkippedServer[]
}

function transportOf(config: McpServerConfig): EffectiveMcpServer['transport'] | null {
  if (config.command && !config.url) return 'stdio'
  if (config.url && !config.command) return 'streamable_http'
  return null
}

/** 四来源整条覆盖；不做 enabled/selection/trust 过滤，供管理面读取 winner。 */
export function mergeMcpServerLayers(input: EffectiveSetInput): EffectiveMcpServer[] {
  const merged = new Map<string, EffectiveMcpServer>()
  const put = (
    name: string,
    config: McpServerConfig,
    origin: EffectiveMcpServer['origin'],
    plugin?: string,
    pluginVersion?: string,
  ): void => {
    const transport = transportOf(config)
    if (!transport) return
    merged.set(name, {
      name,
      origin,
      transport,
      config,
      workspace: origin.startsWith('project') ? input.workspace : undefined,
      plugin,
      pluginVersion,
    })
  }

  // 低优先级先写，高优先级同名整条覆盖
  for (const contribution of input.globalPlugins ?? []) {
    for (const [name, config] of Object.entries(contribution.servers)) {
      put(name, config, 'global-plugin', contribution.plugin, contribution.version)
    }
  }
  for (const [name, config] of Object.entries(input.global)) {
    put(name, config, 'global-explicit')
  }
  for (const contribution of input.projectPlugins ?? []) {
    for (const [name, config] of Object.entries(contribution.servers)) {
      put(name, config, 'project-plugin', contribution.plugin, contribution.version)
    }
  }
  for (const [name, config] of Object.entries(input.projectExplicit ?? {})) {
    put(name, config, 'project-explicit')
  }

  return [...merged.values()]
}

/** 四来源合并 -> enabled 过滤 -> 勾选交集 -> 信任门。 */
export function evaluateEffectiveServers(input: EffectiveSetInput): EffectiveSetResult {
  const merged = mergeMcpServerLayers(input)

  const selection = input.selection ? new Set(input.selection) : null
  const selectionOrder = input.selection
    ? new Map(input.selection.map((name, index) => [name, index]))
    : null
  const servers: EffectiveMcpServer[] = []
  const skipped: SkippedServer[] = []

  for (const server of merged) {
    if (server.config.enabled === false) continue
    if (selection && !selection.has(server.name)) continue
    if (server.origin.startsWith('project')) {
      const workspace = server.workspace
      if (!workspace || !isTrusted(input.trustTable, workspace, server.name, server.config)) {
        skipped.push({
          name: server.name,
          origin: server.origin,
          transport: server.transport,
          reason: 'untrusted',
          message: `项目级 MCP server "${server.name}" 未过信任门，本次注入跳过`,
        })
        continue
      }
    }
    servers.push(server)
  }

  if (selectionOrder) {
    servers.sort((left, right) =>
      (selectionOrder.get(left.name) ?? Number.MAX_SAFE_INTEGER)
      - (selectionOrder.get(right.name) ?? Number.MAX_SAFE_INTEGER))
  }

  return { servers, skipped }
}

/** 配置内容指纹：配置一变缓存即失效（与信任键同一 canonical 序列化口径） */
export function configFingerprint(config: McpServerConfig): string {
  const canonicalize = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
    if (value && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
      return `{${entries.join(',')}}`
    }
    return JSON.stringify(value)
  }
  return createHash('sha256').update(canonicalize(config)).digest('hex')
}

/** 快照拉取器：由 client 层注入（stdio 懒启动/HTTP 直连都在拉取器内） */
export type McpSnapshotFetcher = (server: EffectiveMcpServer) => Promise<McpServerSnapshot>

export interface FetchServerSnapshotsOptions {
  /** App 可注入 Manager 的只读 safe catalog lookup；CLI 缺省每次 one-shot discovery。 */
  readCachedCatalog?: (server: EffectiveMcpServer) => McpServerSnapshot | undefined
  /** 仅在真实 discovery 成功时回调，不会因 cache hit 重写 Manager cache。 */
  onCatalogDiscovered?: (server: EffectiveMcpServer, snapshot: McpServerSnapshot) => void
}

/** 逐个 server 取快照；App 可读 Manager cache，拉取失败时该 server 缺席。 */
export async function fetchServerSnapshots(
  servers: readonly EffectiveMcpServer[],
  fetcher: McpSnapshotFetcher,
  options: FetchServerSnapshotsOptions = {},
): Promise<{
  snapshots: Map<string, McpServerSnapshot>
  failures: Array<{ server: EffectiveMcpServer; error: string }>
}> {
  const snapshots = new Map<string, McpServerSnapshot>()
  const failures: Array<{ server: EffectiveMcpServer; error: string }> = []

  await Promise.all(servers.map(async (server) => {
    const cached = options.readCachedCatalog?.(server)
    if (cached) {
      snapshots.set(server.name, cached)
      return
    }
    try {
      const snapshot = await fetcher(server)
      options.onCatalogDiscovered?.(server, snapshot)
      snapshots.set(server.name, snapshot)
    } catch (error) {
      failures.push({ server, error: error instanceof Error ? error.message : String(error) })
    }
  }))

  return { snapshots, failures }
}
