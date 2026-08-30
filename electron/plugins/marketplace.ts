import { promises as fs } from 'node:fs'
import path from 'node:path'

import type {
  PluginMarketplace,
  PluginMarketplaceEntry,
  PluginMarketplaceFormat,
  PluginMarketplacePolicy,
  PluginMarketplaceSource,
  PluginPackageSource,
} from '@shared/types/plugin.js'

import { resolveSource } from '../skills/install/sources.js'
import { resolvePluginPackageSource } from './adapter-source.js'

export const OPENAI_MARKETPLACE_FILE = '.agents/plugins/marketplace.json'
export const ANTHROPIC_MARKETPLACE_FILE = '.claude-plugin/marketplace.json'
export const ANTHROPIC_MARKETPLACE_SCHEMA = 'https://anthropic.com/claude-code/marketplace.schema.json'

export class PluginMarketplaceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'PluginMarketplaceError'
  }
}

/** 格式必须由来源声明，绝不探测另一个宿主位置作为降级。 */
export async function readPluginMarketplace(
  directory: string,
  format: PluginMarketplaceFormat,
): Promise<PluginMarketplace> {
  return format === 'openai'
    ? readOpenAiPluginMarketplace(directory)
    : readAnthropicPluginMarketplace(directory)
}

export async function readOpenAiPluginMarketplace(directory: string): Promise<PluginMarketplace> {
  const root = await readMarketplaceDocument(directory, OPENAI_MARKETPLACE_FILE)
  const name = requiredString(root.name, 'OpenAI marketplace.name')
  const interfaceValue = optionalObject(root.interface, 'OpenAI marketplace.interface')
  const displayName = optionalString(interfaceValue?.displayName, 'OpenAI marketplace.interface.displayName') ?? name
  const warnings: string[] = []
  const entries: PluginMarketplaceEntry[] = []

  for (const [index, value] of requiredArray(root.plugins, 'OpenAI marketplace.plugins').entries()) {
    const item = entryObject(value, index, warnings)
    if (!item) continue
    try {
      const itemName = requiredString(item.name, `plugins[${index}].name`)
      const source = parseOpenAiSource(item.source, directory, `plugins[${index}].source`)
      entries.push({
        name: itemName,
        description: optionalString(item.description, `plugins[${index}].description`),
        version: optionalString(item.version, `plugins[${index}].version`),
        source,
        packageFormat: 'openai',
        marketplaceEntry: item,
        policy: normalizePolicy(item.policy),
      })
    } catch (error) {
      warnings.push(`${error instanceof Error ? error.message : String(error)}，已忽略`)
    }
  }
  return { format: 'openai', name, displayName, entries, warnings }
}

export async function readAnthropicPluginMarketplace(directory: string): Promise<PluginMarketplace> {
  const root = await readMarketplaceDocument(directory, ANTHROPIC_MARKETPLACE_FILE)
  if (root.$schema !== ANTHROPIC_MARKETPLACE_SCHEMA) {
    throw new PluginMarketplaceError(
      'MARKETPLACE_INVALID',
      `Anthropic marketplace.$schema 必须是 ${ANTHROPIC_MARKETPLACE_SCHEMA}`,
    )
  }
  const name = requiredString(root.name, 'Anthropic marketplace.name')
  const warnings: string[] = []
  const entries: PluginMarketplaceEntry[] = []
  for (const [index, value] of requiredArray(root.plugins, 'Anthropic marketplace.plugins').entries()) {
    const item = entryObject(value, index, warnings)
    if (!item) continue
    try {
      const itemName = requiredString(item.name, `plugins[${index}].name`)
      entries.push({
        name: itemName,
        description: optionalString(item.description, `plugins[${index}].description`),
        version: optionalString(item.version, `plugins[${index}].version`),
        source: parseAnthropicSource(item.source, directory, `plugins[${index}].source`),
        packageFormat: 'anthropic',
        marketplaceEntry: item,
        policy: { installation: 'AVAILABLE' },
      })
    } catch (error) {
      warnings.push(`${error instanceof Error ? error.message : String(error)}，已忽略`)
    }
  }
  return { format: 'anthropic', name, displayName: name, entries, warnings }
}

