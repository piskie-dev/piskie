import { promises as fs } from 'node:fs'
import path from 'node:path'

import type {
  EffectiveCapabilityPreview,
  EffectiveCapabilityPreviewItem,
  MarketCatalogSyncProgress,
  MarketCatalogPage,
  MarketEntry,
  MarketInstalledItem,
  MarketInstalledPage,
  MarketInstalledQuery,
  MarketInstallRequest,
  MarketInstallResult,
  MarketListQuery,
  MarketManageRequest,
  MarketManageResult,
  MarketProjectOption,
  MarketSource,
  MarketSourceKind,
} from '@shared/types/market.js'
import type { EffectiveMcpServer, McpServerConfig, McpServerInfo } from '@shared/types/mcp.js'
import { isVersionNewer } from '@shared/utils/version.js'

import type { McpPort } from '../mcp/ports.js'
import { sanitizeMcpErrorText } from '../mcp/security/sanitize.js'
import {
  addPluginMarketplaceSource,
  removePluginMarketplaceSource,
} from '../plugins/marketplace.js'
import { adaptHostPluginDirectory } from '../plugins/host-adapter.js'
import {
  pluginPackageSourceLabel,
  resolvePluginPackageSource,
  type ResolvedPluginPackage,
} from '../plugins/adapter-source.js'
import type { PluginsPort } from '../plugins/ports.js'
import type { SkillsPort } from '../skills/ports.js'
import { parseSkillManifest } from '../skills/manifest/parse.js'
import {
  addCustomMarketSource,
  listMarketSources,
  loadMarketCatalog,
  refreshMarketCatalog,
  removeCustomMarketSource,
} from './catalog.js'

const DEFAULT_PAGE_SIZE = 60
const MAX_PAGE_SIZE = 200

export interface MarketPortOptions {
  configRoot: string
  skills: SkillsPort
  mcp: McpPort
  plugins: PluginsPort
  listProjects?(): Promise<MarketProjectOption[]> | MarketProjectOption[]
}

export interface MarketPort {
  list(query?: MarketListQuery): Promise<MarketCatalogPage>
  installed(query?: MarketInstalledQuery): Promise<MarketInstalledPage>
  refresh(
    sourceIds?: string[],
    onProgress?: (progress: MarketCatalogSyncProgress) => void,
  ): Promise<{ sources: MarketSource[]; warnings: string[] }>
  detail(entryId: string): Promise<MarketEntry>
  install(request: MarketInstallRequest): Promise<MarketInstallResult>
  manage(request: MarketManageRequest): Promise<MarketManageResult>
  sources(): Promise<MarketSource[]>
  addSource(input: { name: string; kind: MarketSourceKind; url: string; ref?: string }): Promise<MarketSource>
  removeSource(id: string): Promise<void>
  projects(): Promise<MarketProjectOption[]>
  preview(workspace?: string): Promise<EffectiveCapabilityPreview>
}

interface InstalledRecord {
  item: MarketInstalledItem
  mcpConfig?: McpServerConfig
}

function installedItemId(
  kind: MarketInstalledItem['kind'],
  scope: MarketInstalledItem['scope'],
  origin: MarketInstalledItem['origin'],
  name: string,
  workspace?: string,
  plugin?: string,
): string {
  return [kind, scope, origin, workspace ?? '', plugin ?? '', name]
    .map((part) => encodeURIComponent(part))
    .join(':')
}

function latestMarketEntries(entries: readonly MarketEntry[]): Map<string, MarketEntry> {
  const result = new Map<string, MarketEntry>()
  for (const entry of entries) {
    const key = `${entry.kind}:${entry.name}`
    const current = result.get(key)
    if (!current || (entry.version && (!current.version || isVersionNewer(entry.version, current.version)))) {
      result.set(key, entry)
    }
  }
  return result
}

