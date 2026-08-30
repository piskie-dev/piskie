import { createUuid } from '@shared/utils/identifiers.js';


import type {
  AgentMcpView,
  EffectiveMcpServer,
  McpServerSnapshot,
  McpRuntimeOwnerKind,
  McpSessionRuntimeSummary,
} from '@shared/types/mcp.js'
import { McpCatalogCache } from './catalog-cache.js'
import {
  capabilityFromServers,
  narrowMcpCapability,
  resolveMcpCapability,
  type McpCapabilitySnapshot,
} from './capability.js'
import { createSessionRuntimeId } from './identity.js'
import {
  McpSessionRuntime,
  type McpSessionRuntimeHandle,
  type McpSessionRuntimeOptions,
} from './session-runtime.js'
import type { McpConnector } from './server-runtime.js'

export interface CreateMcpSessionInput {
  sessionRuntimeId?: string
  ownerId: string
  ownerKind?: McpRuntimeOwnerKind
  /** Compatibility alias while callers migrate to ownerKind. */
  ownerType?: McpRuntimeOwnerKind
  ownerLabel?: string
  projectContextId?: string
  workspace?: string
  selection?: readonly string[]
  contextWindowTokens?: number
  parentCapability?: McpCapabilitySnapshot
  capability?: McpCapabilitySnapshot
  servers?: readonly EffectiveMcpServer[]
  dormant?: boolean | readonly string[]
}

export interface McpCapabilityRequest {
  workspace?: string
  selection?: readonly string[]
  contextWindowTokens?: number
  ownerLabel?: string
  ttlMs?: number
  capability?: McpCapabilitySnapshot
  servers?: readonly EffectiveMcpServer[]
}

export interface McpComposerRuntimeLease {
  readonly token: string
  readonly sessionRuntimeId: string
  readonly projectContextId: string
  readonly view: AgentMcpView
}

export interface McpSessionQuery {
  projectContextId?: string
  workspace?: string
  serverName?: string
  ownerKind?: McpRuntimeOwnerKind
}

interface PrewarmEntry {
  readonly token: string
  readonly runtime: McpSessionRuntime
  readonly timer: NodeJS.Timeout
  consumed: boolean
}

export interface McpConnectionManagerOptions {
  catalogCache?: McpCatalogCache
  prewarmTtlMs?: number
  connector?: McpConnector
}

export function equalMcpCapabilities(
  left: McpCapabilitySnapshot,
  right: McpCapabilitySnapshot,
): boolean {
  return left.fingerprint === right.fingerprint
}

export class McpConnectionManager {
  private readonly catalogCache: McpCatalogCache
  private readonly prewarmTtlMs: number
  private readonly runtimes = new Map<string, McpSessionRuntime>()
  private readonly prewarms = new Map<string, PrewarmEntry>()
  private disposed = false

  constructor(private readonly options: McpConnectionManagerOptions = {}) {
    this.catalogCache = options.catalogCache ?? new McpCatalogCache()
    this.prewarmTtlMs = options.prewarmTtlMs ?? 2 * 60_000
  }

  async createSession(input: CreateMcpSessionInput): Promise<McpSessionRuntimeHandle> {
    this.assertActive()
    const capability = await this.capabilityFor(input)
    this.assertActive()
    return this.createRuntime(input, capability)
  }