async function readMarketplaceDocument(
  directory: string,
  relativeFile: string,
): Promise<Record<string, unknown>> {
  const file = path.join(directory, relativeFile)
  let raw: unknown
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new PluginMarketplaceError('MARKETPLACE_INVALID', `未找到 ${relativeFile}`)
    }
    throw new PluginMarketplaceError(
      'MARKETPLACE_INVALID',
      `${relativeFile} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PluginMarketplaceError('MARKETPLACE_INVALID', `${relativeFile} 顶层必须是对象`)
  }
  return raw as Record<string, unknown>
}

function parseOpenAiSource(value: unknown, root: string, field: string): PluginPackageSource {
  const source = requireManifestRecord(value, field)
  if (source.source !== 'local') {
    throw new PluginMarketplaceError('MARKETPLACE_INVALID', `${field}.source 必须是 local`)
  }
  return { type: 'directory', path: resolveContainedDirectory(requiredString(source.path, `${field}.path`), root) }
}

function parseAnthropicSource(value: unknown, root: string, field: string): PluginPackageSource {
  if (typeof value === 'string') {
    return { type: 'directory', path: resolveContainedDirectory(value, root) }
  }
  const source = requireManifestRecord(value, field)
  switch (source.source) {
    case 'github': {
      const repo = requiredString(source.repo, `${field}.repo`)
      if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
        throw new PluginMarketplaceError('MARKETPLACE_INVALID', `${field}.repo 必须是 owner/repo`)
      }
      return {
        type: 'git',
        url: `https://github.com/${repo.replace(/\.git$/, '')}.git`,
        ref: optionalString(source.ref, `${field}.ref`),
        sha: validateGitSha(source.sha, `${field}.sha`),
      }
    }
    case 'url':
      return {
        type: 'git',
        url: validateGitUrl(requiredString(source.url, `${field}.url`), field),
        ref: optionalString(source.ref, `${field}.ref`),
        sha: validateGitSha(source.sha, `${field}.sha`),
      }
    case 'git-subdir':
      return {
        type: 'git',
        url: validateGitUrl(requiredString(source.url, `${field}.url`), field),
        ref: optionalString(source.ref, `${field}.ref`),
        sha: validateGitSha(source.sha, `${field}.sha`),
        subdirectory: validateRelativeSubdirectory(requiredString(source.path, `${field}.path`), field),
      }
    case 'npm':
      return {
        type: 'npm',
        package: requiredString(source.package, `${field}.package`),
        version: optionalString(source.version, `${field}.version`),
        registry: optionalString(source.registry, `${field}.registry`),
      }
    case 'archive':
      return {
        type: 'archive',
        url: validateArchiveUrl(requiredString(source.url, `${field}.url`), field),
        sha256: validateArchiveSha(source.sha256, `${field}.sha256`),
      }
    default:
      throw new PluginMarketplaceError(
        'MARKETPLACE_INVALID',
        `${field}.source 不是 github、url、git-subdir、npm 或 archive`,
      )
  }
}

function entryObject(
  value: unknown,
  index: number,
  warnings: string[],
): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    warnings.push(`plugins[${index}] 不是对象，已忽略`)
    return undefined
  }
  return value as Record<string, unknown>
}

function normalizePolicy(value: unknown): PluginMarketplacePolicy {
  const policy = value === undefined ? {} : requireManifestRecord(value, 'plugin.policy')
  const installation = policy.installation === undefined || policy.installation === 'AVAILABLE'
    ? 'AVAILABLE'
    : policy.installation === 'NOT_AVAILABLE' || policy.installation === 'INSTALLED_BY_DEFAULT'
      ? policy.installation
      : invalid('plugin.policy.installation 无效')
  const authentication = policy.authentication === undefined
    ? undefined
    : policy.authentication === 'ON_INSTALL' || policy.authentication === 'ON_USE'
      ? policy.authentication
      : invalid('plugin.policy.authentication 无效')
  return { installation, authentication }
}

function resolveContainedDirectory(value: string, root: string): string {
  if (!value.startsWith('./')) {
    throw new PluginMarketplaceError('MARKETPLACE_INVALID', `相对 source 必须以 ./ 开头：${value}`)
  }
  const resolved = path.resolve(root, value)
  assertContained(root, resolved, `相对 source 越界：${value}`)
  return resolved
}

function validateRelativeSubdirectory(value: string, field: string): string {
  if (path.isAbsolute(value)) invalid(`${field}.path 必须是仓库内相对路径`)
  const normalized = path.normalize(value)
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    invalid(`${field}.path 不得越界`)
  }
  return normalized
}

