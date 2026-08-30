/**
 * McpPort：MCP 连接器管理面唯一应用端口。
 * IPC handler、CLI、市场安装动作三方共用。
 *
 * 全局层写入走 config domain 'mcp' 的 plan → validate → CAS apply；
 * 项目层写 {workspace}/.piskie/mcp.json（普通 JSON，无 revision 体系）。
 * 项目级由用户亲手写入（CLI/UI 作用域选择器）即视为已信任——同一事务记
 * trusted_project_servers 表（全局域）。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { ConfigPatchOperation } from '../../shared/types/config.js'
import { mcpServerConfigSchema } from '../../shared/schemas/mcp.js'
import type {
  McpAddResult,
  McpAuthStatus,
  McpBudgetPreview,
  McpOnboardingResult,
  McpRegistrySearchResult,
  EffectiveMcpServer,
  McpServerInfo,
  McpServerConfig,
  McpServerSnapshot,
} from '../../shared/types/mcp.js'
import { discoverPluginMcpContributions } from '../plugins/mcp-members.js'
import {
  createFileProxyFetchResolver,
  type ProxyFetchResolver,
} from '../core/proxy/proxy-fetch.js'
import { isProjectLayerActive } from '../skills/store/layout.js'
import { createMcpDomain, toMcpDomainSnapshot, type McpDomainSnapshot } from './config/domain.js'
import { projectMcpConfigPath, readProjectMcpOverlay } from './config/project-overlay.js'
import { buildTrustRecord, isTrusted, normalizeWorkspace, trustKey } from './config/trust.js'
import { fetchServerSnapshot } from './client/connection.js'
import {
  OAuthFlowError,
  performOAuthLogin,
  probeOAuthSupport,
  type OAuthLoginResult,
  type OAuthProbeResult,
} from './client/oauth/flow.js'
import { findIssuerRecordByResource, removeResource } from './client/oauth/store.js'
import { DEFAULT_CONTEXT_WINDOW_TOKENS, planMcpBudget } from './bridge/budget.js'
import {
  evaluateEffectiveServers,
  configFingerprint,
  fetchServerSnapshots,
  mergeMcpServerLayers,
  type McpSnapshotFetcher,
} from './bridge/snapshot.js'
import { sanitizeMcpErrorText, sanitizeMcpText } from './security/sanitize.js'
import { resolveMcpServerCredentialIdentities } from './runtime/identity.js'

export class McpPortError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'McpPortError'
  }
}

export type McpServerListItem = McpServerInfo
export type McpServerDetail = McpServerInfo

export interface McpAddRequest {
  name: string
  scope: 'user' | 'project'
  workspace?: string
  config: McpServerConfig
  force?: boolean
}

export interface McpPortOptions {
  configRoot: string
  /**
   * 缺省 workspace 路径（{userData}/workspace）：项目层在该路径不激活，
   * 项目级写入解析到它时拒绝（写了也永远不会被读取）
   */
  defaultWorkspaceDir?: string
  /** 任一显式 MCP 配置/信任写入完成后的应用层通知；CLI 缺省空。 */
  onChanged?: (
    event: { type: 'added' | 'removed' | 'trusted'; name: string; workspace?: string },
  ) => void | Promise<void>
  /** 测试注入点；生产使用真实 MCP client。 */
  snapshotFetcher?: McpSnapshotFetcher
  /** HTTP/OAuth 请求按 server.proxyId 选择全局代理；CLI 默认从 configRoot 读取。 */
  resolveFetch?: ProxyFetchResolver
  /** App 进程只读 Manager safe catalog cache；CLI 缺省不注入。 */
  readCachedCatalog?: (server: EffectiveMcpServer) => McpServerSnapshot | undefined
  /** App 进程把 one-shot discovery 的安全目录同步写入 Session Runtime Catalog Cache。 */
  onCatalogDiscovered?: (server: EffectiveMcpServer, snapshot: McpServerSnapshot) => void
  /** 测试注入点；生产使用 RFC 9728/OAuth metadata 探测。 */
  oauthProber?: (url: string, timeoutMs?: number) => Promise<OAuthProbeResult>
  /** 安装后探测使用短超时，避免后置动作长期卡住已成功的事务。 */
  onboardingTimeoutSec?: number
  /** app 可注入 Electron 授权窗口；CLI 缺省走系统浏览器。返回清理函数可在流程结束时关闭窗口。 */
  openAuthorizationUrl?: (
    url: string,
    onClosed?: () => void,
  ) => void | (() => void) | Promise<void | (() => void)>
}

