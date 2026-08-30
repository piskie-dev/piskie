import { SdkError, SdkErrorCode, type CallToolResult } from '@modelcontextprotocol/client'

import type {
  AgentMcpServerView,
  EffectiveMcpServer,
  McpServerSnapshot,
  McpRuntimeState,
} from '@shared/types/mcp.js'
import {
  connectAndDiscoverMcpServer,
  toolTimeoutMs,
  type McpConnection,
  type McpElicitationSink,
} from '../client/connection.js'
import { McpConnectionLostError } from '../client/call-result.js'
import { configFingerprint } from '../bridge/snapshot.js'
import { isMcpAbortError, sanitizeMcpErrorText } from '../security/sanitize.js'
import type { McpCatalogCache, SafeMcpCatalog } from './catalog-cache.js'
import {
  sessionServerRuntimeKey,
  stableFingerprint,
  type SessionServerRuntimeKey,
} from './identity.js'

export interface McpCatalogCandidate {
  readonly key: SessionServerRuntimeKey
  readonly epoch: number
  readonly server: EffectiveMcpServer
  readonly snapshot: McpServerSnapshot
  readonly source: 'live' | 'cache'
  readonly catalogFingerprint: string
}

export interface McpServerCallOptions {
  signal?: AbortSignal
  elicitationSink?: McpElicitationSink
}

export type McpConnector = typeof connectAndDiscoverMcpServer

interface ToolCallWaiter {
  resolve(release: () => void): void
  reject(reason: unknown): void
  signal?: AbortSignal
  onAbort?: () => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isConnectionLoss(error: unknown, connection: McpConnection): boolean {
  if (connection.isClosed()) return true
  if (SdkError.isInstance(error) && error.code === SdkErrorCode.ConnectionClosed) return true
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && [
      'ECONNABORTED',
      'ECONNREFUSED',
      'ECONNRESET',
      'EPIPE',
      'ERR_STREAM_DESTROYED',
      'UND_ERR_SOCKET',
    ].includes(code)) return true
  }
  return /(?:connection|transport|stream|socket) (?:is )?(?:closed|disconnected|destroyed|terminated)|not connected|broken pipe|socket hang up|fetch failed/i
    .test(errorMessage(error))
}

function immutableSnapshot(snapshot: McpServerSnapshot): McpServerSnapshot {
  const tools = Object.freeze(snapshot.tools.map((tool) => Object.freeze({
    ...tool,
    inputSchema: Object.freeze({ ...tool.inputSchema }),
    annotations: tool.annotations ? Object.freeze({ ...tool.annotations }) : undefined,
  })))
  return Object.freeze({ ...snapshot, tools: tools as McpServerSnapshot['tools'] })
}

function snapshotFromCache(server: EffectiveMcpServer, cached: SafeMcpCatalog): McpServerSnapshot {
  return immutableSnapshot({
    server: server.name,
    protocolVersion: cached.protocolVersion,
    tools: cached.tools.map((tool) => ({ ...tool, inputSchema: { ...tool.inputSchema } })),
    fetchedAt: cached.fetchedAt,
    configFingerprint: configFingerprint(server.config),
  })
}

function catalogFingerprint(snapshot: McpServerSnapshot): string {
  return stableFingerprint(snapshot.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })))
}

function abortSignal(signal: AbortSignal | undefined, runtimeSignal: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, runtimeSignal]) : runtimeSignal
}

function waitForCaller<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  return Promise.race([promise, aborted]).finally(() => {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  })
}

export class McpServerRuntime {
  readonly key: SessionServerRuntimeKey

  private state: McpRuntimeState
  private epoch = 0
  private connection?: McpConnection
  private unsubscribeConnectionClose?: () => void
  private connecting?: { epoch: number; promise: Promise<void> }
  private candidate?: McpCatalogCandidate
  private catalogDrift = false
  private error?: { code: string; summary: string; retryable: boolean }
  private released = false
  private retrying?: Promise<void>
  private readonly closeController = new AbortController()
  private readonly listeners = new Set<() => void>()
  private queueHeld = false
  private readonly queue: ToolCallWaiter[] = []

