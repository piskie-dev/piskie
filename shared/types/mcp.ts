/** MCP 域共享类型唯一源 */

/** 条目来源；同名整条覆盖的优先级从高到低：project-explicit > project-plugin > global-explicit > global-plugin */
export type McpOrigin = 'project-explicit' | 'project-plugin' | 'global-explicit' | 'global-plugin'

export type McpTransportKind = 'stdio' | 'streamable_http'

/** 单 server 配置条目；command 存在即 stdio、url 存在即 streamable_http，两者互斥 */
export interface McpServerConfig {
  // stdio 专用
  command?: string
  args?: string[]
  /** Claude Code-compatible overrides applied after inheriting the Piskie host environment. */
  env?: Record<string, string>
  cwd?: string
  /** stdio 默认使用 legacy 握手；显式开启后自动协商 2026-07-28 */
  enable_2026_protocol?: boolean
  // streamable_http 专用
  url?: string
  http_headers?: Record<string, string>
  /** 值取自环境变量的 header 表（键 = header 名，值 = 环境变量名） */
  env_http_headers?: Record<string, string>
  bearer_token_env_var?: string
  oauth?: { client_id?: string }
  /** RFC 8707 resource indicator */
  oauth_resource?: string
  scopes?: string[]
  // 共用
  /** 全局代理池 ID；仅 streamable_http 使用。 */
  proxyId?: string
  enabled?: boolean
  startup_timeout_sec?: number
  tool_timeout_sec?: number
  /** 工具 allowlist（先于 denylist 求值） */
  enabled_tools?: string[]
  disabled_tools?: string[]
  supports_parallel_tool_calls?: boolean
}

/** 全局配置域 mcp.json 与项目级 {workspace}/.piskie/mcp.json 共用的文件形状 */
export interface McpConfigDocument {
  mcpServers: Record<string, McpServerConfig>
}

/** 四来源合并后的生效条目 */
export interface EffectiveMcpServer {
  name: string
  origin: McpOrigin
  transport: McpTransportKind
  config: McpServerConfig
  /** Runtime 解析 cwd/缓存身份使用的 workspace（realpath 规范化）；管理面原始全局条目可缺省。 */
  workspace?: string
  /**
   * OAuth credential generation 的不可逆摘要。它只用于 launch/cache identity，
   * 不包含 access/refresh token，也不应作为管理面展示字段。
   */
  oauthCredentialIdentity?: string
  /** 插件来源的插件名 */
  plugin?: string
  /** 插件来源 manifest 中声明的版本；参与 runtime launch identity。 */
  pluginVersion?: string
}

/** 服务器自述的工具 annotations（不可信，审批求值时缺省从严） */
export interface McpToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

/** tools/list 快照中的单工具描述 */
export interface McpToolDescriptor {
  /** raw 协议名（调用时上协议用） */
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  annotations?: McpToolAnnotations
}

/** 单 server 的 tools/list 快照（注入时刻消费；带缓存元信息） */
export interface McpServerSnapshot {
  server: string
  protocolVersion?: string
  /** server 自述使用说明（截断 2KB 后进 L5；仅直注 server 注入） */
  instructions?: string
  tools: McpToolDescriptor[]
  fetchedAt: string
  /** 拉取时的配置修订指纹：配置一变缓存即失效 */
  configFingerprint: string
}

/** 安装后 best-effort onboarding：OAuth 探测/可选登录 + 一次 tools/list 预取。 */
export interface McpOnboardingResult {
  name: string
  oauth: {
    supported: boolean
    authenticated?: boolean
    issuer?: string
  }
  probe?: {
    protocolVersion?: string
    toolCount: number
  }
  /** 后置动作失败不回滚已提交的安装，统一以 warning 返回。 */
  warnings: string[]
}

/** 配置写入本身的结果；底层 McpPort 不承担安装后动作。 */
export interface McpAddResult {
  name: string
  scope: 'user' | 'project'
  trusted?: boolean
}