export interface McpPort {
  list(opts?: { scope?: 'user' | 'project' | 'all'; workspace?: string }): Promise<McpServerListItem[]>
  get(name: string, opts?: { workspace?: string }): Promise<McpServerDetail>
  add(request: McpAddRequest): Promise<McpAddResult>
  remove(name: string, opts: { scope: 'user' | 'project'; workspace?: string }): Promise<{ name: string; scope: string }>
  /** 探活：连接 → tools/list → 关闭（信任门之外的诊断动作，不写任何状态） */
  probe(name: string, opts?: { workspace?: string }): Promise<McpServerSnapshot>
  /** 安装后 OAuth 探测/可选登录 + tools/list 预取；失败只进入 warnings。 */
  onboard(name: string, opts?: {
    workspace?: string
    login?: boolean
    log?: (message: string) => void
    openAuthorizationUrl?: McpPortOptions['openAuthorizationUrl']
  }): Promise<McpOnboardingResult>
  /** 显式触发的 tools/list + token/exposure 预览；App 可复用 Manager 安全目录缓存。 */
  budgetPreview(opts?: { workspace?: string; contextWindowTokens?: number }): Promise<McpBudgetPreview>
  login(name: string, opts?: {
    workspace?: string
    scopes?: string[]
    openAuthorizationUrl?: McpPortOptions['openAuthorizationUrl']
    log?: (message: string) => void
  }): Promise<OAuthLoginResult>
  logout(name: string, opts?: { workspace?: string }): Promise<{ removed: boolean }>
  authStatus(name: string, opts?: { workspace?: string }): Promise<McpAuthStatus>
  /** 信任某 workspace 的项目级 server（按当前配置内容记表） */
  trust(name: string, workspace: string): Promise<{ name: string; workspace: string }>
  /** 插件贡献层写入时使用：按展开后的配置直接记信任，不物化进项目 mcp.json。 */
  trustConfiguration(
    name: string,
    workspace: string,
    config: McpServerConfig,
  ): Promise<{ name: string; workspace: string }>
  /** Connections 生效集预览与运行时共用同一四来源求值函数。 */
  effective(workspace?: string): Promise<ReturnType<typeof evaluateEffectiveServers>>
  search(query: string): Promise<McpRegistrySearchResult[]>
}

const REGISTRY_BASE_URL = 'https://registry.modelcontextprotocol.io'

function escapePointer(token: string): string {
  return token.replaceAll('~', '~0').replaceAll('/', '~1')
}

function transportOf(config: McpServerConfig): 'stdio' | 'streamable_http' {
  return config.command ? 'stdio' : 'streamable_http'
}

function authOf(config: McpServerConfig): 'bearer-env' | 'oauth' | 'none' | undefined {
  if (!config.url) return undefined
  if (config.bearer_token_env_var) return 'bearer-env'
  if (config.oauth || config.scopes) return 'oauth'
  return 'none'
}