  async prewarm(request: McpCapabilityRequest): Promise<McpComposerRuntimeLease> {
    this.assertActive()
    // Always cross the capability-resolution boundary before registration. This keeps the
    // post-resolution disposed check effective even when the caller supplies a ready snapshot.
    const capability = await Promise.resolve(request.capability
      ? narrowMcpCapability(request.capability, request.selection)
      : request.servers
        ? capabilityFromServers({
            workspace: request.workspace,
            servers: request.selection === undefined
              ? request.servers
              : request.servers.filter((server) => new Set(request.selection).has(server.name)),
          })
        : resolveMcpCapability(request))
    this.assertActive()
    const token = `mcp-prewarm-${createUuid()}`
    const runtime = this.createRuntime({
      ownerId: token,
      ownerKind: 'composer',
      ownerLabel: request.ownerLabel,
      workspace: capability.workspace,
      capability,
    }, capability)
    runtime.startAll()
    const ttl = Math.max(1, request.ttlMs ?? this.prewarmTtlMs)
    const timer = setTimeout(() => {
      const entry = this.prewarms.get(token)
      if (!entry || entry.consumed) return
      entry.consumed = true
      this.prewarms.delete(token)
      void entry.runtime.release().catch(() => undefined)
    }, ttl)
    timer.unref?.()
    this.prewarms.set(token, { token, runtime, timer, consumed: false })
    return Object.freeze({
      token,
      sessionRuntimeId: runtime.sessionRuntimeId,
      projectContextId: capability.projectContextId,
      view: runtime.view(),
    })
  }

  statusByPrewarmToken(token: string): AgentMcpView | undefined {
    const entry = this.prewarms.get(token)
    return entry && !entry.consumed ? entry.runtime.view() : undefined
  }

  async adoptPrewarm(
    token: string,
    input: CreateMcpSessionInput,
  ): Promise<McpSessionRuntimeHandle | null> {
    this.assertActive()
    const entry = this.prewarms.get(token)
    if (!entry || entry.consumed) return null
    entry.consumed = true
    clearTimeout(entry.timer)
    this.prewarms.delete(token)

    let target: McpCapabilitySnapshot
    try {
      target = await this.capabilityFor(input)
      this.assertActive()
    } catch (error) {
      await entry.runtime.release().catch(() => undefined)
      throw error
    }
    if (!equalMcpCapabilities(entry.runtime.capability, target)) {
      await entry.runtime.release().catch(() => undefined)
      return null
    }
    entry.runtime.adoptOwner({
      ownerId: input.ownerId,
      ownerKind: input.ownerKind ?? input.ownerType ?? 'main',
      ownerLabel: input.ownerLabel,
    })
    return entry.runtime
  }

  async releasePrewarm(token: string): Promise<void> {
    const entry = this.prewarms.get(token)
    if (!entry || entry.consumed) return
    entry.consumed = true
    clearTimeout(entry.timer)
    this.prewarms.delete(token)
    await entry.runtime.release()
  }

  status(sessionRuntimeId: string): AgentMcpView | undefined {
    return this.runtimes.get(sessionRuntimeId)?.view()
  }

  get(sessionRuntimeId: string): McpSessionRuntimeHandle | undefined {
    return this.runtimes.get(sessionRuntimeId)
  }

  sessions(query: McpSessionQuery | string = {}): readonly McpSessionRuntimeSummary[] {
    const normalized: McpSessionQuery = typeof query === 'string'
      ? { projectContextId: query }
      : query
    const summaries = [...this.runtimes.values()]
      .filter((runtime) => {
        if (normalized.projectContextId
          && runtime.capability.projectContextId !== normalized.projectContextId) return false
        if (normalized.workspace && runtime.capability.workspace !== normalized.workspace) return false
        if (normalized.ownerKind && runtime.ownerKind !== normalized.ownerKind) return false
        if (normalized.serverName
          && !runtime.capability.servers.some((server) => server.name === normalized.serverName)
          && !runtime.capability.blocked.some((server) => server.server === normalized.serverName)) return false
        return true
      })
      .map((runtime) => runtime.summary())
    return Object.freeze(summaries)
  }

  async retry(
    sessionRuntimeId: string,
    serverNames?: readonly string[],
    signal?: AbortSignal,
  ): Promise<void> {
    const runtime = this.runtimes.get(sessionRuntimeId)
    if (!runtime) throw new Error(`Unknown MCP session runtime "${sessionRuntimeId}"`)
    await runtime.retry(serverNames, signal)
  }

