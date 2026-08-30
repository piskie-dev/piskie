import { promises as fs } from 'node:fs'
import path from 'node:path'

import type {
  MarketCatalogSyncProgress,
  MarketEntry,
  MarketSource,
  MarketSourceKind,
} from '@shared/types/market.js'

import { listPluginMarketplaceSources } from '../plugins/marketplace.js'
import {
  marketCacheIsStale,
  readMarketCache,
  refreshGitCheckout,
  writeMarketCache,
} from './cache.js'
import {
  filterGitSkillsSourceEntries,
  filterGitSkillsSourceWarnings,
  scanGitSkillsSource,
} from './sources/git-skills.js'
import {
  fetchMcpRegistrySource,
  MCP_REGISTRY_CACHE_REVISION,
} from './sources/mcp-registry.js'
import { scanPluginMarketplaceSource } from './sources/plugin-marketplace.js'

export const BUILTIN_MARKET_SOURCES: readonly MarketSource[] = [
  {
    id: 'openai-plugins',
    name: 'OpenAI Plugins',
    kind: 'openai-plugin-marketplace',
    url: 'https://github.com/openai/plugins.git',
    builtin: true,
    enabled: true,
  },
  {
    id: 'anthropic-plugins',
    name: 'Anthropic Plugins',
    kind: 'anthropic-plugin-marketplace',
    url: 'https://github.com/anthropics/claude-plugins-official.git',
    builtin: true,
    enabled: true,
  },
  {
    id: 'anthropics-skills',
    name: 'Anthropic Skills',
    kind: 'git-skills',
    url: 'https://github.com/anthropics/skills.git',
    builtin: true,
    enabled: true,
  },
  {
    id: 'openai-skills',
    name: 'OpenAI Skills',
    kind: 'git-skills',
    url: 'https://github.com/openai/skills.git',
    builtin: true,
    enabled: true,
  },
  {
    id: 'mcp-registry',
    name: 'MCP Registry',
    kind: 'mcp-registry',
    url: 'https://registry.modelcontextprotocol.io',
    builtin: true,
    enabled: true,
  },
]

const SOURCES_FILE = 'market-sources.json'

export async function listMarketSources(configRoot: string): Promise<MarketSource[]> {
  const [custom, pluginSources] = await Promise.all([
    readCustomSources(configRoot),
    listPluginMarketplaceSources(configRoot),
  ])
  const plugins: MarketSource[] = pluginSources.map((source) => ({
    id: `plugin-marketplace:${source.format}:${source.name}`,
    name: source.name,
    kind: source.format === 'openai'
      ? 'openai-plugin-marketplace'
      : 'anthropic-plugin-marketplace',
    url: source.url,
    ref: source.ref,
    builtin: false,
    enabled: true,
  }))
  const merged = [...BUILTIN_MARKET_SOURCES, ...custom, ...plugins]
  const withStatus = await Promise.all(merged.map(async (source) => {
    const cache = await readMarketCache(configRoot, source.id)
    return {
      ...source,
      lastRefreshedAt: cache?.refreshedAt,
      revision: cache?.revision,
    }
  }))
  return withStatus.sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name))
}

export async function addCustomMarketSource(
  configRoot: string,
  input: {
    name: string
    kind: Exclude<MarketSourceKind, 'openai-plugin-marketplace' | 'anthropic-plugin-marketplace'>
    url: string
    ref?: string
  },
): Promise<MarketSource> {
  const custom = await readCustomSources(configRoot)
  const idBase = input.name.trim().toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-|-$/g, '')
  if (!idBase) throw new Error('市场源名称无法生成有效 id')
  const id = `custom:${idBase}`
  if ([...BUILTIN_MARKET_SOURCES, ...custom].some((source) => source.id === id || source.url === input.url)) {
    throw new Error(`市场源已存在：${input.name}`)
  }
  const source: MarketSource = {
    id,
    name: input.name.trim(),
    kind: input.kind,
    url: input.url.trim(),
    ref: input.ref,
    builtin: false,
    enabled: true,
  }
  await writeCustomSources(configRoot, [...custom, source])
  return source
}

