import type { MarketEntry, MarketSource } from '@shared/types/market.js'
import type { McpServerConfig } from '@shared/types/mcp.js'

export interface McpRegistryFetchResult {
  entries: MarketEntry[]
  removedNames: string[]
  etag?: string
  notModified?: boolean
  warnings: string[]
}

export const MCP_REGISTRY_CACHE_REVISION = 'v0.1-latest-v1'
const REGISTRY_API_PATH = '/v0.1/servers'
const REGISTRY_PAGE_SIZE = 100
const MAX_REGISTRY_PAGES = 500
const REGISTRY_REQUEST_TIMEOUT_MS = 15_000

export async function fetchMcpRegistrySource(
  source: MarketSource,
  options: {
    etag?: string
    updatedSince?: string
    fetcher?: typeof fetch
    requestTimeoutMs?: number
  } = {},
): Promise<McpRegistryFetchResult> {
  const fetcher = options.fetcher ?? fetch
  const entries: MarketEntry[] = []
  const removedNames = new Set<string>()
  const warnings: string[] = []
  let skippedCount = 0
  let cursor: string | undefined
  let etag: string | undefined
  const seenCursors = new Set<string>()
  for (let page = 0; page < MAX_REGISTRY_PAGES; page++) {
    const url = new URL(REGISTRY_API_PATH, source.url)
    url.searchParams.set('limit', String(REGISTRY_PAGE_SIZE))
    url.searchParams.set('version', 'latest')
    if (options.updatedSince) url.searchParams.set('updated_since', options.updatedSince)
    if (cursor) url.searchParams.set('cursor', cursor)
    const timeout = options.requestTimeoutMs ?? REGISTRY_REQUEST_TIMEOUT_MS
    let response: Response
    try {
      response = await fetcher(url, {
        headers: {
          accept: 'application/json',
          ...(page === 0 && options.etag ? { 'if-none-match': options.etag } : {}),
        },
        signal: AbortSignal.timeout(timeout),
      })
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new Error(`MCP Registry 第 ${page + 1} 页请求超过 ${timeout / 1000} 秒`)
      }
      throw error
    }
    if (response.status === 304 && page === 0) {
      return { entries: [], removedNames: [], etag: options.etag, notModified: true, warnings }
    }
    if (!response.ok) throw new Error(`MCP Registry 响应 ${response.status} ${response.statusText}`)
    etag ??= response.headers.get('etag') ?? undefined
    const body = await response.json() as Record<string, unknown>
    const rawServers = Array.isArray(body.servers) ? body.servers : []
    for (const raw of rawServers) {
      const name = registryServerName(raw)
      if (name && registryServerDeleted(raw)) {
        removedNames.add(name)
        continue
      }
      const projected = projectRegistryEntry(source, raw)
      if (projected) {
        entries.push(projected)
        removedNames.delete(projected.name)
      } else {
        skippedCount += 1
        if (name) removedNames.add(name)
      }
    }
    const next = nextCursor(body)
    if (next && seenCursors.has(next)) {
      warnings.push(`MCP Registry 返回重复游标 ${next}，已停止分页以避免循环`)
      cursor = undefined
      break
    }
    if (next) seenCursors.add(next)
    cursor = next
    if (!cursor || rawServers.length === 0) break
  }
  if (cursor) {
    warnings.push(`MCP Registry 超过 ${MAX_REGISTRY_PAGES * REGISTRY_PAGE_SIZE} 条 latest 记录，目录已在安全上限处截断`)
  }
  if (skippedCount > 0) {
    warnings.push(`MCP Registry 有 ${skippedCount} 条 server 缺少受支持的传输配置，已忽略`)
  }
  return {
    entries: dedupeEntries(entries),
    removedNames: [...removedNames],
    etag,
    warnings,
  }
}

function registryEnvelope(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  return raw as Record<string, unknown>
}

function registryServerName(raw: unknown): string | undefined {
  const envelope = registryEnvelope(raw)
  if (!envelope) return undefined
  const server = envelope.server && typeof envelope.server === 'object' && !Array.isArray(envelope.server)
    ? envelope.server as Record<string, unknown>
    : envelope
  return typeof server.name === 'string' ? server.name : undefined
}

