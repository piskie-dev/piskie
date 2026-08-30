import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { MarketEntry, MarketSource } from '@shared/types/market.js'
import type {
  PluginCompatibility,
  PluginHostCapability,
  PluginMarketplaceEntry,
  PluginMcpMember,
  PluginSkillMember,
} from '@shared/types/plugin.js'

import { inspectHostPluginDirectory } from '../../plugins/host-adapter.js'
import { pluginPackageSourceLabel } from '../../plugins/adapter-source.js'
import { readPluginMarketplace } from '../../plugins/marketplace.js'

export async function scanPluginMarketplaceSource(
  source: MarketSource,
  checkout: string,
  _configRoot: string,
): Promise<{ entries: MarketEntry[]; warnings: string[] }> {
  const format = source.kind === 'openai-plugin-marketplace'
    ? 'openai'
    : source.kind === 'anthropic-plugin-marketplace'
      ? 'anthropic'
      : undefined
  if (!format) throw new Error(`来源 ${source.id} 不是显式 OpenAI/Anthropic plugin marketplace`)

  const marketplace = await readPluginMarketplace(checkout, format)
  const warnings = [...marketplace.warnings]
  const entries: MarketEntry[] = []
  for (const item of marketplace.entries) {
    if (item.policy.installation === 'NOT_AVAILABLE') continue
    const inspected = item.source.type === 'directory'
      ? await inspectLocalPackage(item, checkout).catch((error) => ({ error }))
      : undefined

    const compatibility = inspected && !('error' in inspected)
      ? inspected.compatibility
      : inspected && 'error' in inspected
        ? unsupportedInspection(inspected.error)
        : unknownCompatibility(item)
    const installable = inspected && !('error' in inspected)
      ? inspected.installable
      : !inspected
    const disabledReason = inspected && !('error' in inspected)
      ? inspected.installDisabledReason
      : inspected && 'error' in inspected
        ? compatibility.reason
        : undefined
    const skills = inspected && !('error' in inspected) ? inspected.skills : []
    const mcpServers = inspected && !('error' in inspected) ? inspected.mcpServers : []
    const manifest = inspected && !('error' in inspected) ? inspected.manifest : undefined

    entries.push({
      id: `${source.id}:plugin:${encodeURIComponent(item.name)}`,
      kind: 'plugin',
      name: manifest?.name ?? item.name,
      description: manifest?.description ?? item.description ?? '',
      sourceId: source.id,
      sourceName: marketplace.displayName,
      sourceUrl: source.url,
      installSource: pluginPackageSourceLabel(item.source),
      version: manifest?.version ?? item.version,
      license: manifest?.license,
      executable: skills.some((skill) => skill.executionType === 'executable'),
      projectedTokens: projectPluginTokenCost(skills, mcpServers),
      policy: {
        installation: item.policy.installation === 'INSTALLED_BY_DEFAULT'
          ? 'INSTALLED_BY_DEFAULT'
          : 'AVAILABLE',
        authentication: item.policy.authentication,
      },
      pluginManifest: manifest,
      pluginAdapter: {
        format: item.packageFormat,
        source: item.source,
        marketplaceEntry: item.marketplaceEntry,
      },
      compatibility,
      warnings: inspected && !('error' in inspected) && inspected.warnings.length > 0
        ? inspected.warnings
        : undefined,
      installable,
      installDisabledReason: disabledReason,
      members: { skills, mcpServers },
    })
  }
  entries.sort((left, right) => left.name.localeCompare(right.name))
  return { entries, warnings }
}

async function inspectLocalPackage(item: PluginMarketplaceEntry, checkout: string) {
  if (item.source.type !== 'directory') throw new Error('内部错误：不是 directory source')
  const directory = path.resolve(item.source.path)
  const relative = path.relative(path.resolve(checkout), directory)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`插件目录越过 marketplace 根：${item.source.path}`)
  }
  const stat = await fs.stat(directory).catch(() => undefined)
  if (!stat?.isDirectory()) throw new Error(`插件目录不存在：${relative}`)
  return inspectHostPluginDirectory({
    format: item.packageFormat,
    directory,
    marketplaceEntry: item.marketplaceEntry,
  })
}

function unknownCompatibility(item: PluginMarketplaceEntry): PluginCompatibility {
  const overlay = item.marketplaceEntry ?? {}
  const supported: PluginHostCapability[] = []
  const unsupported: PluginHostCapability[] = []
  if (overlay.skills !== undefined) supported.push('skills')
  if (overlay.mcpServers !== undefined) supported.push('mcp')
  for (const [field, capability] of [
    ['apps', 'apps'],
    ['hooks', 'hooks'],
    ['commands', 'commands'],
    ['agents', 'agents'],
    ['lspServers', 'lsp'],
    ['monitors', 'monitors'],
    ['interface', 'interface'],
    ['outputStyles', 'output-styles'],
    ['workflows', 'workflows'],
    ['themes', 'themes'],
    ['channels', 'channels'],
  ] as const) {
    if (overlay[field] !== undefined) unsupported.push(capability)
  }
  return {
    status: 'unknown',
    supported,
    unsupported,
  }
}

function unsupportedInspection(error: unknown): PluginCompatibility {
  return {
    status: 'unsupported',
    supported: [],
    unsupported: [],
    reason: `宿主包无法解析：${error instanceof Error ? error.message : String(error)}`,
  }
}

function projectPluginTokenCost(skills: PluginSkillMember[], servers: PluginMcpMember[]): number {
  const skillCost = skills.reduce((sum, skill) => sum + Math.ceil((skill.name.length + 32) / 4), 0)
  const serverCost = servers.reduce((sum, server) => {
    const text = [server.name, server.command, ...(server.args ?? []), server.url].filter(Boolean).join(' ')
    return sum + Math.ceil(text.length / 4)
  }, 0)
  return skillCost + serverCost
}