export async function removeCustomMarketSource(configRoot: string, id: string): Promise<void> {
  const custom = await readCustomSources(configRoot)
  if (!custom.some((source) => source.id === id)) throw new Error(`自定义市场源不存在：${id}`)
  await writeCustomSources(configRoot, custom.filter((source) => source.id !== id))
}

export async function refreshMarketSource(
  configRoot: string,
  source: MarketSource,
  options: { fetcher?: typeof fetch } = {},
): Promise<{ source: MarketSource; entries: MarketEntry[]; warnings: string[] }> {
  const previous = await readMarketCache(configRoot, source.id)
  if (source.kind === 'mcp-registry') {
    const incremental = registryCacheSupportsIncremental(previous)
    const refreshed = await fetchMcpRegistrySource(source, {
      etag: previous?.etag,
      updatedSince: incremental ? previous?.refreshedAt : undefined,
      fetcher: options.fetcher,
    })
    const entries = refreshed.notModified
      ? previous?.entries ?? []
      : incremental
        ? mergeRegistryIncrement(previous?.entries ?? [], refreshed.entries, refreshed.removedNames)
        : refreshed.entries
    const warnings = refreshed.notModified
      ? normalizeRegistryWarnings(previous?.warnings ?? [])
      : mergeRegistryWarnings(previous?.warnings ?? [], refreshed.warnings, incremental)
    await writeMarketCache(configRoot, source.id, {
      entries,
      warnings,
      etag: refreshed.etag ?? previous?.etag,
      revision: MCP_REGISTRY_CACHE_REVISION,
    })
    return { source, entries, warnings }
  }

  const { checkout, revision } = await refreshGitCheckout(configRoot, source)
  const scanned = source.kind === 'git-skills'
    ? await scanGitSkillsSource(source, checkout)
    : await scanPluginMarketplaceSource(source, checkout, configRoot)
  await writeMarketCache(configRoot, source.id, {
    entries: scanned.entries,
    warnings: scanned.warnings,
    revision,
  })
  return { source, entries: scanned.entries, warnings: scanned.warnings }
}

function registryCacheSupportsIncremental(
  cache: Awaited<ReturnType<typeof readMarketCache>>,
): boolean {
  if (!cache || cache.entries.length === 0) return false
  if (cache.revision === MCP_REGISTRY_CACHE_REVISION) return true
  const names = new Set(cache.entries.map((entry) => entry.name))
  return names.size === cache.entries.length
}

