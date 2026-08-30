import type { EffectiveMcpServer, McpServerSnapshot, McpToolDescriptor } from '@shared/types/mcp.js'
import { configFingerprint } from '../bridge/snapshot.js'
import { launchFingerprint, stableFingerprint } from './identity.js'

export interface SafeMcpCatalog {
  readonly server: string
  readonly launchFingerprint: string
  readonly protocolVersion?: string
  readonly tools: readonly McpToolDescriptor[]
  readonly fetchedAt: string
  readonly catalogFingerprint: string
}

export interface McpCatalogCacheOptions {
  ttlMs?: number
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}

function safeTools(tools: readonly McpToolDescriptor[]): readonly McpToolDescriptor[] {
  return Object.freeze(tools.map((tool) => Object.freeze({
    name: tool.name,
    description: tool.description,
    inputSchema: deepFreeze(structuredClone(tool.inputSchema)),
    // Runtime-sensitive annotations are deliberately not shared across sessions.
  })))
}

export class McpCatalogCache {
  private readonly ttlMs: number
  private readonly entries = new Map<string, SafeMcpCatalog>()

  constructor(options: McpCatalogCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60_000
  }

  get(server: EffectiveMcpServer): SafeMcpCatalog | undefined {
    // HTTP auth/session identity cannot yet be proven stable enough for cross-session reuse.
    if (server.transport !== 'stdio') return undefined
    const key = launchFingerprint(server)
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (Date.now() - Date.parse(entry.fetchedAt) > this.ttlMs) {
      this.entries.delete(key)
      return undefined
    }
    return entry
  }

  /** Returns a frozen model-safe snapshot without exposing the mutable cache entry map. */
  snapshot(server: EffectiveMcpServer): McpServerSnapshot | undefined {
    const entry = this.get(server)
    if (!entry) return undefined
    return Object.freeze({
      server: server.name,
      protocolVersion: entry.protocolVersion,
      tools: entry.tools as McpServerSnapshot['tools'],
      fetchedAt: entry.fetchedAt,
      configFingerprint: configFingerprint(server.config),
    })
  }

  set(server: EffectiveMcpServer, snapshot: McpServerSnapshot): SafeMcpCatalog | undefined {
    if (server.transport !== 'stdio') return undefined
    const fingerprint = launchFingerprint(server)
    const tools = safeTools(snapshot.tools)
    const entry: SafeMcpCatalog = Object.freeze({
      server: server.name,
      launchFingerprint: fingerprint,
      protocolVersion: snapshot.protocolVersion,
      tools,
      fetchedAt: snapshot.fetchedAt,
      catalogFingerprint: stableFingerprint(tools),
    })
    this.entries.set(fingerprint, entry)
    return entry
  }

  invalidate(server: EffectiveMcpServer): void {
    this.entries.delete(launchFingerprint(server))
  }

  clear(): void {
    this.entries.clear()
  }
}
