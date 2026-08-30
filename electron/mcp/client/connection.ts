/**
 * v2 client 封装：传输构造 + 版本协商。
 *
 * 版本策略：默认以 2025-06-18 世代为兼容底线（legacy 握手）；
 * streamable_http 经 server/discover 自动探测新协议并按响应回退；
 * stdio 的自动探测每次 connect 多 spawn 一个探测子进程，保守起见
 * 需配置 enable_2026_protocol 显式 opt-in。
 */

import { Client } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

import path from 'node:path'

import type { EffectiveMcpServer, McpServerConfig, McpServerSnapshot, McpToolDescriptor } from '@shared/types/mcp.js'
import { getPilotRoot } from '../../piskiepilot/paths.js'
import {
  resolvePublishedProxyFetch,
  type ProxyFetchResolver,
} from '../../core/proxy/proxy-fetch.js'
import { getHostEnvironment, getHostEnvironmentVariable, type StringEnvironment } from '../../environment/host-environment.js'
import { configFingerprint } from '../bridge/snapshot.js'
import { resolveMcpServerCwd } from '../runtime/identity.js'
import { getValidAccessToken } from './oauth/store.js'

export const DEFAULT_STARTUP_TIMEOUT_SEC = 30
export const DEFAULT_TOOL_TIMEOUT_SEC = 300

const CLIENT_INFO = { name: 'piskie', version: '1.0.0' }

export function startupTimeoutMs(config: McpServerConfig): number {
  return (config.startup_timeout_sec ?? DEFAULT_STARTUP_TIMEOUT_SEC) * 1000
}

export function toolTimeoutMs(config: McpServerConfig): number {
  return (config.tool_timeout_sec ?? DEFAULT_TOOL_TIMEOUT_SEC) * 1000
}

function buildHttpHeaders(config: McpServerConfig): Record<string, string> {
  const headers: Record<string, string> = { ...config.http_headers }
  for (const [header, envVar] of Object.entries(config.env_http_headers ?? {})) {
    const value = getHostEnvironmentVariable(envVar)
    if (value !== undefined) headers[header] = value
  }
  return headers
}

/** Claude Code-compatible stdio semantics: inherit the host snapshot, then apply server overrides. */
export function buildMcpEnvironment(
  config: McpServerConfig,
  hostEnvironment: StringEnvironment = getHostEnvironment(),
): StringEnvironment {
  return { ...hostEnvironment, ...config.env }
}

function createTransport(
  server: EffectiveMcpServer,
  resolveFetch: ProxyFetchResolver = resolvePublishedProxyFetch,
) {
  const { config } = server
  if (server.transport === 'stdio') {
    return new StdioClientTransport({
      command: config.command!,
      args: config.args,
      env: buildMcpEnvironment(config),
      // 未显式配置时按 server 所属项目落地，避免继承应用进程的工作目录
      cwd: resolveMcpServerCwd(server),
      stderr: 'ignore',
    })
  }

  const bearerEnv = config.bearer_token_env_var
  const url = config.url!
  const fetch = resolveFetch(config.proxyId, globalThis.fetch)
  return new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: buildHttpHeaders(config) },
    fetch,
    // 鉴权优先级：bearer 环境变量 > OAuth 凭据存储（按 issuer 取、临期自动
    // 刷新）；两者皆无时不带 Authorization（server 可能本就不要求鉴权）
    authProvider: {
      token: async () => {
        if (bearerEnv) return getHostEnvironmentVariable(bearerEnv)
        return getValidAccessToken(path.dirname(getPilotRoot()), url, fetch)
      },
    },
  })
}

/** elicitation 请求（form 模式）投递给调用侧的形状 */
export interface McpElicitationRequest {
  message: string
  requestedSchema: Record<string, unknown>
}

/** elicitation content 值域受协议约束（扁平原语 + 多选枚举数组） */
export type McpElicitationValue = string | number | boolean | string[]

export type McpElicitationResponse =
  | { action: 'accept'; content: Record<string, McpElicitationValue> }
  | { action: 'decline' | 'cancel' }

export type McpElicitationSink = (request: McpElicitationRequest) => Promise<McpElicitationResponse>

export interface McpConnection {
  client: Client
  server: EffectiveMcpServer
  protocolVersion?: string
  /** 传输已关闭时为 true；连接池据此避免复用断流连接。 */
  isClosed(): boolean
  /** Subscribe to transport loss. A late subscriber is notified when the connection is closed. */
  onClose?(listener: () => void): () => void
  /**
   * 当前交互调用的 elicitation 接收方。SDK 把两种协议汇入同一 handler
   * （旧协议 = 服务器发起请求；2026 MRTR = autoFulfill 内部回填后重发原请求），
   * handler 是连接级的，归属按"当前持有 sink 的调用"路由：无持有者一律 decline。
   */
  setElicitationSink(sink: McpElicitationSink | undefined): void
  close(): Promise<void>
}

export function protocolNegotiationMode(server: EffectiveMcpServer): 'auto' | 'legacy' {
  return server.transport === 'streamable_http' || server.config.enable_2026_protocol === true
    ? 'auto'
    : 'legacy'
}