  constructor(
    readonly sessionRuntimeId: string,
    readonly server: EffectiveMcpServer,
    private readonly cache: McpCatalogCache,
    dormant = false,
    private readonly connector: McpConnector = connectAndDiscoverMcpServer,
  ) {
    this.key = sessionServerRuntimeKey(sessionRuntimeId, server)
    const cached = cache.get(server)
    if (cached) {
      const snapshot = snapshotFromCache(server, cached)
      this.candidate = Object.freeze({
        key: this.key,
        epoch: 0,
        server,
        snapshot,
        source: 'cache',
        catalogFingerprint: cached.catalogFingerprint,
      })
    }
    this.state = dormant && cached ? 'dormant' : 'not_started'
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  catalog(): McpCatalogCandidate | undefined {
    return this.candidate
  }

  currentState(): McpRuntimeState {
    return this.state
  }

  currentEpoch(): number {
    return this.epoch
  }

  start(): Promise<void> {
    if (this.released) return Promise.reject(new Error(`MCP runtime for "${this.server.name}" is released`))
    if (this.retrying) return this.retrying
    if (this.connection && !this.connection.isClosed() && this.state === 'ready') {
      return Promise.resolve()
    }
    if (this.connecting) return this.connecting.promise
    return this.beginConnection()
  }

  waitForStartup(): Promise<void> | undefined {
    return this.connecting?.promise
  }

  retry(): Promise<void> {
    if (this.released) throw new Error(`MCP runtime for "${this.server.name}" is released`)
    if (this.retrying) return this.retrying
    const retrying = (async () => {
      const old = this.connection
      this.connection = undefined
      this.clearConnectionCloseListener()
      this.connecting = undefined
      if (old) await old.close().catch(() => undefined)
      if (this.released) return
      await this.beginConnection()
    })()
    const wrapped = retrying.finally(() => {
      if (this.retrying === wrapped) this.retrying = undefined
    })
    this.retrying = wrapped
    return wrapped
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown> | undefined,
    options: McpServerCallOptions = {},
  ): Promise<CallToolResult> {
    const releaseSlot = await this.acquireCallSlot(options.signal)
    let connection: McpConnection | undefined
    let callEpoch = 0
    try {
      await waitForCaller(this.start(), options.signal)
      connection = this.connection
      callEpoch = this.epoch
      if (!connection || connection.isClosed()) {
        throw new McpConnectionLostError(this.server.name, toolName, 'connection unavailable')
      }
      connection.setElicitationSink(options.elicitationSink)
      const timeout = toolTimeoutMs(this.server.config)
      const result = await connection.client.callTool(
        { name: toolName, arguments: args },
        { timeout, signal: abortSignal(options.signal, this.closeController.signal) },
      )
      return result
    } catch (error) {
      const message = errorMessage(error)
      if (isMcpAbortError(error, options.signal)) throw options.signal?.reason ?? error
      if (connection && /timeout|timed out/i.test(message)) {
        const timeout = toolTimeoutMs(this.server.config)
        const safeMessage = sanitizeMcpErrorText(error, { server: this.server, maxLength: 2_048 })
        throw new Error(
          `MCP tool "${toolName}"（server "${this.server.name}"）调用超时（${timeout / 1000}s）：${safeMessage}。`
          + `可在配置中调大超时，例如 {"mcpServers": {"${this.server.name}": {"tool_timeout_sec": ${Math.max(600, timeout / 1000 * 2)}}}}`,
        )
      }
      if (connection && isConnectionLoss(error, connection)) {
        await this.markConnectionLost(callEpoch, connection, message)
        throw new McpConnectionLostError(
          this.server.name,
          toolName,
          error,
          sanitizeMcpErrorText(error, { server: this.server, maxLength: 2_048 }),
        )
      }
      throw error
    } finally {
      connection?.setElicitationSink(undefined)
      releaseSlot()
    }
  }

  view(published = false, settled = false): AgentMcpServerView {
    return {
      name: this.server.name,
      state: this.state,
      transport: this.server.transport,
      origin: this.server.origin,
      toolCount: this.candidate?.snapshot.tools.length,
      catalogSource: this.candidate?.source,
      catalogDrift: this.catalogDrift || undefined,
      published,
      appliesAt: this.candidate && !published && !settled ? 'next-boundary' : undefined,
      errorCode: this.error?.code,
      errorSummary: this.error?.summary,
      retryable: this.error?.retryable,
    }
  }

  async close(): Promise<void> {
    if (this.released) return
    this.released = true
    this.epoch += 1
    this.closeController.abort(new Error(`MCP session runtime ${this.sessionRuntimeId} released`))
    this.rejectQueued(this.closeController.signal.reason)
    const connection = this.connection
    const connecting = this.connecting
    this.connection = undefined
    this.clearConnectionCloseListener()
    this.connecting = undefined
    this.state = 'not_started'
    this.emit()
    if (connection) await connection.close()
    // The close signal normally cancels connect/listTools immediately. A non-conforming injected
    // connector is fenced by epoch and closes its late transport without delaying Agent teardown.
    if (connecting) void connecting.promise.catch(() => undefined)
  }

  private beginConnection(): Promise<void> {
    const epoch = ++this.epoch
    this.error = undefined
    this.state = epoch > 1 ? 'reconnecting' : 'starting'
    this.emit()

    const promise = Promise.resolve()
      .then(() => this.connector(this.server, { signal: this.closeController.signal }))
      .then(async ({ connection, snapshot }) => {
        try {
          if (this.released || this.epoch !== epoch) {
            await connection.close()
            return
          }
          const frozen = immutableSnapshot(snapshot)
          const previousFingerprint = this.candidate?.catalogFingerprint
          const nextFingerprint = catalogFingerprint(frozen)
          this.connection = connection
          this.unsubscribeConnectionClose = connection.onClose?.(() => {
            this.handleConnectionClosed(epoch, connection)
          })
          if (connection.isClosed() || this.connection !== connection) {
            throw new Error(`MCP server "${this.server.name}" connection closed during discovery`)
          }
          this.candidate = Object.freeze({
            key: this.key,
            epoch,
            server: this.server,
            snapshot: frozen,
            source: 'live',
            catalogFingerprint: nextFingerprint,
          })
          this.catalogDrift = previousFingerprint !== undefined && previousFingerprint !== nextFingerprint
          this.cache.set(this.server, frozen)
          this.state = 'ready'
          this.error = undefined
          this.emit()
        } catch (error) {
          if (this.connection === connection) {
            this.connection = undefined
            this.clearConnectionCloseListener()
          }
          await connection.close().catch(() => undefined)
          throw error
        }
      })
      .catch((error: unknown) => {
        if (!this.released && this.epoch === epoch) {
          this.state = 'failed'
          this.error = {
            code: 'MCP_START_FAILED',
            summary: sanitizeMcpErrorText(error, { server: this.server, maxLength: 512 }),
            retryable: true,
          }
          this.emit()
        }
        throw error
      })
      .finally(() => {
        if (this.connecting?.epoch === epoch) this.connecting = undefined
      })
    this.connecting = { epoch, promise }
    return promise
  }

  private async markConnectionLost(
    epoch: number,
    connection: McpConnection,
    summary: string,
  ): Promise<void> {
    if (this.epoch !== epoch || this.connection !== connection) return
    this.connection = undefined
    this.clearConnectionCloseListener()
    this.state = 'failed'
    this.error = {
      code: 'MCP_CONNECTION_LOST',
      summary: sanitizeMcpErrorText(summary, { server: this.server, maxLength: 512 }),
      retryable: true,
    }
    this.emit()
    await connection.close()
  }

  private handleConnectionClosed(epoch: number, connection: McpConnection): void {
    if (this.released || this.epoch !== epoch || this.connection !== connection) return
    this.connection = undefined
    this.clearConnectionCloseListener()
    this.state = 'failed'
    this.error = {
      code: 'MCP_CONNECTION_LOST',
      summary: `MCP server "${this.server.name}" connection closed`,
      retryable: true,
    }
    this.emit()
  }

  private clearConnectionCloseListener(): void {
    this.unsubscribeConnectionClose?.()
    this.unsubscribeConnectionClose = undefined
  }

  private acquireCallSlot(signal?: AbortSignal): Promise<() => void> {
    if (this.released) return Promise.reject(new Error(`MCP runtime for "${this.server.name}" is released`))
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (!this.queueHeld) {
      this.queueHeld = true
      return Promise.resolve(this.releaseCallSlot())
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: ToolCallWaiter = { resolve, reject, signal }
      if (signal) {
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter)
          if (index >= 0) this.queue.splice(index, 1)
          reject(signal.reason)
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.queue.push(waiter)
    })
  }

  private releaseCallSlot(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.queue.shift()
      if (next) {
        if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort)
        next.resolve(this.releaseCallSlot())
        return
      }
      this.queueHeld = false
    }
  }

  private rejectQueued(reason: unknown): void {
    for (const waiter of this.queue.splice(0)) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
      waiter.reject(reason)
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