  async release(sessionRuntimeId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionRuntimeId)
    if (runtime) await runtime.release()
  }

  /** Config/plugin changes invalidate only future cache reads; active runtime capability stays frozen. */
  invalidateCatalogCache(): void {
    this.catalogCache.clear()
  }

  /** Management one-shot discovery may reuse safe descriptors, never a live Session state. */
  cachedCatalog(server: EffectiveMcpServer): McpServerSnapshot | undefined {
    if (this.disposed) return undefined
    return this.catalogCache.snapshot(server)
  }

  /** One-shot probe/budget discovery may warm safe descriptors, never a live connection state. */
  rememberCatalog(server: EffectiveMcpServer, snapshot: McpServerSnapshot): void {
    this.assertActive()
    this.catalogCache.set(server, snapshot)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const entry of this.prewarms.values()) {
      entry.consumed = true
      clearTimeout(entry.timer)
    }
    this.prewarms.clear()
    const runtimes = [...this.runtimes.values()]
    const results = await Promise.allSettled(runtimes.map((runtime) => runtime.release()))
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length > 0) {
      throw new AggregateError(failures.map((failure) => failure.reason), 'Failed to dispose MCP runtimes')
    }
  }

  lifecycleSnapshot(): {
    disposed: boolean
    runtimeIds: readonly string[]
    prewarmTokens: readonly string[]
  } {
    return Object.freeze({
      disposed: this.disposed,
      runtimeIds: Object.freeze([...this.runtimes.keys()]),
      prewarmTokens: Object.freeze([...this.prewarms.keys()]),
    })
  }

  private async capabilityFor(input: CreateMcpSessionInput): Promise<McpCapabilitySnapshot> {
    let capability: McpCapabilitySnapshot
    if (input.capability) {
      capability = input.selection === undefined
        ? input.capability
        : narrowMcpCapability(input.capability, input.selection)
    } else if (input.parentCapability) {
      capability = narrowMcpCapability(input.parentCapability, input.selection)
    } else if (input.servers) {
      const selected = input.selection === undefined
        ? input.servers
        : input.servers.filter((server) => new Set(input.selection).has(server.name))
      capability = capabilityFromServers({ workspace: input.workspace, servers: selected })
    } else {
      capability = await resolveMcpCapability({
        workspace: input.workspace,
        selection: input.selection,
      })
    }
    if (input.projectContextId && input.projectContextId !== capability.projectContextId) {
      throw new Error(
        `MCP projectContextId mismatch: expected "${capability.projectContextId}", got "${input.projectContextId}"`,
      )
    }
    return capability
  }

  private createRuntime(
    input: CreateMcpSessionInput,
    capability: McpCapabilitySnapshot,
  ): McpSessionRuntime {
    const sessionRuntimeId = input.sessionRuntimeId ?? createSessionRuntimeId()
    if (this.runtimes.has(sessionRuntimeId)) {
      throw new Error(`MCP session runtime "${sessionRuntimeId}" already exists`)
    }
    const ownerKind = input.ownerKind ?? input.ownerType ?? 'main'
    const dormant = input.dormant ?? (ownerKind === 'worker'
      ? capability.servers
          .filter((server) => this.catalogCache.get(server) !== undefined)
          .map((server) => server.name)
      : undefined)
    const options: McpSessionRuntimeOptions = {
      sessionRuntimeId,
      ownerId: input.ownerId,
      ownerKind,
      ownerLabel: input.ownerLabel,
      capability,
      cache: this.catalogCache,
      connector: this.options.connector,
      dormant,
      onReleased: (releasedId) => {
        const current = this.runtimes.get(releasedId)
        if (current === runtime) this.runtimes.delete(releasedId)
      },
    }
    const runtime = new McpSessionRuntime(options)
    this.runtimes.set(sessionRuntimeId, runtime)
    return runtime
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('MCP connection manager is disposed')
  }
}

export const mcpConnectionManager = new McpConnectionManager()