function projectInstalledItem(
  item: Omit<MarketInstalledItem, 'marketEntryId' | 'availableVersion' | 'updateAvailable'>,
  available: Map<string, MarketEntry>,
  identityMatch?: MarketEntry,
): MarketInstalledItem {
  // 同名不代表同一个能力：内置项与插件成员不按名字认领市场条目，
  // 否则撞名的市场条目会互相冒认（MCP 的配置身份匹配不受此限，配置一致才算同一个）。
  const independentlyManaged = item.scope !== 'builtin' && item.origin !== 'plugin'
  const marketEntry = (independentlyManaged ? available.get(`${item.kind}:${item.name}`) : undefined)
    ?? identityMatch
  return {
    ...item,
    description: item.description || marketEntry?.description || '',
    marketEntryId: marketEntry?.id,
    availableVersion: marketEntry?.version,
    updateAvailable: independentlyManaged && isVersionNewer(marketEntry?.version, item.version),
  }
}

function endpointText(config: McpServerConfig): string {
  return config.url ?? [config.command, ...(config.args ?? [])].filter(Boolean).join(' ')
}

function mcpInstalledVersion(config: McpServerConfig): string | undefined {
  for (const argument of config.args ?? []) {
    const match = argument.match(/@([^@/]+)$/)
    if (match) return match[1]
  }
  return undefined
}

function stripPackageVersion(value: string): string {
  const separator = value.lastIndexOf('@')
  return separator > 0 ? value.slice(0, separator) : value
}

function mcpConfigIdentity(config: McpServerConfig): string | undefined {
  if (config.url) return `url:${config.url}`
  if (!config.command) return undefined
  const args = [...(config.args ?? [])]
  const command = path.basename(config.command).toLowerCase()
  let packageIndex = -1
  if (command === 'npx' || command === 'uvx') {
    packageIndex = args.findIndex((argument) => !argument.startsWith('-'))
  } else if (command === 'docker' && args[0] === 'run') {
    packageIndex = args.findIndex((argument, index) => index > 0 && !argument.startsWith('-'))
  }
  if (packageIndex >= 0) args[packageIndex] = stripPackageVersion(args[packageIndex])
  return `stdio:${command}:${JSON.stringify(args)}`
}

function latestMcpEntriesByIdentity(entries: readonly MarketEntry[]): Map<string, MarketEntry> {
  const result = new Map<string, MarketEntry>()
  for (const entry of entries) {
    if (entry.kind !== 'mcp' || !entry.mcpConfig) continue
    const identity = mcpConfigIdentity(entry.mcpConfig)
    if (!identity) continue
    const current = result.get(identity)
    if (!current || (entry.version && (!current.version || isVersionNewer(entry.version, current.version)))) {
      result.set(identity, entry)
    }
  }
  return result
}

function mcpLayerPriority(server: McpServerInfo): number {
  if (server.scope === 'project') return server.origin === 'explicit' ? 4 : 3
  return server.origin === 'explicit' ? 2 : 1
}