function validateGitUrl(value: string, field: string): string {
  if (/^[^/\s]+\/[^/\s]+$/.test(value)) return `https://github.com/${value.replace(/\.git$/, '')}.git`
  if (/^(https?:\/\/|ssh:\/\/|git@)/.test(value)) return value
  return invalid(`${field}.url 必须是 HTTP(S)、SSH 或 GitHub owner/repo`)
}

function validateArchiveUrl(value: string, field: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return invalid(`${field}.url 不是合法 URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return invalid(`${field}.url 必须使用 HTTP 或 HTTPS`)
  }
  return parsed.toString()
}

function validateGitSha(value: unknown, field: string): string | undefined {
  const sha = optionalString(value, field)
  if (sha !== undefined && !/^[a-fA-F0-9]{40}$/.test(sha)) invalid(`${field} 必须是 40 位 git SHA`)
  return sha
}

function validateArchiveSha(value: unknown, field: string): string {
  const sha = requiredString(value, field)
  if (!/^[a-fA-F0-9]{64}$/.test(sha)) invalid(`${field} 必须是 64 位 SHA-256`)
  return sha.toLowerCase()
}

function requireManifestRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${field} 必须是对象`)
  return value as Record<string, unknown>
}

function optionalObject(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  return requireManifestRecord(value, field)
}

function requiredArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) invalid(`${field} 必须是数组`)
  return value
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) invalid(`${field} 必须是非空字符串`)
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') invalid(`${field} 必须是字符串`)
  return value
}

function assertContained(root: string, candidate: string, message: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) invalid(message)
}

function invalid(message: string): never {
  throw new PluginMarketplaceError('MARKETPLACE_INVALID', message)
}

const SOURCES_FILE = 'plugin-marketplaces.json'

export async function listPluginMarketplaceSources(configRoot: string): Promise<PluginMarketplaceSource[]> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(path.join(configRoot, SOURCES_FILE), 'utf8'))
    if (!Array.isArray(raw)) return []
    return raw.filter((value): value is PluginMarketplaceSource => {
      if (!value || typeof value !== 'object') return false
      const item = value as Partial<PluginMarketplaceSource>
      return typeof item.name === 'string'
        && typeof item.url === 'string'
        && (item.format === 'openai' || item.format === 'anthropic')
        && typeof item.addedAt === 'string'
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export async function addPluginMarketplaceSource(
  configRoot: string,
  format: PluginMarketplaceFormat,
  url: string,
  ref?: string,
): Promise<PluginMarketplaceSource> {
  const resolved = /^(?:https?:\/\/|ssh:\/\/|git@)/.test(url)
    ? await resolvePluginPackageSource({ type: 'git', url, ref })
    : await resolveSource(url).then((source) => ({
        directory: source.stagingDir,
        cleanup: source.cleanup,
      }))
  try {
    const marketplace = await readPluginMarketplace(resolved.directory, format)
    const sources = await listPluginMarketplaceSources(configRoot)
    if (sources.some((source) => source.name === marketplace.name || source.url === url)) {
      throw new PluginMarketplaceError('MARKETPLACE_EXISTS', `插件市场已存在：${marketplace.name}`)
    }
    const record = { name: marketplace.name, url, format, ref, addedAt: new Date().toISOString() }
    await writeSources(configRoot, [...sources, record])
    return record
  } finally {
    await resolved.cleanup()
  }
}

export async function removePluginMarketplaceSource(
  configRoot: string,
  name: string,
): Promise<PluginMarketplaceSource> {
  const sources = await listPluginMarketplaceSources(configRoot)
  const existing = sources.find((source) => source.name === name)
  if (!existing) throw new PluginMarketplaceError('MARKETPLACE_NOT_FOUND', `插件市场不存在：${name}`)
  await writeSources(configRoot, sources.filter((source) => source.name !== name))
  return existing
}

async function writeSources(configRoot: string, sources: PluginMarketplaceSource[]): Promise<void> {
  await fs.mkdir(configRoot, { recursive: true })
  const file = path.join(configRoot, SOURCES_FILE)
  const temporary = `${file}.${process.pid}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(sources, null, 2)}\n`, 'utf8')
  await fs.rename(temporary, file)
}
