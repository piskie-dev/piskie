import type { McpServerConfig } from './mcp.js'
import type {
  PluginAdapterDescriptor,
  PluginCompatibility,
  PluginManifest,
  PluginMcpMember,
  PluginSkillMember,
} from './plugin.js'
import type { ProjectRecord } from './project.js'

export type MarketSourceKind =
  | 'git-skills'
  | 'mcp-registry'
  | 'openai-plugin-marketplace'
  | 'anthropic-plugin-marketplace'

export interface MarketSource {
  id: string
  name: string
  kind: MarketSourceKind
  url: string
  ref?: string
  builtin: boolean
  enabled: boolean
  lastRefreshedAt?: string
  revision?: string
  error?: string
}

export type MarketEntryKind = 'skill' | 'mcp' | 'plugin'

export type MarketCatalogSyncPhase =
  | 'started'
  | 'source-started'
  | 'source-ready'
  | 'source-failed'
  | 'completed'

/** 一次目录刷新中的来源级进度；不伪造百分比，只报告已结算来源数。 */
export interface MarketCatalogSyncProgress {
  phase: MarketCatalogSyncPhase
  completed: number
  total: number
  sourceId?: string
  sourceName?: string
  error?: string
}

/** 主进程能力状态变化的统一 renderer 投影；列表内容仍以刷新结果为准。 */
export interface MarketChangeEvent {
  kind: MarketEntryKind | 'catalog'
  type: string
  name?: string
  workspace?: string
  sync?: MarketCatalogSyncProgress
}

export interface MarketEntry {
  id: string
  kind: MarketEntryKind
  name: string
  description: string
  sourceId: string
  sourceName: string
  sourceUrl: string
  /** 管线可直接消费的缓存路径、git/url 或 registry 投影标识。 */
  installSource: string
  version?: string
  license?: string
  executable?: boolean
  maturity?: 'curated' | 'experimental' | 'community'
  installed?: boolean
  /** 至少一个已安装副本有可比较且更旧的版本。 */
  updateAvailable?: boolean
  /** 按 MCP/技能目录投影口径计算的上下文成本，不是会话 token 估算。 */
  projectedTokens?: number
  policy?: {
    installation: 'AVAILABLE' | 'INSTALLED_BY_DEFAULT'
    authentication?: 'ON_INSTALL' | 'ON_USE'
  }
  mcpConfig?: McpServerConfig
  pluginManifest?: PluginManifest
  pluginAdapter?: PluginAdapterDescriptor
  compatibility?: PluginCompatibility
  /** 宿主 adapter 的条目级提示；不冒充整个市场源故障。 */
  warnings?: string[]
  installable?: boolean
  installDisabledReason?: string
  members?: {
    skills: PluginSkillMember[]
    mcpServers: PluginMcpMember[]
  }
  /** 详情按需水合，列表缓存不携带大正文。 */
  content?: string
  files?: string[]
}

export interface MarketCatalogPage {
  entries: MarketEntry[]
  sources: MarketSource[]
  /** 启用来源中的完整目录条目数，不受当前查询与筛选影响。 */
  catalogCount: number
  total: number
  offset: number
  limit: number
  stale: boolean
  warnings: string[]
}

export type MarketInstalledScope = 'builtin' | 'user' | 'project'
export type MarketInstalledOrigin = 'builtin' | 'explicit' | 'plugin'

/** VS Code 式“已安装”视图使用的跨域管理投影。 */
export interface MarketInstalledItem {
  id: string
  kind: MarketEntryKind
  name: string
  description: string
  version?: string
  scope: MarketInstalledScope
  workspace?: string
  origin: MarketInstalledOrigin
  plugin?: string
  source?: string
  installedAt?: string
  enabled: boolean
  canToggle: boolean
  canRemove: boolean
  executionType?: 'knowledge' | 'executable'
  transport?: 'stdio' | 'streamable_http'
  endpoint?: string
  members?: {
    skills: PluginSkillMember[]
    mcpServers: PluginMcpMember[]
  }
  warnings?: string[]
  compatibility?: PluginCompatibility
  marketEntryId?: string
  availableVersion?: string
  updateAvailable: boolean
}

export interface MarketInstalledQuery {
  query?: string
  kinds?: MarketEntryKind[]
  scopes?: MarketInstalledScope[]
  /** 只看装在这个项目里的那一份 */
  workspace?: string
  updatesOnly?: boolean
  offset?: number
  limit?: number
}

export interface MarketInstalledPage {
  items: MarketInstalledItem[]
  /** 所有安装层记录数，不受当前查询与筛选影响。 */
  installedCount: number
  total: number
  offset: number
  limit: number
  updateCount: number
}

export type MarketManageAction = 'enable' | 'disable' | 'remove' | 'probe'

export interface MarketManageRequest {
  itemId: string
  action: MarketManageAction
  /** 指定后，MCP enable/disable/probe 按该 Project 的 overlay 语义执行。 */
  workspace?: string
  purge?: boolean
}

export interface MarketManageResult {
  itemId: string
  action: MarketManageAction
  protocolVersion?: string
  toolCount?: number
}

export interface MarketListQuery {
  query?: string
  kinds?: MarketEntryKind[]
  sourceIds?: string[]
  offset?: number
  limit?: number
  refreshIfStale?: boolean
}

export type MarketProjectOption = ProjectRecord

export interface MarketInstallRequest {
  entryId: string
  scope: 'user' | 'project'
  workspaces?: string[]
  force?: boolean
  allowExecutable?: boolean
}

export interface MarketInstallTargetResult {
  scope: 'user' | 'project'
  workspace?: string
  ok: boolean
  error?: string
  /** 安装已成功，但后置动作（例如 ON_INSTALL OAuth）未完成。 */
  warning?: string
}

export interface MarketInstallResult {
  entryId: string
  kind: MarketEntryKind
  name: string
  targets: MarketInstallTargetResult[]
}

export interface EffectiveCapabilityPreviewItem {
  id: string
  kind: 'skill' | 'mcp'
  name: string
  scope: 'builtin' | 'user' | 'project'
  origin: string
  enabled: boolean
  effective: boolean
  plugin?: string
  shadowedBy?: string
  reason?: string
}

export interface EffectiveCapabilityPreview {
  workspace?: string
  items: EffectiveCapabilityPreviewItem[]
}