function canonicalizeMcpConfig(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalizeMcpConfig).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key, entry]) => key !== 'enabled' && entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalizeMcpConfig(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function isPureProjectDisableOverride(
  server: McpServerInfo,
  lowerLayer: McpServerInfo | undefined,
): boolean {
  return server.scope === 'project'
    && server.origin === 'explicit'
    && server.enabled === false
    && lowerLayer !== undefined
    && canonicalizeMcpConfig(server.config) === canonicalizeMcpConfig(lowerLayer.config)
}


export function createMarketPort(options: MarketPortOptions): MarketPort {
  async function projects(): Promise<MarketProjectOption[]> {
    const items = await options.listProjects?.() ?? []
    return [...items]
  }

  async function catalog(query: MarketListQuery = {}): Promise<MarketCatalogPage> {
    let loaded = await loadMarketCatalog(options.configRoot)
    if (query.refreshIfStale && loaded.stale) {
      const refreshed = await refreshMarketCatalog(options.configRoot, query.sourceIds)
      loaded = await loadMarketCatalog(options.configRoot)
      loaded.warnings.push(...refreshed.warnings)
    }

    const installed = await installedInventory()
    const terms = (query.query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
    let entries = loaded.entries
      .filter((entry) => !query.kinds || query.kinds.includes(entry.kind))
      .filter((entry) => !query.sourceIds || query.sourceIds.includes(entry.sourceId))
      .map((entry) => projectInstalledState(entry, installed))
    if (terms.length > 0) {
      entries = entries
        .map((entry) => ({ entry, score: marketScore(entry, terms) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
        .map((item) => item.entry)
    } else {
      entries.sort((a, b) => Number(Boolean(b.installed)) - Number(Boolean(a.installed)) || a.name.localeCompare(b.name))
    }
    const total = entries.length
    const offset = Math.max(0, query.offset ?? 0)
    const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, query.limit ?? DEFAULT_PAGE_SIZE))
    return {
      entries: entries.slice(offset, offset + limit),
      sources: loaded.sources,
      catalogCount: loaded.entries.length,
      total,
      offset,
      limit,
      stale: loaded.stale,
      warnings: loaded.warnings,
    }
  }

  async function installedInventory(): Promise<Map<string, Set<string>>> {
    const projectOptions = (await projects()).filter((project) => project.available !== false)
    const workspaces = projectOptions.map((project) => project.workspace)
    const [skills, plugins, userMcp, ...projectMcp] = await Promise.all([
      options.skills.list({ scope: 'all', workspaces }),
      options.plugins.list({ scope: 'all', workspaces }),
      options.mcp.list({ scope: 'user' }),
      ...workspaces.map((workspace) => options.mcp.list({ scope: 'project', workspace })),
    ])
    const result = new Map<string, Set<string>>()
    const add = (key: string, version?: string): void => {
      const versions = result.get(key) ?? new Set<string>()
      if (version) versions.add(version)
      result.set(key, versions)
    }
    for (const item of skills) {
      // 内置项与插件成员不是市场条目的副本；同名的市场条目仍视为未安装
      if (item.scope === 'builtin' || item.plugin) continue
      add(`skill:${item.name}`, item.version)
    }
    for (const item of plugins) add(`plugin:${item.name}`, item.version)
    for (const item of [...userMcp, ...projectMcp.flat()]) {
      const version = item.origin === 'explicit' ? mcpInstalledVersion(item.config) : undefined
      if (item.origin === 'explicit') add(`mcp:${item.name}`, version)
      const identity = mcpConfigIdentity(item.config)
      if (identity) add(`mcp-identity:${identity}`, version)
    }
    return result
  }

  async function installedRecords(marketEntries: readonly MarketEntry[]): Promise<InstalledRecord[]> {
    const projectOptions = (await projects()).filter((project) => project.available !== false)
    const [builtinSkills, userSkills, userPlugins, userMcp, projectLayers] = await Promise.all([
      options.skills.list({ scope: 'builtin' }),
      options.skills.list({ scope: 'user' }),
      options.plugins.list({ scope: 'user' }),
      options.mcp.list({ scope: 'user' }),
      Promise.all(projectOptions.map(async ({ workspace }) => {
        const [skills, plugins, mcp] = await Promise.all([
          options.skills.list({ scope: 'project', workspaces: [workspace] }),
          options.plugins.list({ scope: 'project', workspaces: [workspace] }),
          options.mcp.list({ scope: 'project', workspace }),
        ])
        return { workspace, skills, plugins, mcp }
      })),
    ])
    const available = latestMarketEntries(marketEntries)
    const mcpByIdentity = latestMcpEntriesByIdentity(marketEntries)
    const records: InstalledRecord[] = []

    const addSkill = (
      skill: (typeof builtinSkills)[number],
      scope: 'builtin' | 'user' | 'project',
      workspace?: string,
    ) => {
      const origin = scope === 'builtin' ? 'builtin' : skill.plugin ? 'plugin' : 'explicit'
      records.push({
        item: projectInstalledItem({
          id: installedItemId('skill', scope, origin, skill.name, workspace, skill.plugin),
          kind: 'skill',
          name: skill.name,
          description: skill.description,
          version: skill.version,
          scope,
          workspace,
          origin,
          plugin: skill.plugin,
          source: skill.source ?? skill.path,
          installedAt: skill.installedAt,
          enabled: skill.enabled,
          canToggle: scope === 'user' && origin === 'explicit',
          canRemove: scope !== 'builtin' && origin === 'explicit',
          executionType: skill.executionType,
        }, available),
      })
    }
    for (const skill of builtinSkills) addSkill(skill, 'builtin')
    for (const skill of userSkills) addSkill(skill, 'user')

    const addPlugin = (
      plugin: (typeof userPlugins)[number],
      scope: 'user' | 'project',
      workspace?: string,
    ) => {
      records.push({
        item: projectInstalledItem({
          id: installedItemId('plugin', scope, 'explicit', plugin.name, workspace),
          kind: 'plugin',
          name: plugin.name,
          description: plugin.description ?? '',
          version: plugin.version,
          scope,
          workspace,
          origin: 'explicit',
          source: plugin.source,
          installedAt: plugin.installedAt,
          enabled: true,
          canToggle: false,
          canRemove: true,
          members: plugin.members,
          warnings: plugin.warnings,
          compatibility: plugin.compatibility,
        }, available),
      })
    }
    for (const plugin of userPlugins) addPlugin(plugin, 'user')

    const addMcp = (
      server: (typeof userMcp)[number],
      scope: 'user' | 'project',
      workspace?: string,
    ) => {
      const origin = server.origin === 'plugin' ? 'plugin' : 'explicit'
      records.push({
        item: projectInstalledItem({
          id: installedItemId('mcp', scope, origin, server.name, workspace, server.plugin),
          kind: 'mcp',
          name: server.name,
          description: '',
          version: mcpInstalledVersion(server.config),
          scope,
          workspace,
          origin,
          plugin: server.plugin,
          source: endpointText(server.config),
          enabled: server.enabled,
          canToggle: origin === 'explicit',
          canRemove: origin === 'explicit',
          transport: server.transport,
          endpoint: endpointText(server.config),
        }, available, mcpByIdentity.get(mcpConfigIdentity(server.config) ?? '')),
        mcpConfig: server.config,
      })
    }
    for (const server of userMcp) addMcp(server, 'user')
    for (const layer of projectLayers) {
      for (const skill of layer.skills) addSkill(skill, 'project', layer.workspace)
      for (const plugin of layer.plugins) addPlugin(plugin, 'project', layer.workspace)
      for (const server of layer.mcp) addMcp(server, 'project', layer.workspace)
    }

    return records.sort((left, right) => (
      Number(right.item.updateAvailable) - Number(left.item.updateAvailable)
      || left.item.name.localeCompare(right.item.name)
      || left.item.kind.localeCompare(right.item.kind)
      || left.item.scope.localeCompare(right.item.scope)
      || (left.item.workspace ?? '').localeCompare(right.item.workspace ?? '')
    ))
  }

  function projectInstalledState(
    entry: MarketEntry,
    inventory: Map<string, Set<string>>,
  ): MarketEntry {
    const identity = entry.kind === 'mcp' && entry.mcpConfig
      ? mcpConfigIdentity(entry.mcpConfig)
      : undefined
    const versions = inventory.get(`${entry.kind}:${entry.name}`)
      ?? (identity ? inventory.get(`mcp-identity:${identity}`) : undefined)
    return {
      ...entry,
      installed: versions !== undefined,
      updateAvailable: versions !== undefined
        && [...versions].some((installed) => isVersionNewer(entry.version, installed)),
    }
  }

  async function capabilityPreview(workspace?: string): Promise<EffectiveCapabilityPreview> {
    const [builtin, user, project, mcpLayers, effectiveMcp] = await Promise.all([
      options.skills.list({ scope: 'builtin' }),
      options.skills.list({ scope: 'user' }),
      workspace ? options.skills.list({ scope: 'project', workspaces: [workspace] }) : Promise.resolve([]),
      options.mcp.list({ scope: workspace ? 'all' : 'user', workspace }),
      options.mcp.effective(workspace),
    ])
    const items: EffectiveCapabilityPreviewItem[] = []
    const skillWinner = new Map<string, { scope: 'builtin' | 'user' | 'project'; origin: string }>()
    for (const skill of builtin) skillWinner.set(skill.name, { scope: 'builtin', origin: 'builtin' })
    for (const skill of user) skillWinner.set(skill.name, {
      scope: 'user',
      origin: skill.plugin ? `plugin:${skill.plugin}` : 'explicit',
    })
    for (const skill of project) skillWinner.set(skill.name, {
      scope: 'project',
      origin: skill.plugin ? `plugin:${skill.plugin}` : 'explicit',
    })
    for (const skill of [...builtin, ...user, ...project]) {
      const origin = skill.plugin ? `plugin:${skill.plugin}` : skill.scope === 'builtin' ? 'builtin' : 'explicit'
      const winner = skillWinner.get(skill.name)!
      const effective = winner.scope === skill.scope && winner.origin === origin
      items.push({
        id: `skill:${skill.scope}:${origin}:${skill.name}`,
        kind: 'skill',
        name: skill.name,
        scope: skill.scope,
        origin,
        enabled: skill.enabled,
        effective: effective && skill.enabled,
        plugin: skill.plugin,
        shadowedBy: effective ? undefined : `${winner.scope}:${winner.origin}`,
      })
    }

    const effectiveByName = new Map(effectiveMcp.servers.map((server) => [server.name, server]))
    const winnerByName = new Map<string, (typeof mcpLayers)[number]>()
    for (const server of mcpLayers) {
      const current = winnerByName.get(server.name)
      if (!current || mcpLayerPriority(server) >= mcpLayerPriority(current)) winnerByName.set(server.name, server)
    }
    for (const server of mcpLayers) {
      const layerWinner = winnerByName.get(server.name)
      const effectiveWinner = effectiveByName.get(server.name)
      const expectedOrigin = `${server.scope === 'project' ? 'project' : 'global'}-${server.origin}`
      const winsLayer = layerWinner === server
      const effective = winsLayer
        && effectiveWinner?.origin === expectedOrigin
        && effectiveWinner.plugin === server.plugin
      const winnerOrigin = layerWinner
        ? `${layerWinner.scope}:${layerWinner.origin}${layerWinner.plugin ? `:${layerWinner.plugin}` : ''}`
        : undefined
      items.push({
        id: `mcp:${server.scope}:${server.origin}:${server.plugin ?? ''}:${server.name}`,
        kind: 'mcp',
        name: server.name,
        scope: server.scope,
        origin: server.origin,
        enabled: server.enabled,
        effective,
        plugin: server.plugin,
        shadowedBy: winsLayer ? undefined : winnerOrigin,
        reason: !server.enabled
          ? 'disabled'
          : !winsLayer && layerWinner?.enabled === false
            ? 'shadowed-by-disabled-override'
            : undefined,
      })
    }
    for (const skipped of effectiveMcp.skipped) {
      const existing = items.find((item) => (
        item.kind === 'mcp' && item.name === skipped.name && item.shadowedBy === undefined
      ))
      if (existing) existing.reason = skipped.reason
    }
    return { workspace, items }
  }

  async function setProjectMcpEnabled(
    item: MarketInstalledItem,
    workspace: string,
    enabled: boolean,
  ): Promise<void> {
    const layers = await options.mcp.list({ scope: 'all', workspace })
    const target = layers.find((server) => (
      server.name === item.name
      && server.scope === (item.scope === 'project' ? 'project' : 'user')
      && server.origin === item.origin
      && server.plugin === item.plugin
    ))
    if (!target) throw new Error(`${item.name} 在该 Project 中不可见，或安装层已经变化`)
    const sameName = layers.filter((server) => server.name === item.name)
    const winner = [...sameName].sort((left, right) => mcpLayerPriority(right) - mcpLayerPriority(left))[0]
    if (winner !== target) throw new Error(`${item.name} 当前层已被更高优先级的 Project 配置覆盖`)

    const lowerLayer = [...sameName]
      .filter((server) => mcpLayerPriority(server) < mcpLayerPriority(winner))
      .sort((left, right) => mcpLayerPriority(right) - mcpLayerPriority(left))[0]
    if (enabled && isPureProjectDisableOverride(winner, lowerLayer)) {
      await options.mcp.remove(item.name, { scope: 'project', workspace })
      return
    }
    await options.mcp.add({
      name: item.name,
      scope: 'project',
      workspace,
      config: { ...winner.config, enabled },
      force: true,
    })
  }

  return {
    list: catalog,

    async installed(query = {}) {
      const loaded = await loadMarketCatalog(options.configRoot)
      const records = await installedRecords(loaded.entries)
      const updateCount = records.filter(({ item }) => item.updateAvailable).length
      const terms = (query.query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
      let items = records
        .map(({ item }) => item)
        .filter((item) => !query.kinds || query.kinds.includes(item.kind))
        .filter((item) => !query.scopes || query.scopes.includes(item.scope))
        .filter((item) => !query.workspace || item.scope !== 'project' || item.workspace === query.workspace)
        .filter((item) => !query.updatesOnly || item.updateAvailable)
      if (terms.length > 0) {
        items = items.filter((item) => {
          const haystack = [
            item.name,
            item.description,
            item.plugin,
            item.source,
            item.endpoint,
            item.workspace,
          ].filter(Boolean).join(' ').toLowerCase()
          return terms.every((term) => haystack.includes(term))
        })
      }
      const total = items.length
      const offset = Math.max(0, query.offset ?? 0)
      const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, query.limit ?? DEFAULT_PAGE_SIZE))
      return {
        items: items.slice(offset, offset + limit),
        installedCount: records.length,
        total,
        offset,
        limit,
        updateCount,
      }
    },

    refresh: (sourceIds, onProgress) => refreshMarketCatalog(
      options.configRoot,
      sourceIds,
      { onProgress },
    ),

    async detail(entryId) {
      const loaded = await loadMarketCatalog(options.configRoot)
      const entry = loaded.entries.find((item) => item.id === entryId)
      if (!entry) throw new Error(`市场条目不存在：${entryId}`)
      const detail = projectInstalledState(entry, await installedInventory())
      if (entry.kind === 'skill') {
        try {
          const parsed = parseSkillManifest(await fs.readFile(path.join(entry.installSource, 'SKILL.md'), 'utf8'))
          detail.content = parsed.body
          detail.files = await listDetailFiles(entry.installSource)
        } catch {
          // Remote cache may have been cleared between list and detail; metadata remains usable.
        }
      }
      return detail
    },

    async install(request) {
      const entry = await this.detail(request.entryId)
      if (request.scope === 'project' && entry.executable) {
        throw new Error('可执行技能或含可执行成员的插件不能安装到项目级')
      }
      if (entry.executable && !request.allowExecutable) {
        throw new Error('条目包含可执行代码；确认风险后再安装')
      }
      if (entry.kind === 'plugin' && entry.installable === false) {
        throw new Error(entry.installDisabledReason ?? '该宿主插件没有 Piskie 可安装的成员')
      }
      const requestedWorkspaces = [...new Set(request.workspaces ?? [])]
      if (request.scope === 'project') {
        const availableWorkspaces = new Set(
          (await projects())
            .filter((project) => project.available !== false)
            .map((project) => project.workspace),
        )
        const unavailable = requestedWorkspaces.find((workspace) => !availableWorkspaces.has(workspace))
        if (unavailable) throw new Error(`Project 不存在或目录不可用：${unavailable}`)
      }
      const targets = request.scope === 'user'
        ? [{ scope: 'user' as const, workspace: undefined }]
        : requestedWorkspaces.map((workspace) => ({
            scope: 'project' as const,
            workspace,
          }))
      if (targets.length === 0) throw new Error('项目级安装至少选择一个 workspace')

      let resolvedPackage: ResolvedPluginPackage | undefined
      let adaptedPackage: Awaited<ReturnType<typeof adaptHostPluginDirectory>> | undefined
      if (entry.kind === 'plugin') {
        if (!entry.pluginAdapter || entry.pluginAdapter.format === 'agent-plugins') {
          throw new Error('市场插件必须声明 OpenAI 或 Anthropic adapter；不提供格式探测降级')
        }
        resolvedPackage = await resolvePluginPackageSource(entry.pluginAdapter.source)
        try {
          adaptedPackage = await adaptHostPluginDirectory({
            format: entry.pluginAdapter.format,
            directory: resolvedPackage.directory,
            marketplaceEntry: entry.pluginAdapter.marketplaceEntry,
          })
        } catch (error) {
          await resolvedPackage.cleanup()
          throw error
        }
      }

      const results = []
      try {
        for (const target of targets) {
          try {
            let installWarning: string | undefined
            if (entry.kind === 'skill') {
              await options.skills.install({
                source: entry.installSource,
                scope: target.scope,
                workspace: target.workspace,
                force: request.force,
                allowExecutable: request.allowExecutable,
                sourceIsRemote: true,
              })
            } else if (entry.kind === 'plugin') {
              if (!adaptedPackage || !entry.pluginAdapter) throw new Error('插件 adapter 尚未准备完成')
              const installedPlugin = await options.plugins.install({
                source: adaptedPackage.directory,
                sourceLabel: pluginPackageSourceLabel(entry.pluginAdapter.source),
                scope: target.scope,
                workspace: target.workspace,
                force: request.force,
                allowExecutable: request.allowExecutable,
                sourceIsRemote: true,
              }, {
                loginMcp: entry.policy?.authentication === 'ON_INSTALL',
              })
              const onboardingWarnings = [...new Set([
                ...adaptedPackage.warnings,
                ...(installedPlugin.warnings ?? []),
              ])]
              if (onboardingWarnings.length > 0) {
                installWarning = `插件已安装；兼容性/onboarding 提示：${onboardingWarnings.join('; ')}`
              }
            } else {
              if (!entry.mcpConfig) throw new Error('Registry 条目没有可安装的传输配置')
              const identity = mcpConfigIdentity(entry.mcpConfig)
              const existing = (await options.mcp.list({
                scope: target.scope,
                workspace: target.workspace,
              })).find((server) => (
                server.origin === 'explicit'
                && (server.name === entry.name
                  || (identity !== undefined && mcpConfigIdentity(server.config) === identity))
              ))
              const serverName = existing?.name ?? entry.name
              await options.mcp.add({
                name: serverName,
                scope: target.scope,
                workspace: target.workspace,
                config: entry.mcpConfig,
                force: request.force,
              })
              const onboarding = await options.mcp.onboard(serverName, {
                workspace: target.workspace,
                login: true,
              })
              if (onboarding.warnings.length > 0) {
                installWarning = `MCP 已安装；onboarding 提示：${onboarding.warnings.join('; ')}`
              }
            }
            results.push({
              scope: target.scope,
              workspace: target.workspace,
              ok: true,
              warning: installWarning,
            })
          } catch (error) {
            const server: EffectiveMcpServer | undefined = entry.kind === 'mcp' && entry.mcpConfig
              ? {
                  name: entry.name,
                  origin: target.scope === 'project' ? 'project-explicit' : 'global-explicit',
                  transport: entry.mcpConfig.command ? 'stdio' : 'streamable_http',
                  config: entry.mcpConfig,
                  workspace: target.workspace,
                }
              : undefined
            results.push({
              scope: target.scope,
              workspace: target.workspace,
              ok: false,
              error: sanitizeMcpErrorText(error, { server, maxLength: 4_096 }),
            })
          }
        }
      } finally {
        await adaptedPackage?.cleanup()
        await resolvedPackage?.cleanup()
      }
      return { entryId: entry.id, kind: entry.kind, name: entry.name, targets: results }
    },

    async manage(request) {
      const loaded = await loadMarketCatalog(options.configRoot)
      const record = (await installedRecords(loaded.entries))
        .find(({ item }) => item.id === request.itemId)
      if (!record) throw new Error(`已安装能力不存在：${request.itemId}`)
      const { item } = record

      if (request.action === 'probe') {
        if (item.kind !== 'mcp') throw new Error('只有 MCP server 支持连接测试')
        const snapshot = await options.mcp.probe(item.name, {
          workspace: request.workspace ?? item.workspace,
        })
        return {
          itemId: item.id,
          action: request.action,
          protocolVersion: snapshot.protocolVersion,
          toolCount: snapshot.tools.length,
        }
      }

      if (request.action === 'enable' || request.action === 'disable') {
        const enabled = request.action === 'enable'
        if (request.workspace) {
          if (item.kind !== 'mcp') {
            throw new Error(`${item.kind === 'plugin' ? 'Plugin' : 'Skill'} 不提供 Project 级运行开关`)
          }
          await setProjectMcpEnabled(item, request.workspace, enabled)
        } else if (!item.canToggle) {
          throw new Error(`${item.name} 不能在市场中单独启停`)
        } else if (item.kind === 'skill') {
          if (enabled) await options.skills.enable(item.name)
          else await options.skills.disable(item.name)
        } else if (item.kind === 'mcp' && record.mcpConfig) {
          await options.mcp.add({
            name: item.name,
            scope: item.scope === 'project' ? 'project' : 'user',
            workspace: item.workspace,
            config: { ...record.mcpConfig, enabled },
            force: true,
          })
        } else {
          throw new Error(`${item.name} 不支持启停`)
        }
        return { itemId: item.id, action: request.action }
      }

      if (request.workspace && item.scope !== 'project') {
        throw new Error(`Project 视角不能卸载继承的全局能力；请切换到全局视角管理 ${item.name}`)
      }
      if (request.workspace && item.workspace !== request.workspace) {
        throw new Error(`${item.name} 不属于当前 Project`)
      }
      if (!item.canRemove) throw new Error(`${item.name} 由 ${item.plugin ? `插件 ${item.plugin}` : '系统'} 管理，不能单独卸载`)
      if (item.kind === 'skill') {
        await options.skills.remove(item.name, {
          scope: item.scope === 'project' ? 'project' : 'user',
          workspace: item.workspace,
        })
      } else if (item.kind === 'mcp') {
        await options.mcp.remove(item.name, {
          scope: item.scope === 'project' ? 'project' : 'user',
          workspace: item.workspace,
        })
      } else {
        await options.plugins.remove(item.name, {
          scope: item.scope === 'project' ? 'project' : 'user',
          workspace: item.workspace,
          purge: request.purge,
        })
      }
      return { itemId: item.id, action: request.action }
    },

    sources: () => listMarketSources(options.configRoot),

    async addSource(input) {
      if (input.kind === 'openai-plugin-marketplace' || input.kind === 'anthropic-plugin-marketplace') {
        const format = input.kind === 'openai-plugin-marketplace' ? 'openai' : 'anthropic'
        const record = await addPluginMarketplaceSource(options.configRoot, format, input.url, input.ref)
        return {
          id: `plugin-marketplace:${record.format}:${record.name}`,
          name: record.name,
          kind: input.kind,
          url: record.url,
          ref: record.ref,
          builtin: false,
          enabled: true,
        }
      }
      return addCustomMarketSource(options.configRoot, {
        name: input.name,
        kind: input.kind,
        url: input.url,
        ref: input.ref,
      })
    },

    async removeSource(id) {
      if (id.startsWith('plugin-marketplace:')) {
        const source = (await listMarketSources(options.configRoot)).find((item) => item.id === id)
        if (!source) throw new Error(`插件市场来源不存在：${id}`)
        await removePluginMarketplaceSource(options.configRoot, source.name)
      } else {
        await removeCustomMarketSource(options.configRoot, id)
      }
    },

    projects,
    preview: capabilityPreview,
  }
}

async function listDetailFiles(directory: string, depth = 3, prefix = ''): Promise<string[]> {
  if (depth <= 0) return []
  let entries
  try {
    entries = await fs.readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...await listDetailFiles(path.join(directory, entry.name), depth - 1, relative))
    else if (entry.isFile()) files.push(relative)
    if (files.length >= 200) break
  }
  return files.slice(0, 200)
}

function marketScore(entry: MarketEntry, terms: string[]): number {
  const name = entry.name.toLowerCase()
  const description = entry.description.toLowerCase()
  const source = entry.sourceName.toLowerCase()
  let score = 0
  let matched = 0
  for (const term of terms) {
    if (name === term) {
      score += 100
      matched += 1
    } else if (name.includes(term)) {
      score += 60
      matched += 1
    } else if (description.includes(term)) {
      score += 25
      matched += 1
    } else if (source.includes(term)) {
      score += 10
      matched += 1
    }
  }
  return matched === terms.length ? score + 20 : matched > 0 ? score : 0
}
