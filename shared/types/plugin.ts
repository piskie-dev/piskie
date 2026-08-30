/** Agent Plugins 1.0.0 manifest 的解析投影（plugin.json 十字段白名单） */
export interface PluginAuthor {
  name?: string
  email?: string
  url?: string
}

export interface PluginManifest {
  $schema: string
  name: string
  version?: string
  description?: string
  author?: PluginAuthor
  homepage?: string
  repository?: string
  license?: string
  keywords?: string[]
  /** 反域名命名空间的客户端私有扩展；非 com.piskie 的在解析时已被过滤 */
  extensions?: Record<string, unknown>
}

export interface PluginManifestIssue {
  code:
    | 'SCHEMA_MISSING'
    | 'SCHEMA_NOT_AGENT_PLUGINS'
    | 'SCHEMA_UNSUPPORTED'
    | 'NAME_MISSING'
    | 'NAME_INVALID'
    | 'MANIFEST_INVALID'
  message: string
}

export interface PluginManifestParseOk {
  ok: true
  manifest: PluginManifest
  warnings: string[]
}

export interface PluginManifestParseFail {
  ok: false
  issues: PluginManifestIssue[]
  warnings: string[]
}

export type PluginManifestParseResult = PluginManifestParseOk | PluginManifestParseFail

export type PluginScope = 'user' | 'project'

export interface PluginSkillMember {
  name: string
  executionType: 'knowledge' | 'executable'
  type?: string
}

export interface PluginMcpMember {
  name: string
  transport: 'stdio' | 'streamable_http'
  command?: string
  args?: string[]
  url?: string
}

/** 安装盘上只保留 agent-plugins；另外两种值只存在于市场读取和安装前适配阶段。 */
export type PluginPackageFormat = 'agent-plugins' | 'openai' | 'anthropic'
export type PluginMarketplaceFormat = Exclude<PluginPackageFormat, 'agent-plugins'>

export type PluginHostCapability =
  | 'skills'
  | 'mcp'
  | 'mcp-auth'
  | 'apps'
  | 'hooks'
  | 'commands'
  | 'agents'
  | 'lsp'
  | 'monitors'
  | 'interface'
  | 'output-styles'
  | 'workflows'
  | 'themes'
  | 'channels'

export interface PluginCompatibility {
  status: 'compatible' | 'partial' | 'unsupported' | 'unknown'
  supported: PluginHostCapability[]
  unsupported: PluginHostCapability[]
  reason?: string
}

/** Marketplace source 保留 pin 与 subdirectory，禁止压扁成无法复现的 URL。 */
export type PluginPackageSource =
  | { type: 'directory'; path: string }
  | { type: 'git'; url: string; ref?: string; sha?: string; subdirectory?: string }
  | { type: 'npm'; package: string; version?: string; registry?: string }
  | { type: 'archive'; url: string; sha256: string }

export interface PluginAdapterDescriptor {
  format: PluginPackageFormat
  source: PluginPackageSource
  /** Anthropic strict overlay 等宿主字段；只交给对应 adapter，不进入核心 loader。 */
  marketplaceEntry?: Record<string, unknown>
}

/** 插件记账条目（plugins.json，修订号 CAS） */
export interface PluginRecord {
  name: string
  version?: string
  source: string
  scope: PluginScope
  path: string
  installedAt: string
  members: {
    skills: string[]
    mcpServers: string[]
  }
}

export interface PluginsFile {
  revision: number
  plugins: PluginRecord[]
}

/** CLI、IPC 与市场页共用的已安装插件投影。 */
export interface PluginInfo {
  name: string
  version?: string
  description?: string
  source: string
  scope: PluginScope
  path: string
  installedAt?: string
  manifest: PluginManifest
  members: {
    skills: PluginSkillMember[]
    mcpServers: PluginMcpMember[]
  }
  warnings?: string[]
  compatibility?: PluginCompatibility
}

export interface PluginMarketplacePolicy {
  installation: 'NOT_AVAILABLE' | 'AVAILABLE' | 'INSTALLED_BY_DEFAULT'
  authentication?: 'ON_INSTALL' | 'ON_USE'
}

export interface PluginMarketplaceEntry {
  name: string
  description?: string
  version?: string
  source: PluginPackageSource
  packageFormat: PluginMarketplaceFormat
  marketplaceEntry?: Record<string, unknown>
  policy: PluginMarketplacePolicy
}

export interface PluginMarketplace {
  format: PluginMarketplaceFormat
  name: string
  displayName: string
  entries: PluginMarketplaceEntry[]
  warnings: string[]
}

export interface PluginMarketplaceSource {
  name: string
  url: string
  format: PluginMarketplaceFormat
  ref?: string
  addedAt: string
}