/** App/CLI 的 add 入口在写入后统一附带 best-effort onboarding 结果。 */
export interface McpAddWithOnboardingResult extends McpAddResult {
  onboarding: McpOnboardingResult
}

export type McpConnectionState = 'idle' | 'connecting' | 'ready' | 'error' | 'unavailable'

/** 单个 Agent/Composer 所有的 MCP runtime 生命周期；不持久化。 */
export type McpRuntimeState =
  | 'not_started'
  | 'dormant'
  | 'starting'
  | 'ready'
  | 'failed'
  | 'reconnecting'
  | 'blocked'

/** 当前会话中单个 server 的安全展示投影。 */
export interface AgentMcpServerView {
  name: string
  state: McpRuntimeState
  transport: McpTransportKind
  origin: McpOrigin
  toolCount?: number
  catalogSource?: 'live' | 'cache'
  catalogDrift?: boolean
  published: boolean
  appliesAt?: 'current-boundary' | 'next-boundary'
  errorCode?: string
  errorSummary?: string
  retryable?: boolean
}

/** Renderer 可消费的会话 MCP 聚合；sessionRuntimeId 仅作 opaque identity。 */
export interface AgentMcpView {
  sessionRuntimeId: string
  startedAt?: string
  total: number
  ready: number
  starting: number
  dormant: number
  failed: number
  blocked: number
  projectionRevision: number
  servers: readonly AgentMcpServerView[]
}

export type McpRuntimeOwnerKind = 'main' | 'worker' | 'composer'

/** 能力市场按 Project 聚合活跃会话时使用；不含连接 key、epoch 或 secret。 */
export interface McpSessionRuntimeSummary extends AgentMcpView {
  ownerId: string
  ownerKind: McpRuntimeOwnerKind
  ownerLabel?: string
  projectContextId: string
  workspace?: string
}

/** Connections 页与 CLI status 的运行态投影 */
export interface McpServerStatus {
  name: string
  origin: McpOrigin
  transport: McpTransportKind
  enabled: boolean
  state: McpConnectionState
  error?: string
  toolCount?: number
  lastProbedAt?: string
  plugin?: string
  workspace?: string
}

/** CLI、IPC 与 Connections 页共用的配置/运行态投影。 */
export interface McpServerInfo {
  name: string
  scope: 'user' | 'project'
  origin: 'explicit' | 'plugin'
  transport: McpTransportKind
  command?: string
  args?: string[]
  url?: string
  enabled: boolean
  plugin?: string
  workspace?: string
  trusted?: boolean
  auth?: 'bearer-env' | 'oauth' | 'none'
  config: McpServerConfig
  state?: McpConnectionState
  toolCount?: number
  /** 当前工具目录投影成本，不参与会话占用量计算。 */
  projectedTokens?: number
  exposure?: 'direct' | 'deferred' | 'hidden'
  error?: string
}

/** Connections 页按运行时同一预算函数生成的只读测量结果。 */
export interface McpBudgetPreviewItem {
  name: string
  origin: McpOrigin
  plugin?: string
  workspace?: string
  toolCount: number
  projectedTokens: number
  exposure: 'direct' | 'deferred' | 'hidden' | 'unavailable'
  hiddenToolCount?: number
  error?: string
}

export interface McpBudgetPreview {
  workspace?: string
  contextWindowTokens: number
  budgetTokens: number
  usedTokens: number
  servers: McpBudgetPreviewItem[]
  warnings: string[]
}

export interface McpAuthStatus {
  name: string
  method: 'none' | 'bearer-env' | 'oauth'
  authenticated: boolean
  issuer?: string
  scope?: string
  expiresAt?: number
}

/** MCP Registry 搜索的轻量结果；packages/remotes 保留官方原始结构供配置提示投影。 */
export interface McpRegistrySearchResult {
  name: string
  description?: string
  version?: string
  packages?: unknown[]
  remotes?: unknown[]
}

/** 全局配置域 trusted_project_servers 表条目（键 = hash(workspace + server 名 + 配置内容)） */
export interface McpTrustRecord {
  workspace: string
  server: string
  trustedAt: string
}