function registryServerDeleted(raw: unknown): boolean {
  const envelope = registryEnvelope(raw)
  const meta = envelope?._meta && typeof envelope._meta === 'object' && !Array.isArray(envelope._meta)
    ? envelope._meta as Record<string, unknown>
    : undefined
  const official = meta?.['io.modelcontextprotocol.registry/official']
  if (!official || typeof official !== 'object' || Array.isArray(official)) return false
  return (official as Record<string, unknown>).status === 'deleted'
}

function projectRegistryEntry(source: MarketSource, raw: unknown): MarketEntry | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const envelope = raw as Record<string, unknown>
  const server = envelope.server && typeof envelope.server === 'object' && !Array.isArray(envelope.server)
    ? envelope.server as Record<string, unknown>
    : envelope
  const name = typeof server.name === 'string' ? server.name : undefined
  if (!name) return undefined
  const version = typeof server.version === 'string' ? server.version : undefined
  const config = registryConfig(server)
  if (!config) return undefined
  return {
    id: `${source.id}:mcp:${encodeURIComponent(name)}${version ? `@${encodeURIComponent(version)}` : ''}`,
    kind: 'mcp',
    name,
    description: typeof server.description === 'string' ? server.description : '',
    sourceId: source.id,
    sourceName: source.name,
    sourceUrl: source.url,
    installSource: `registry:${name}${version ? `@${version}` : ''}`,
    version,
    license: typeof server.license === 'string' ? server.license : undefined,
    projectedTokens: 0,
    mcpConfig: config,
  }
}

function registryConfig(server: Record<string, unknown>): McpServerConfig | undefined {
  const remotes = Array.isArray(server.remotes) ? server.remotes : []
  for (const value of remotes) {
    if (!value || typeof value !== 'object') continue
    const remote = value as Record<string, unknown>
    const url = typeof remote.url === 'string' ? remote.url : undefined
    const transport = String(remote.type ?? remote.transport ?? remote.transportType ?? '').toLowerCase()
    if (url && !transport.includes('sse')) return { url }
  }

  const packages = Array.isArray(server.packages) ? server.packages : []
  for (const value of packages) {
    if (!value || typeof value !== 'object') continue
    const pkg = value as Record<string, unknown>
    const registryType = String(pkg.registryType ?? pkg.registry ?? pkg.type ?? '').toLowerCase()
    const identifier = typeof pkg.identifier === 'string'
      ? pkg.identifier
      : typeof pkg.name === 'string'
        ? pkg.name
        : undefined
    if (!identifier) continue
    const version = typeof pkg.version === 'string' && pkg.version ? `@${pkg.version}` : ''
    const packageArguments = Array.isArray(pkg.packageArguments)
      ? pkg.packageArguments.map(argumentValue).filter((item): item is string => item !== undefined)
      : []
    if (registryType.includes('npm')) return { command: 'npx', args: ['-y', `${identifier}${version}`, ...packageArguments] }
    if (registryType.includes('pypi') || registryType.includes('python')) {
      return { command: 'uvx', args: [`${identifier}${version}`, ...packageArguments] }
    }
    if (registryType.includes('oci') || registryType.includes('docker')) {
      return { command: 'docker', args: ['run', '--rm', '-i', `${identifier}${version}`, ...packageArguments] }
    }
  }
  return undefined
}

function argumentValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  if (typeof item.value === 'string') return item.value
  if (typeof item.name === 'string') return item.name
  return undefined
}

function nextCursor(body: Record<string, unknown>): string | undefined {
  const metadata = body.metadata && typeof body.metadata === 'object'
    ? body.metadata as Record<string, unknown>
    : undefined
  for (const value of [body.nextCursor, body.next_cursor, metadata?.nextCursor, metadata?.next_cursor]) {
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

function dedupeEntries(entries: MarketEntry[]): MarketEntry[] {
  const map = new Map<string, MarketEntry>()
  for (const entry of entries) map.set(entry.id, entry)
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}
