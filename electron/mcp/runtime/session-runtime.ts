import type { CallToolResult } from '@modelcontextprotocol/client'

import type {
  AgentMcpServerView,
  AgentMcpView,
  EffectiveMcpServer,
  McpRuntimeOwnerKind,
  McpSessionRuntimeSummary,
} from '@shared/types/mcp.js'
import type { McpElicitationSink } from '../client/connection.js'
import type { McpCatalogCache } from './catalog-cache.js'
import type { McpCapabilitySnapshot } from './capability.js'
import { launchFingerprint } from './identity.js'
import {
  McpServerRuntime,
  type McpCatalogCandidate,
  type McpConnector,
} from './server-runtime.js'

export interface McpProjectionViewInput {
  revision?: number
  publishedServers?: ReadonlySet<string> | readonly string[]
  settledServers?: ReadonlySet<string> | readonly string[]
}

export interface McpSessionCallOptions {
  signal?: AbortSignal
  elicitationSink?: McpElicitationSink
}

export interface McpSessionRuntimeHandle {
  readonly sessionRuntimeId: string
  readonly capability: McpCapabilitySnapshot
  readonly ownerId: string
  readonly ownerKind: McpRuntimeOwnerKind
  readonly ownerLabel?: string
  startAll(): void
  waitForInitialGrace(timeoutMs: number, signal?: AbortSignal): Promise<void>
  catalogs(): readonly McpCatalogCandidate[]
  call(
    server: string,
    tool: string,
    args: Record<string, unknown> | undefined,
    options?: McpSessionCallOptions,
  ): Promise<CallToolResult>
  callTool(
    server: EffectiveMcpServer | string,
    tool: string,
    args: Record<string, unknown> | undefined,
    options?: McpSessionCallOptions,
  ): Promise<CallToolResult>
  view(input?: McpProjectionViewInput): AgentMcpView
  onChange(listener: () => void): () => void
  retry(serverNames?: readonly string[], signal?: AbortSignal): Promise<void>
  release(): Promise<void>
}

export interface McpSessionRuntimeOptions {
  sessionRuntimeId: string
  ownerId: string
  ownerKind: McpRuntimeOwnerKind
  ownerLabel?: string
  capability: McpCapabilitySnapshot
  cache: McpCatalogCache
  connector?: McpConnector
  dormant?: boolean | readonly string[]
  onReleased?: (sessionRuntimeId: string) => void
}

function nameSet(input?: ReadonlySet<string> | readonly string[]): ReadonlySet<string> {
  if (input instanceof Set) return input
  return new Set(input ?? [])
}

function waitForAbort(signal: AbortSignal): { promise: Promise<never>; dispose(): void } {
  if (signal.aborted) {
    return { promise: Promise.reject(signal.reason), dispose: () => undefined }
  }
  let onAbort: (() => void) | undefined
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  return {
    promise,
    dispose: () => {
      if (onAbort) signal.removeEventListener('abort', onAbort)
    },
  }
}

export class McpSessionRuntime implements McpSessionRuntimeHandle {
  readonly sessionRuntimeId: string
  readonly capability: McpCapabilitySnapshot

  private mutableOwnerId: string
  private mutableOwnerKind: McpRuntimeOwnerKind
  private mutableOwnerLabel?: string
  private readonly runtimes = new Map<string, McpServerRuntime>()
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribeServers: Array<() => void> = []
  private startedAt?: string
  private released = false
  private releasePromise?: Promise<void>

  constructor(private readonly options: McpSessionRuntimeOptions) {
    this.sessionRuntimeId = options.sessionRuntimeId
    this.capability = options.capability
    this.mutableOwnerId = options.ownerId
    this.mutableOwnerKind = options.ownerKind
    this.mutableOwnerLabel = options.ownerLabel
    const dormantNames = Array.isArray(options.dormant) ? new Set(options.dormant) : undefined
    for (const server of this.capability.servers) {
      const dormant = options.dormant === true || dormantNames?.has(server.name) === true
      const runtime = new McpServerRuntime(
        this.sessionRuntimeId,
        server,
        options.cache,
        dormant,
        options.connector,
      )
      this.runtimes.set(server.name, runtime)
      this.unsubscribeServers.push(runtime.onChange(() => this.emit()))
    }
  }

  get ownerId(): string {
    return this.mutableOwnerId
  }

  get ownerKind(): McpRuntimeOwnerKind {
    return this.mutableOwnerKind
  }

  get ownerLabel(): string | undefined {
    return this.mutableOwnerLabel
  }

  /** Manager-only ownership transfer used by one-shot composer adoption. */
  adoptOwner(input: {
    ownerId: string
    ownerKind: McpRuntimeOwnerKind
    ownerLabel?: string
  }): void {
    if (this.released) throw new Error(`MCP session runtime "${this.sessionRuntimeId}" is released`)
    this.mutableOwnerId = input.ownerId
    this.mutableOwnerKind = input.ownerKind
    this.mutableOwnerLabel = input.ownerLabel
    this.emit()
  }

  startAll(): void {
    this.assertActive()
    if (!this.startedAt) this.startedAt = new Date().toISOString()
    for (const runtime of this.runtimes.values()) {
      if (runtime.currentState() === 'dormant') continue
      void runtime.start().catch(() => undefined)
    }
    this.emit()
  }