export function createMcpPort(options: McpPortOptions): McpPort {
  const domain = createMcpDomain(options.configRoot, { publish: () => undefined })
  const resolveFetch = options.resolveFetch ?? createFileProxyFetchResolver(options.configRoot)
  const snapshotFetcher: McpSnapshotFetcher = options.snapshotFetcher
    ?? ((server) => fetchServerSnapshot(server, { resolveFetch }))

  async function showGlobal(): Promise<McpDomainSnapshot> {
    // 首次访问时从 bootstrap 建立存储（幂等）
    await domain.prepare()
    return toMcpDomainSnapshot(await domain.show())
  }

  async function applyGlobalPatch(patch: ConfigPatchOperation[]): Promise<McpDomainSnapshot> {
    await domain.prepare()
    const current = await domain.show()
    const plan = await domain.createPlan(patch)
    if (!plan.validation.valid) {
      const issues = plan.validation.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ')
      throw new McpPortError('VALIDATION_FAILED', `MCP 配置校验失败：${issues}`)
    }
    await domain.apply(plan.id, current.revision)
    return showGlobal()
  }

  async function writeProjectOverlay(
    workspace: string,
    mutate: (servers: Record<string, McpServerConfig>) => void,
  ): Promise<void> {
    const file = projectMcpConfigPath(workspace)
    const existing = await readProjectMcpOverlay(workspace)
    const document = { mcpServers: { ...existing.servers } }
    mutate(document.mcpServers)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  }

  /** 项目级写入目标校验：realpath 规范化 + 缺省 workspace 拒绝 */
  async function resolveProjectWorkspace(workspace: string): Promise<string> {
    const normalized = await normalizeWorkspace(workspace)
    if (options.defaultWorkspaceDir !== undefined) {
      const active = await isProjectLayerActive(normalized, options.defaultWorkspaceDir)
      if (!active) {
        throw new McpPortError(
          'DEFAULT_WORKSPACE',
          '目标解析为缺省 workspace 路径：该路径被所有缺省 AgentRun 共享，项目级层在此不激活，写入永远不会被读取',
        )
      }
    }
    return normalized
  }

  /** trusted_project_servers 表可能尚不存在：不存在时整表建立，存在时单键追加 */
  function trustPatch(
    global: McpDomainSnapshot,
    key: string,
    record: ReturnType<typeof buildTrustRecord>,
  ): ConfigPatchOperation[] {
    if (Object.keys(global.trustedProjectServers).length === 0) {
      return [{ op: 'add', path: '/trusted_project_servers', value: { [key]: record } }]
    }
    return [{ op: 'add', path: `/trusted_project_servers/${escapePointer(key)}`, value: record }]
  }

  function validateConfigShape(config: McpServerConfig): void {
    if (config.command && config.url) {
      throw new McpPortError('INVALID_CONFIG', 'command 与 url 互斥：server 要么 stdio 要么 streamable_http')
    }
    if (!config.command && !config.url) {
      throw new McpPortError('INVALID_CONFIG', '必须提供 command（stdio）或 url（streamable_http）之一')
    }
    const parsed = mcpServerConfigSchema.safeParse(config)
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(server)'}: ${issue.message}`)
        .join('; ')
      throw new McpPortError('VALIDATION_FAILED', `MCP 配置校验失败：${issues}`)
    }
  }

  async function resolveEffective(name: string, workspaceInput?: string): Promise<EffectiveMcpServer> {
    const result = await effectiveForWorkspace(workspaceInput)
    const server = result.servers.find((candidate) => candidate.name === name)
    if (server) return server
    const skipped = result.skipped.find((candidate) => candidate.name === name)
    if (skipped?.reason === 'untrusted') {
      throw new McpPortError(
        'UNTRUSTED',
        `项目级 server "${name}" 未过信任门。用 piskie mcp trust ${name} --workspace <dir> 信任它。`,
      )
    }
    throw new McpPortError('NOT_FOUND', `unknown MCP server '${name}'`)
  }

  async function fetchAndCacheSnapshot(
    server: EffectiveMcpServer,
    startupTimeoutSec?: number,
  ): Promise<McpServerSnapshot> {
    const fetchTarget = startupTimeoutSec === undefined
      ? server
      : {
          ...server,
          config: { ...server.config, startup_timeout_sec: startupTimeoutSec },
        }
    const fetched = await snapshotFetcher(fetchTarget)
    const snapshot = startupTimeoutSec === undefined
      ? fetched
      : { ...fetched, configFingerprint: configFingerprint(server.config) }
    options.onCatalogDiscovered?.(server, snapshot)
    return snapshot
  }

  async function effectiveForWorkspace(workspaceInput?: string) {
    const global = await showGlobal()
    const defaultWorkspace = await normalizeWorkspace(
      options.defaultWorkspaceDir ?? path.join(options.configRoot, 'workspace'),
    )
    const runtimeWorkspace = workspaceInput
      ? await normalizeWorkspace(workspaceInput)
      : defaultWorkspace
    const workspace = workspaceInput && await isProjectLayerActive(runtimeWorkspace, defaultWorkspace)
      ? runtimeWorkspace
      : undefined
    const overlay = workspace ? await readProjectMcpOverlay(workspace) : { servers: {}, warnings: [] }
    const plugins = await discoverPluginMcpContributions({ configRoot: options.configRoot, workspace })
    const effective = evaluateEffectiveServers({
      global: global.mcpServers,
      globalPlugins: plugins.global,
      projectExplicit: overlay.servers,
      projectPlugins: plugins.project,
      workspace,
      trustTable: global.trustedProjectServers,
    })
    const servers = await resolveMcpServerCredentialIdentities(
      options.configRoot,
      effective.servers.map((server) => ({ ...server, workspace: runtimeWorkspace })),
    )
    return {
      ...effective,
      servers,
      workspace,
      runtimeWorkspace,
    }
  }

  return {
    async list(opts = {}) {
      const scope = opts.scope ?? 'all'
      const global = await showGlobal()
      const items: McpServerListItem[] = []
      const workspace = opts.workspace ? await normalizeWorkspace(opts.workspace) : undefined
      const plugins = await discoverPluginMcpContributions({ configRoot: options.configRoot, workspace })

      if (scope === 'user' || scope === 'all') {
        for (const contribution of plugins.global) {
          for (const [name, config] of Object.entries(contribution.servers)) {
            items.push({
              name,
              scope: 'user',
              origin: 'plugin',
              transport: transportOf(config),
              command: config.command,
              args: config.args,
              url: config.url,
              enabled: config.enabled !== false,
              plugin: contribution.plugin,
              auth: authOf(config),
              config,
            })
          }
        }
        for (const [name, config] of Object.entries(global.mcpServers)) {
          items.push({
            name,
            scope: 'user',
            origin: 'explicit',
            transport: transportOf(config),
            command: config.command,
            args: config.args,
            url: config.url,
            enabled: config.enabled !== false,
            auth: authOf(config),
            config,
          })
        }
      }

      if ((scope === 'project' || scope === 'all') && workspace) {
        for (const contribution of plugins.project) {
          for (const [name, config] of Object.entries(contribution.servers)) {
            items.push({
              name,
              scope: 'project',
              origin: 'plugin',
              transport: transportOf(config),
              command: config.command,
              args: config.args,
              url: config.url,
              enabled: config.enabled !== false,
              trusted: isTrusted(global.trustedProjectServers, workspace, name, config),
              plugin: contribution.plugin,
              auth: authOf(config),
              workspace,
              config,
            })
          }
        }
        const overlay = await readProjectMcpOverlay(workspace)
        for (const [name, config] of Object.entries(overlay.servers)) {
          items.push({
            name,
            scope: 'project',
            origin: 'explicit',
            transport: transportOf(config),
            command: config.command,
            args: config.args,
            url: config.url,
            enabled: config.enabled !== false,
            trusted: isTrusted(global.trustedProjectServers, workspace, name, config),
            auth: authOf(config),
            workspace,
            config,
          })
        }
      }

      return items.sort((a, b) =>
        a.name.localeCompare(b.name)
        || a.scope.localeCompare(b.scope)
        || a.origin.localeCompare(b.origin),
      )
    },

    async get(name, opts = {}) {
      const global = await showGlobal()
      const workspace = opts.workspace ? await normalizeWorkspace(opts.workspace) : undefined
      const [overlay, plugins] = await Promise.all([
        workspace ? readProjectMcpOverlay(workspace) : Promise.resolve({ servers: {}, warnings: [] }),
        discoverPluginMcpContributions({ configRoot: options.configRoot, workspace }),
      ])
      const winner = mergeMcpServerLayers({
        global: global.mcpServers,
        globalPlugins: plugins.global,
        projectExplicit: overlay.servers,
        projectPlugins: plugins.project,
        workspace,
        trustTable: global.trustedProjectServers,
      }).find((server) => server.name === name)
      if (!winner) throw new McpPortError('NOT_FOUND', `unknown MCP server '${name}'`)

      return {
        name,
        scope: winner.origin.startsWith('project') ? 'project' : 'user',
        origin: winner.origin.endsWith('plugin') ? 'plugin' : 'explicit',
        transport: winner.transport,
        command: winner.config.command,
        args: winner.config.args,
        url: winner.config.url,
        enabled: winner.config.enabled !== false,
        plugin: winner.plugin,
        workspace: winner.workspace,
        trusted: winner.workspace
          ? isTrusted(global.trustedProjectServers, winner.workspace, name, winner.config)
          : undefined,
        auth: authOf(winner.config),
        config: winner.config,
      }
    },

    async add(request) {
      validateConfigShape(request.config)

      if (request.scope === 'user') {
        const global = await showGlobal()
        if (global.mcpServers[request.name] && !request.force) {
          throw new McpPortError('SERVER_EXISTS', `MCP server "${request.name}" 已存在（全局）。先 remove 或换名。`)
        }
        await applyGlobalPatch([
          {
            op: global.mcpServers[request.name] ? 'replace' : 'add',
            path: `/mcpServers/${escapePointer(request.name)}`,
            value: request.config,
          },
        ])
        await options.onChanged?.({ type: 'added', name: request.name })
        return { name: request.name, scope: 'user' as const }
      }

      if (!request.workspace) throw new McpPortError('INVALID_CONFIG', '--scope project 需要 workspace')
      const workspace = await resolveProjectWorkspace(request.workspace)
      const overlay = await readProjectMcpOverlay(workspace)
      if (overlay.servers[request.name] && !request.force) {
        throw new McpPortError('SERVER_EXISTS', `MCP server "${request.name}" 已存在（项目 ${workspace}）。`)
      }
      await writeProjectOverlay(workspace, (servers) => {
        servers[request.name] = request.config
      })
      // 用户亲手写入 = 显式信任动作，同一事务记信任表
      const global = await showGlobal()
      const key = trustKey(workspace, request.name, request.config)
      await applyGlobalPatch(trustPatch(global, key, buildTrustRecord(workspace, request.name)))
      await options.onChanged?.({ type: 'added', name: request.name, workspace })
      return { name: request.name, scope: 'project' as const, trusted: true }
    },

    async remove(name, opts) {
      if (opts.scope === 'user') {
        const global = await showGlobal()
        if (!global.mcpServers[name]) {
          const pluginItem = (await this.list({ scope: 'user' }))
            .find((item) => item.name === name && item.origin === 'plugin')
          if (pluginItem) {
            throw new McpPortError(
              'PLUGIN_MEMBER',
              `${name} 是插件 ${pluginItem.plugin} 的成员，不可单独卸载；使用 piskie plugin remove ${pluginItem.plugin}`,
            )
          }
          throw new McpPortError('NOT_FOUND', `unknown MCP server '${name}'`)
        }
        await applyGlobalPatch([{ op: 'remove', path: `/mcpServers/${escapePointer(name)}` }])
        await options.onChanged?.({ type: 'removed', name })
        return { name, scope: 'user' }
      }
      if (!opts.workspace) throw new McpPortError('INVALID_CONFIG', '--scope project 需要 workspace')
      const workspace = await normalizeWorkspace(opts.workspace)
      const overlay = await readProjectMcpOverlay(workspace)
      if (!overlay.servers[name]) {
        const pluginItem = (await this.list({ scope: 'project', workspace }))
          .find((item) => item.name === name && item.origin === 'plugin')
        if (pluginItem) {
          throw new McpPortError(
            'PLUGIN_MEMBER',
            `${name} 是插件 ${pluginItem.plugin} 的成员；可写同名 enabled:false 覆盖，或卸载插件`,
          )
        }
        throw new McpPortError('NOT_FOUND', `unknown MCP server '${name}' in ${workspace}`)
      }
      await writeProjectOverlay(workspace, (servers) => {
        delete servers[name]
      })
      await options.onChanged?.({ type: 'removed', name, workspace })
      return { name, scope: 'project' }
    },

    async probe(name, opts = {}) {
      const server = await resolveEffective(name, opts.workspace)
      try {
        return await fetchAndCacheSnapshot(server)
      } catch (error) {
        throw new McpPortError(
          'PROBE_FAILED',
          sanitizeMcpErrorText(error, { server, maxLength: 4_096 }),
        )
      }
    },

    async onboard(name, opts = {}) {
      const warnings: string[] = []
      const result: McpOnboardingResult = {
        name,
        oauth: { supported: false },
        warnings,
      }
      const timeoutSec = Math.max(1, options.onboardingTimeoutSec ?? 5)
      let server: EffectiveMcpServer
      try {
        server = await resolveEffective(name, opts.workspace)
      } catch (error) {
        warnings.push(`读取安装后的 server 配置失败：${sanitizeMcpErrorText(error, { maxLength: 4_096 })}`)
        return result
      }

      if (server.config.url && !server.config.bearer_token_env_var) {
        try {
          const probe = options.oauthProber
            ? await options.oauthProber(server.config.url, timeoutSec * 1000)
            : await probeOAuthSupport(
                server.config.url,
                timeoutSec * 1000,
                resolveFetch(server.config.proxyId, globalThis.fetch),
              )
          result.oauth.supported = probe.supported
          if (probe.supported) {
            try {
              const status = await this.authStatus(name, { workspace: opts.workspace })
              result.oauth.authenticated = status.authenticated
              result.oauth.issuer = status.issuer ?? probe.metadata?.issuer
              if (!status.authenticated && opts.login === true) {
                if (!probe.metadata) {
                  warnings.push('检测到 OAuth，但未发现完整授权服务器 metadata；请稍后手动登录')
                } else {
                  const login = await this.login(name, {
                    workspace: opts.workspace,
                    openAuthorizationUrl: opts.openAuthorizationUrl,
                    log: opts.log,
                  })
                  result.oauth.authenticated = true
                  result.oauth.issuer = login.issuer
                }
              } else if (!status.authenticated) {
                warnings.push(`检测到 OAuth；可执行 piskie mcp login ${name} 完成登录`)
              }
            } catch (error) {
              warnings.push(`OAuth 登录未完成：${sanitizeMcpErrorText(error, { server, maxLength: 4_096 })}`)
            }
          }
        } catch (error) {
          warnings.push(`OAuth 探测失败：${sanitizeMcpErrorText(error, { server, maxLength: 4_096 })}`)
        }
      }

      try {
        // Login/logout may have changed while onboarding was running. Probe and cache under the
        // same credential launch identity a formal Session capability would resolve now.
        server = await resolveEffective(name, opts.workspace)
        const snapshot = await fetchAndCacheSnapshot(server, timeoutSec)
        result.probe = {
          protocolVersion: snapshot.protocolVersion,
          toolCount: snapshot.tools.length,
        }
      } catch (error) {
        warnings.push(`探活/tools/list 预取失败：${sanitizeMcpErrorText(error, { server, maxLength: 4_096 })}`)
      }
      return result
    },

    async budgetPreview(opts = {}) {
      const contextWindowTokens = opts.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS
      const [effective, global] = await Promise.all([
        effectiveForWorkspace(opts.workspace),
        showGlobal(),
      ])
      const fetched = await fetchServerSnapshots(
        effective.servers,
        snapshotFetcher,
        {
          readCachedCatalog: options.readCachedCatalog,
          onCatalogDiscovered: options.onCatalogDiscovered,
        },
      )
      const reachable = effective.servers.flatMap((server) => {
        const snapshot = fetched.snapshots.get(server.name)
        return snapshot ? [{ server, snapshot }] : []
      })
      const plan = planMcpBudget({
        servers: reachable,
        contextWindowTokens,
        budgetRatio: global.contextBudgetRatio,
      })
      const safeFailures = fetched.failures.map((failure) => ({
        ...failure,
        error: sanitizeMcpErrorText(failure.error, {
          server: failure.server,
          maxLength: 4_096,
        }),
      }))
      const plannedByName = new Map(plan.servers.map((serverPlan) => [serverPlan.server.name, serverPlan]))
      const failuresByName = new Map(safeFailures.map((failure) => [failure.server.name, failure.error]))
      const servers = effective.servers.map((server) => {
        const serverPlan = plannedByName.get(server.name)
        const snapshot = fetched.snapshots.get(server.name)
        if (!serverPlan || !snapshot) {
          return {
            name: server.name,
            origin: server.origin,
            plugin: server.plugin,
            workspace: effective.workspace,
            toolCount: 0,
            projectedTokens: 0,
            exposure: 'unavailable' as const,
            error: failuresByName.get(server.name) ?? 'tools/list 快照不可用',
          }
        }
        const projectedTokens = serverPlan.tools.reduce((sum, tool) => sum + tool.directTokens, 0)
          + (serverPlan.instructions ? Math.ceil(serverPlan.instructions.length / 4) : 0)
        return {
          name: server.name,
          origin: server.origin,
          plugin: server.plugin,
          workspace: effective.workspace,
          toolCount: snapshot.tools.length,
          projectedTokens,
          exposure: serverPlan.exposure,
          hiddenToolCount: serverPlan.hiddenTools.length || undefined,
        }
      })
      return {
        workspace: opts.workspace,
        contextWindowTokens,
        budgetTokens: plan.budgetTokens,
        usedTokens: plan.usedTokens,
        servers,
        warnings: [
          ...plan.warnings,
          ...safeFailures.map((failure) => `${failure.server.name}: ${failure.error}`),
        ],
      }
    },

    async login(name, opts = {}) {
      const server = await resolveEffective(name, opts.workspace)
      if (!server.config.url) {
        throw new McpPortError('NOT_HTTP', `MCP server "${name}" 是 stdio 传输，无 OAuth 登录`)
      }
      if (server.config.bearer_token_env_var) {
        throw new McpPortError('BEARER_AUTH', `MCP server "${name}" 使用 bearer 环境变量，不走 OAuth 登录`)
      }
      const opener = opts.openAuthorizationUrl ?? options.openAuthorizationUrl
      const authorization = new AbortController()
      let cleanup: (() => void) | undefined
      try {
        return await performOAuthLogin({
          serverName: name,
          config: server.config,
          configRoot: options.configRoot,
          scopes: opts.scopes,
          onProgress: opts.log
            ? (event) => opts.log!(event.kind === 'authorization_url'
                ? `在浏览器中完成授权：${event.url}`
                : sanitizeMcpText(event.message, { server, maxLength: 4_096 }))
            : undefined,
          signal: authorization.signal,
          fetch: resolveFetch(server.config.proxyId, globalThis.fetch),
          openAuthorizationUrl: opener
            ? async (url) => {
                cleanup?.()
                const result = await opener(url, () => {
                  authorization.abort(new OAuthFlowError(
                    'AUTHORIZATION_CANCELLED',
                    `MCP server "${name}" 的授权窗口已关闭`,
                  ))
                })
                cleanup = typeof result === 'function' ? result : undefined
              }
            : undefined,
        })
      } catch (error) {
        const message = sanitizeMcpErrorText(error, { server, maxLength: 4_096 })
        if (error instanceof OAuthFlowError) throw new OAuthFlowError(error.code, message)
        if (error instanceof McpPortError) throw new McpPortError(error.code, message)
        throw new McpPortError('OAUTH_FAILED', message)
      } finally {
        cleanup?.()
      }
    },

    async logout(name, opts = {}) {
      const server = await resolveEffective(name, opts.workspace)
      if (!server.config.url) return { removed: false }
      return { removed: await removeResource(options.configRoot, server.config.url) }
    },

    async authStatus(name, opts = {}) {
      const server = await resolveEffective(name, opts.workspace)
      if (!server.config.url) {
        return { name, method: 'none', authenticated: false }
      }
      if (server.config.bearer_token_env_var) {
        return {
          name,
          method: 'bearer-env',
          authenticated: Boolean(process.env[server.config.bearer_token_env_var]),
        }
      }
      const record = await findIssuerRecordByResource(options.configRoot, server.config.url)
      return {
        name,
        method: 'oauth',
        authenticated: Boolean(record),
        issuer: record?.issuer,
        scope: record?.tokens.scope,
        expiresAt: record?.tokens.expiresAt,
      }
    },

    async trust(name, workspaceInput) {
      const workspace = await normalizeWorkspace(workspaceInput)
      const overlay = await readProjectMcpOverlay(workspace)
      const plugins = await discoverPluginMcpContributions({ configRoot: options.configRoot, workspace })
      const pluginConfig = [...plugins.project]
        .reverse()
        .find((contribution) => contribution.servers[name])
        ?.servers[name]
      const config = overlay.servers[name] ?? pluginConfig
      if (!config) {
        throw new McpPortError('NOT_FOUND', `unknown MCP server '${name}' in ${workspace}`)
      }
      const key = trustKey(workspace, name, config)
      const global = await showGlobal()
      if (global.trustedProjectServers[key]) {
        return { name, workspace }
      }
      await applyGlobalPatch(trustPatch(global, key, buildTrustRecord(workspace, name)))
      await options.onChanged?.({ type: 'trusted', name, workspace })
      return { name, workspace }
    },

    async trustConfiguration(name, workspaceInput, config) {
      validateConfigShape(config)
      const workspace = await resolveProjectWorkspace(workspaceInput)
      const key = trustKey(workspace, name, config)
      const global = await showGlobal()
      if (!global.trustedProjectServers[key]) {
        await applyGlobalPatch(trustPatch(global, key, buildTrustRecord(workspace, name)))
        await options.onChanged?.({ type: 'trusted', name, workspace })
      }
      return { name, workspace }
    },

    effective: effectiveForWorkspace,

    async search(query) {
      const url = new URL('/v0.1/servers', REGISTRY_BASE_URL)
      url.searchParams.set('limit', '100')
      url.searchParams.set('version', 'latest')
      if (query) url.searchParams.set('search', query)
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      if (!response.ok) {
        throw new McpPortError('REGISTRY_ERROR', `MCP Registry 响应 ${response.status}`)
      }
      const body = await response.json() as { servers?: Array<Record<string, unknown>> }
      return (body.servers ?? []).map((entry) => {
        const server = entry.server && typeof entry.server === 'object' && !Array.isArray(entry.server)
          ? entry.server as Record<string, unknown>
          : entry
        return {
          name: String(server.name ?? ''),
          description: typeof server.description === 'string' ? server.description : undefined,
          version: typeof server.version === 'string' ? server.version : undefined,
          packages: Array.isArray(server.packages) ? server.packages : undefined,
          remotes: Array.isArray(server.remotes) ? server.remotes : undefined,
        }
      }).filter((entry) => entry.name.length > 0)
    },
  }
}