/** 建连（stdio 在此刻才启动子进程）；startup 超时附配置修复示例 */
export async function connectMcpServer(
  server: EffectiveMcpServer,
  options: { signal?: AbortSignal; resolveFetch?: ProxyFetchResolver } = {},
): Promise<McpConnection> {
  const client = new Client(CLIENT_INFO, {
    capabilities: { elicitation: { form: {} } },
    versionNegotiation: { mode: protocolNegotiationMode(server) },
  })
  let closed = false
  const closeListeners = new Set<() => void>()
  const markClosed = (): void => {
    if (closed) return
    closed = true
    for (const listener of closeListeners) listener()
  }
  client.onclose = () => {
    markClosed()
  }

  // 两种协议汇入同一 handler：旧协议 elicitation/create 直达；
  // 2026 MRTR input_required 由 SDK autoFulfill 经同一 handler 回填后内部重发原请求。
  // url 模式（跳转外部页面）不支持，form 之外一律 decline。
  let elicitationSink: McpElicitationSink | undefined
  client.setRequestHandler('elicitation/create', async (request: {
    params: { mode?: string; message?: string; requestedSchema?: Record<string, unknown> }
  }) => {
    const params = request.params
    if (!elicitationSink || (params.mode !== undefined && params.mode !== 'form') || !params.requestedSchema) {
      return { action: 'decline' as const }
    }
    return elicitationSink({
      message: params.message ?? '',
      requestedSchema: params.requestedSchema,
    })
  })

  const transport = createTransport(server, options.resolveFetch)
  const timeout = startupTimeoutMs(server.config)
  try {
    await client.connect(transport, { timeout, signal: options.signal })
  } catch (error) {
    await client.close().catch(() => undefined)
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `MCP server "${server.name}" 启动/连接失败（${timeout / 1000}s 超时）：${message}。`
      + `可在配置中调大超时，例如 {"mcpServers": {"${server.name}": {"startup_timeout_sec": ${Math.max(60, timeout / 1000 * 2)}}}}`,
    )
  }
  return {
    client,
    server,
    protocolVersion: client.getNegotiatedProtocolVersion(),
    isClosed: () => closed,
    onClose: (listener) => {
      if (closed) {
        queueMicrotask(listener)
        return () => undefined
      }
      closeListeners.add(listener)
      return () => closeListeners.delete(listener)
    },
    setElicitationSink: (sink) => {
      elicitationSink = sink
    },
    close: async () => {
      markClosed()
      await client.close().catch(() => undefined)
      closeListeners.clear()
    },
  }
}

export function toToolDescriptor(tool: {
  name: string
  description?: string
  inputSchema?: unknown
  annotations?: {
    title?: string
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
}): McpToolDescriptor {
  const schema = tool.inputSchema && typeof tool.inputSchema === 'object'
    ? tool.inputSchema as Record<string, unknown>
    : { type: 'object', properties: {} }
  if (schema.properties === undefined || schema.properties === null) {
    schema.properties = {}
  }
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: schema,
    annotations: tool.annotations,
  }
}

/** Discover a live connection without transferring ownership or closing it. */
export async function discoverMcpConnection(
  connection: McpConnection,
  options: { signal?: AbortSignal } = {},
): Promise<McpServerSnapshot> {
  const server = connection.server
  const { tools } = await connection.client.listTools(undefined, {
    timeout: startupTimeoutMs(server.config),
    signal: options.signal,
  })
  return {
    server: server.name,
    protocolVersion: connection.protocolVersion,
    instructions: connection.client.getInstructions(),
    tools: tools.map(toToolDescriptor),
    fetchedAt: new Date().toISOString(),
    configFingerprint: configFingerprint(server.config),
  }
}

/** Connect and discover once; the caller owns the returned live connection. */
export async function connectAndDiscoverMcpServer(
  server: EffectiveMcpServer,
  options: { signal?: AbortSignal; resolveFetch?: ProxyFetchResolver } = {},
): Promise<{
  connection: McpConnection
  snapshot: McpServerSnapshot
}> {
  // startup_timeout_sec is one deadline for connect + initialize + initial tools/list.
  const deadline = AbortSignal.timeout(startupTimeoutMs(server.config))
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
  const connection = await connectMcpServer(server, {
    signal,
    resolveFetch: options.resolveFetch,
  })
  try {
    const snapshot = await discoverMcpConnection(connection, { signal })
    return { connection, snapshot }
  } catch (error) {
    await connection.close()
    throw error
  }
}

/** 一次性建连拉取快照（注入时刻/探活共用；用毕即断，不占池） */
export async function fetchServerSnapshot(
  server: EffectiveMcpServer,
  options: { resolveFetch?: ProxyFetchResolver } = {},
): Promise<McpServerSnapshot> {
  const { connection, snapshot } = await connectAndDiscoverMcpServer(server, options)
  try {
    return snapshot
  } finally {
    await connection.close()
  }
}