  async waitForInitialGrace(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    this.assertActive()
    this.startAll()
    const pending = [...this.runtimes.values()]
      .filter((runtime) => runtime.catalog()?.source !== 'cache')
      .map((runtime) => runtime.waitForStartup())
      .filter((promise): promise is Promise<void> => promise !== undefined)
    if (pending.length === 0) return
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, timeoutMs))
      timer.unref?.()
    })
    const waits: Array<Promise<unknown>> = [Promise.allSettled(pending), timeout]
    const abort = signal ? waitForAbort(signal) : undefined
    if (abort) waits.push(abort.promise)
    try {
      await Promise.race(waits)
    } finally {
      if (timer) clearTimeout(timer)
      abort?.dispose()
    }
  }

  catalogs(): readonly McpCatalogCandidate[] {
    const candidates: McpCatalogCandidate[] = []
    for (const server of this.capability.servers) {
      const candidate = this.runtimes.get(server.name)?.catalog()
      if (candidate) candidates.push(candidate)
    }
    return Object.freeze(candidates)
  }

  async call(
    serverName: string,
    tool: string,
    args: Record<string, unknown> | undefined,
    options: McpSessionCallOptions = {},
  ): Promise<CallToolResult> {
    this.assertActive()
    const runtime = this.runtimes.get(serverName)
    if (!runtime) {
      throw new Error(
        `MCP server "${serverName}" is outside session runtime "${this.sessionRuntimeId}" capability`,
      )
    }
    return runtime.callTool(tool, args, options)
  }

  callTool(
    server: EffectiveMcpServer | string,
    tool: string,
    args: Record<string, unknown> | undefined,
    options: McpSessionCallOptions = {},
  ): Promise<CallToolResult> {
    const name = typeof server === 'string' ? server : server.name
    if (typeof server !== 'string') {
      const owned = this.runtimes.get(name)
      if (!owned || owned.key.launchFingerprint !== launchFingerprint(server)) {
        throw new Error(`MCP server "${name}" does not match this session capability snapshot`)
      }
    }
    return this.call(name, tool, args, options)
  }

  view(input?: McpProjectionViewInput): AgentMcpView {
    const published = nameSet(input?.publishedServers)
    const settled = nameSet(input?.settledServers)
    const servers: AgentMcpServerView[] = []
    for (const server of this.capability.servers) {
      const runtime = this.runtimes.get(server.name)
      if (runtime) {
        servers.push(Object.freeze(runtime.view(
          published.has(server.name),
          settled.has(server.name),
        )))
      }
    }
    for (const diagnostic of this.capability.blocked) {
      servers.push(Object.freeze({
        name: diagnostic.server,
        state: 'blocked',
        transport: diagnostic.transport,
        origin: diagnostic.origin,
        published: false,
        errorCode: diagnostic.reason === 'untrusted' ? 'MCP_UNTRUSTED' : 'MCP_INVALID_CONFIG',
        errorSummary: diagnostic.message,
        retryable: false,
      }))
    }
    const count = (state: AgentMcpServerView['state']): number =>
      servers.filter((server) => server.state === state).length
    return Object.freeze({
      sessionRuntimeId: this.sessionRuntimeId,
      startedAt: this.startedAt,
      total: servers.length,
      ready: count('ready'),
      starting: count('starting') + count('reconnecting'),
      dormant: count('dormant'),
      failed: count('failed'),
      blocked: count('blocked'),
      projectionRevision: input?.revision ?? 0,
      servers: Object.freeze(servers),
    })
  }

  summary(input?: McpProjectionViewInput): McpSessionRuntimeSummary {
    return Object.freeze({
      ...this.view(input),
      ownerId: this.ownerId,
      ownerKind: this.ownerKind,
      ownerLabel: this.ownerLabel,
      projectContextId: this.capability.projectContextId,
      workspace: this.capability.workspace,
    })
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async retry(serverNames?: readonly string[], signal?: AbortSignal): Promise<void> {
    this.assertActive()
    const selected = serverNames ? new Set(serverNames) : undefined
    const runtimes = [...this.runtimes.values()]
      .filter((runtime) => !selected || selected.has(runtime.server.name))
    for (const name of selected ?? []) {
      if (!this.runtimes.has(name)) throw new Error(`Unknown MCP server "${name}" in this session`)
    }
    await Promise.all(runtimes.map(async (runtime) => {
      if (signal?.aborted) throw signal.reason
      await runtime.retry()
    }))
  }

  release(): Promise<void> {
    if (this.releasePromise) return this.releasePromise
    this.released = true
    this.releasePromise = (async () => {
      const results = await Promise.allSettled(
        [...this.runtimes.values()].map((runtime) => runtime.close()),
      )
      for (const unsubscribe of this.unsubscribeServers.splice(0)) unsubscribe()
      this.listeners.clear()
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failures.length > 0) {
        throw new AggregateError(failures.map((failure) => failure.reason), 'Failed to close MCP session runtime')
      }
      this.options.onReleased?.(this.sessionRuntimeId)
    })()
    return this.releasePromise
  }

  private assertActive(): void {
    if (this.released) throw new Error(`MCP session runtime "${this.sessionRuntimeId}" is released`)
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