function mergeRegistryIncrement(
  previous: readonly MarketEntry[],
  changed: readonly MarketEntry[],
  removedNames: readonly string[],
): MarketEntry[] {
  const removed = new Set(removedNames)
  const byName = new Map(previous
    .filter((entry) => !removed.has(entry.name))
    .map((entry) => [entry.name, entry]))
  for (const entry of changed) byName.set(entry.name, entry)
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

function normalizeRegistryWarnings(warnings: readonly string[]): string[] {
  let skippedCount = 0
  const normalized: string[] = []
  for (const warning of warnings) {
    if (warning === 'MCP Registry 返回一条无法投影的 server，已忽略') {
      skippedCount += 1
      continue
    }
    const aggregated = warning.match(/^MCP Registry 有 (\d+) 条 server 缺少受支持的传输配置，已忽略$/)
    if (aggregated) {
      skippedCount = Math.max(skippedCount, Number(aggregated[1]))
      continue
    }
    normalized.push(warning)
  }
  if (skippedCount > 0) {
    normalized.push(`MCP Registry 有 ${skippedCount} 条 server 缺少受支持的传输配置，已忽略`)
  }
  return [...new Set(normalized)]
}

function isRegistryProjectionNotice(warning: string): boolean {
  return warning === 'MCP Registry 返回一条无法投影的 server，已忽略'
    || /^MCP Registry 有 \d+ 条 server 缺少受支持的传输配置，已忽略$/.test(warning)
}

function prefixSourceWarning(source: MarketSource, warning: string): string {
  return warning.startsWith(`${source.name} `) || warning.startsWith(`${source.name}:`)
    ? warning
    : `${source.name}: ${warning}`
}

function mergeRegistryWarnings(
  previous: readonly string[],
  current: readonly string[],
  incremental: boolean,
): string[] {
  const baseline = incremental ? normalizeRegistryWarnings(previous) : []
  return normalizeRegistryWarnings([...baseline, ...current])
}

export async function loadMarketCatalog(configRoot: string): Promise<{
  sources: MarketSource[]
  entries: MarketEntry[]
  warnings: string[]
  stale: boolean
}> {
  const sources = await listMarketSources(configRoot)
  const entries: MarketEntry[] = []
  const warnings: string[] = []
  let stale = false
  for (const source of sources.filter((item) => item.enabled)) {
    const cache = await readMarketCache(configRoot, source.id)
    stale ||= marketCacheIsStale(cache)
    if (!cache) continue
    entries.push(...(source.kind === 'git-skills'
      ? filterGitSkillsSourceEntries(source, cache.entries)
      : cache.entries))
    let sourceWarnings = source.kind === 'git-skills'
      ? filterGitSkillsSourceWarnings(source, cache.warnings)
      : cache.warnings
    if (source.kind === 'mcp-registry') {
      // Registry metadata-only records are expected inventory, not an actionable user failure.
      sourceWarnings = sourceWarnings.filter((warning) => !isRegistryProjectionNotice(warning))
    }
    warnings.push(...sourceWarnings.map((warning) => prefixSourceWarning(source, warning)))
  }
  return { sources, entries, warnings, stale }
}

export async function refreshMarketCatalog(
  configRoot: string,
  sourceIds?: readonly string[],
  options: {
    onProgress?: (progress: MarketCatalogSyncProgress) => void
    refreshSource?: typeof refreshMarketSource
  } = {},
): Promise<{ sources: MarketSource[]; warnings: string[] }> {
  const sources = (await listMarketSources(configRoot))
    .filter((source) => source.enabled && (!sourceIds || sourceIds.includes(source.id)))
  const warnings: string[] = []
  const errors = new Map<string, string>()
  let completed = 0
  const report = (progress: MarketCatalogSyncProgress): void => {
    try {
      options.onProgress?.(progress)
    } catch {
      // A renderer progress listener must never abort the durable cache refresh.
    }
  }
  report({ phase: 'started', completed, total: sources.length })
  await Promise.all(sources.map(async (source) => {
    report({
      phase: 'source-started',
      completed,
      total: sources.length,
      sourceId: source.id,
      sourceName: source.name,
    })
    try {
      await (options.refreshSource ?? refreshMarketSource)(configRoot, source)
      completed += 1
      report({
        phase: 'source-ready',
        completed,
        total: sources.length,
        sourceId: source.id,
        sourceName: source.name,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.set(source.id, message)
      warnings.push(`${source.name}: ${message}`)
      completed += 1
      report({
        phase: 'source-failed',
        completed,
        total: sources.length,
        sourceId: source.id,
        sourceName: source.name,
        error: message,
      })
    }
  }))
  report({ phase: 'completed', completed, total: sources.length })
  return {
    sources: (await listMarketSources(configRoot)).map((source) => ({
      ...source,
      error: errors.get(source.id),
    })),
    warnings,
  }
}

async function readCustomSources(configRoot: string): Promise<MarketSource[]> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(path.join(configRoot, SOURCES_FILE), 'utf8'))
    if (!Array.isArray(raw)) return []
    return raw.filter((item): item is MarketSource => {
      if (!item || typeof item !== 'object') return false
      const source = item as Partial<MarketSource>
      return typeof source.id === 'string'
        && typeof source.name === 'string'
        && typeof source.url === 'string'
        && (source.kind === 'git-skills' || source.kind === 'mcp-registry')
    }).map((source) => ({ ...source, builtin: false }))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function writeCustomSources(configRoot: string, sources: MarketSource[]): Promise<void> {
  await fs.mkdir(configRoot, { recursive: true })
  const file = path.join(configRoot, SOURCES_FILE)
  const temporary = `${file}.${process.pid}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(sources, null, 2)}\n`, 'utf8')
  await fs.rename(temporary, file)
}
