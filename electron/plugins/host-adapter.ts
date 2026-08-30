import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type {
  PluginCompatibility,
  PluginHostCapability,
  PluginManifest,
  PluginMarketplaceFormat,
  PluginMcpMember,
  PluginSkillMember,
} from '@shared/types/plugin.js'

import { validateSkillDir } from '../skills/install/validate.js'
import { SUPPORTED_PLUGIN_SCHEMAS, validatePluginName } from './manifest.js'
import { AGENT_PLUGINS_MCP_SCHEMA } from './mcp-members.js'

const OPENAI_MANIFEST = '.codex-plugin/plugin.json'
const ANTHROPIC_MANIFEST = '.claude-plugin/plugin.json'
const HOST_MCP_FILE = '.mcp.json'

const ANTHROPIC_COMPONENT_FIELDS = [
  'skills',
  'commands',
  'agents',
  'hooks',
  'mcpServers',
  'lspServers',
  'monitors',
  'outputStyles',
  'workflows',
  'themes',
  'channels',
] as const

interface SkillProjection extends PluginSkillMember {
  directory: string
}

interface CanonicalMcpServer {
  type: 'stdio' | 'streamable-http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
}

interface HostProjection {
  manifest: PluginManifest
  skills: SkillProjection[]
  mcpServers: Record<string, CanonicalMcpServer>
  compatibility: PluginCompatibility
  warnings: string[]
  installable: boolean
  installDisabledReason?: string
}

export interface HostPluginInspection {
  manifest: PluginManifest
  skills: PluginSkillMember[]
  mcpServers: PluginMcpMember[]
  compatibility: PluginCompatibility
  warnings: string[]
  installable: boolean
  installDisabledReason?: string
}

export interface AdaptedHostPlugin extends HostPluginInspection {
  directory: string
  cleanup(): Promise<void>
}

export class PluginAdapterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PluginAdapterError'
  }
}

export async function inspectHostPluginDirectory(options: {
  format: PluginMarketplaceFormat
  directory: string
  marketplaceEntry?: Record<string, unknown>
}): Promise<HostPluginInspection> {
  return publicInspection(await projectHostPlugin(options))
}

/** 宿主包转成一次性 canonical 包；严格核心从不知道 `.codex-plugin` / `.claude-plugin`。 */
export async function adaptHostPluginDirectory(options: {
  format: PluginMarketplaceFormat
  directory: string
  marketplaceEntry?: Record<string, unknown>
}): Promise<AdaptedHostPlugin> {
  const projection = await projectHostPlugin(options)
  if (!projection.installable) {
    throw new PluginAdapterError(projection.installDisabledReason ?? '插件没有 Piskie 可安装的 Skills 或 MCP')
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), `piskie-${options.format}-adapter-`))
  try {
    await fs.writeFile(
      path.join(temporary, 'plugin.json'),
      `${JSON.stringify(projection.manifest, null, 2)}\n`,
      'utf8',
    )
    if (projection.skills.length > 0) {
      const skillsRoot = path.join(temporary, 'skills')
      await fs.mkdir(skillsRoot)
      for (const skill of projection.skills) {
        await fs.cp(skill.directory, path.join(skillsRoot, skill.name), { recursive: true })
      }
    }
    if (Object.keys(projection.mcpServers).length > 0) {
      await fs.writeFile(path.join(temporary, 'mcp.json'), `${JSON.stringify({
        $schema: AGENT_PLUGINS_MCP_SCHEMA,
        mcpServers: projection.mcpServers,
      }, null, 2)}\n`, 'utf8')
    }
    return {
      ...publicInspection(projection),
      directory: temporary,
      cleanup: async () => {
        await fs.rm(temporary, { recursive: true, force: true }).catch(() => {})
      },
    }
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

function publicInspection(projection: HostProjection): HostPluginInspection {
  return {
    manifest: projection.manifest,
    skills: projection.skills.map(({ directory: _directory, ...skill }) => skill),
    mcpServers: Object.entries(projection.mcpServers).map(([name, server]) => ({
      name,
      transport: server.type === 'stdio' ? 'stdio' : 'streamable_http',
      command: server.command,
      args: server.args,
      url: server.url,
    })),
    compatibility: projection.compatibility,
    warnings: projection.warnings,
    installable: projection.installable,
    installDisabledReason: projection.installDisabledReason,
  }
}

async function projectHostPlugin(options: {
  format: PluginMarketplaceFormat
  directory: string
  marketplaceEntry?: Record<string, unknown>
}): Promise<HostProjection> {
  const directory = path.resolve(options.directory)
  const overlay = options.marketplaceEntry ?? {}
  const manifestFile = options.format === 'openai' ? OPENAI_MANIFEST : ANTHROPIC_MANIFEST
  const hostManifest = await readOptionalJsonObject(path.join(directory, manifestFile))
  if (options.format === 'openai' && !hostManifest) {
    throw new PluginAdapterError(`OpenAI 插件缺少 ${OPENAI_MANIFEST}`)
  }

  const strict = options.format === 'anthropic' ? readStrict(overlay.strict) : true
  if (options.format === 'anthropic' && strict === false && hostManifest) {
    const conflicts = ANTHROPIC_COMPONENT_FIELDS.filter((field) => hostManifest[field] !== undefined)
    if (conflicts.length > 0) {
      throw new PluginAdapterError(`Anthropic strict:false 与 plugin.json 组件字段冲突：${conflicts.join(', ')}`)
    }
  }

  const name = metadataString(hostManifest, overlay, 'name', true)!
  const nameError = validatePluginName(name)
  if (nameError) throw new PluginAdapterError(`宿主插件 name 无法投影到 Agent Plugins：${nameError}`)
  assertMetadataConsistency(hostManifest, overlay, 'name')
  assertMetadataConsistency(hostManifest, overlay, 'version')

  const warnings: string[] = []
  const skills = await discoverSkills({
    format: options.format,
    directory,
    manifest: hostManifest,
    overlay,
    strict,
    warnings,
  })
  const mcpResult = await discoverMcp({
    format: options.format,
    directory,
    manifest: hostManifest,
    overlay,
    strict,
  })
  warnings.push(...mcpResult.warnings)

  const supported: PluginHostCapability[] = []
  if (skills.length > 0) supported.push('skills')
  if (Object.keys(mcpResult.servers).length > 0) supported.push('mcp')
  const unsupported = await discoverUnsupportedCapabilities(
    options.format,
    directory,
    hostManifest,
    overlay,
    mcpResult.authMetadata,
  )
  const installable = supported.length > 0
  const compatibility: PluginCompatibility = {
    status: !installable
      ? 'unsupported'
      : unsupported.length > 0
        ? 'partial'
        : 'compatible',
    supported,
    unsupported,
    reason: !installable
      ? '此宿主插件没有可投影为 Piskie Skills 或普通 MCP 的成员'
      : unsupported.length > 0
        ? `仅安装 Skills/MCP；不支持：${unsupported.join(', ')}`
        : undefined,
  }
  const adapterMetadata = {
    adaptedFrom: options.format,
    compatibility,
    warnings,
  }
  const manifest: PluginManifest = {
    $schema: SUPPORTED_PLUGIN_SCHEMAS[0],
    name,
    ...optionalMetadata(hostManifest, overlay),
    extensions: { 'com.piskie': adapterMetadata },
  }
  return {
    manifest,
    skills,
    mcpServers: mcpResult.servers,
    compatibility,
    warnings,
    installable,
    installDisabledReason: compatibility.reason,
  }
}

async function discoverSkills(options: {
  format: PluginMarketplaceFormat
  directory: string
  manifest?: Record<string, unknown>
  overlay: Record<string, unknown>
  strict: boolean
  warnings: string[]
}): Promise<SkillProjection[]> {
  const candidates: string[] = []
  if (options.format === 'openai') {
    candidates.push(...await skillDirectoriesFromField(options.manifest?.skills, options.directory, 'skills'))
  } else {
    // Anthropic skills paths add to conventional discovery in both strict modes.
    candidates.push(...await skillDirectoriesAt(path.join(options.directory, 'skills')))
    const manifestPaths = options.strict ? options.manifest?.skills : undefined
    candidates.push(...await skillDirectoriesFromField(manifestPaths, options.directory, 'plugin.json skills'))
    candidates.push(...await skillDirectoriesFromField(options.overlay.skills, options.directory, 'marketplace skills'))
    if (candidates.length === 0 && options.manifest?.skills === undefined && options.overlay.skills === undefined) {
      candidates.push(...await skillDirectoriesAt(options.directory))
    }
  }

  const result: SkillProjection[] = []
  const seenPaths = new Set<string>()
  const seenNames = new Set<string>()
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate)
    if (seenPaths.has(resolved)) continue
    seenPaths.add(resolved)
    const validation = await validateSkillDir(resolved)
    const skill = validation.parse.manifest
    if (!validation.ok || !skill) {
      options.warnings.push(`Skill ${path.relative(options.directory, resolved)} 无效，已跳过`)
      continue
    }
    if (seenNames.has(skill.name)) {
      options.warnings.push(`Skill ${skill.name} 重复，已跳过后出现的副本`)
      continue
    }
    seenNames.add(skill.name)
    result.push({
      name: skill.name,
      executionType: validation.executionType,
      type: skill.type,
      directory: resolved,
    })
  }
  return result.sort((left, right) => left.name.localeCompare(right.name))
}

async function skillDirectoriesFromField(value: unknown, root: string, field: string): Promise<string[]> {
  if (value === undefined) return []
  const paths = typeof value === 'string'
    ? [value]
    : Array.isArray(value) && value.every((item) => typeof item === 'string')
      ? value as string[]
      : invalid(`${field} 必须是路径字符串或字符串数组`)
  const result: string[] = []
  for (const item of paths) {
    if (item !== '.' && item !== './' && !item.startsWith('./')) invalid(`${field} 路径必须以 ./ 开头`)
    const directory = containedPath(root, item)
    result.push(...await skillDirectoriesAt(directory))
  }
  return result
}

async function skillDirectoriesAt(directory: string): Promise<string[]> {
  if (await isFile(path.join(directory, 'SKILL.md'))) return [directory]
  let entries
  try {
    entries = await fs.readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name))
  const hasManifest = await Promise.all(directories.map((entry) => isFile(path.join(entry, 'SKILL.md'))))
  return directories.filter((_entry, index) => hasManifest[index])
}

async function discoverMcp(options: {
  format: PluginMarketplaceFormat
  directory: string
  manifest?: Record<string, unknown>
  overlay: Record<string, unknown>
  strict: boolean
}): Promise<{
  servers: Record<string, CanonicalMcpServer>
  warnings: string[]
  authMetadata: boolean
}> {
  const documents: unknown[] = []
  if (options.format === 'openai') {
    if (options.manifest?.mcpServers !== undefined) {
      documents.push(await loadMcpDeclaration(options.manifest.mcpServers, options.directory, 'mcpServers'))
    }
  } else if (options.strict === false) {
    if (options.overlay.mcpServers !== undefined) documents.push(options.overlay.mcpServers)
    else {
      const conventional = await readOptionalJson(path.join(options.directory, HOST_MCP_FILE))
      if (conventional !== undefined) documents.push(conventional)
    }
  } else {
    if (options.manifest?.mcpServers !== undefined) {
      documents.push(await loadMcpDeclaration(options.manifest.mcpServers, options.directory, 'plugin.json mcpServers'))
    } else {
      const conventional = await readOptionalJson(path.join(options.directory, HOST_MCP_FILE))
      if (conventional !== undefined) documents.push(conventional)
    }
    if (options.overlay.mcpServers !== undefined) documents.push(options.overlay.mcpServers)
  }

  const rawServers = new Map<string, unknown>()
  const warnings: string[] = []
  for (const document of documents) {
    const table = unwrapHostMcpDocument(document)
    for (const [name, config] of Object.entries(table)) {
      if (rawServers.has(name)) {
        warnings.push(`MCP server ${name} 重复声明，已跳过后出现的副本`)
        continue
      }
      rawServers.set(name, config)
    }
  }

  const servers: Record<string, CanonicalMcpServer> = {}
  let authMetadata = false
  for (const [name, raw] of rawServers) {
    try {
      const normalized = normalizeHostMcpServer(raw)
      servers[name] = normalized.server
      warnings.push(...normalized.warnings.map((warning) => `MCP ${name}: ${warning}`))
      authMetadata ||= normalized.authMetadata
    } catch (error) {
      warnings.push(`MCP ${name} 无法转换，已跳过：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { servers, warnings, authMetadata }
}

async function loadMcpDeclaration(value: unknown, root: string, field: string): Promise<unknown> {
  if (typeof value === 'string') {
    if (!value.startsWith('./')) invalid(`${field} 路径必须以 ./ 开头`)
    return readRequiredJson(containedPath(root, value), field)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${field} 必须是路径或对象`)
  return value
}

function unwrapHostMcpDocument(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('MCP 配置必须是对象')
  const root = value as Record<string, unknown>
  const wrapped = root.mcpServers ?? root.mcp_servers
  if (wrapped !== undefined) {
    if (!wrapped || typeof wrapped !== 'object' || Array.isArray(wrapped)) invalid('MCP server map 必须是对象')
    return wrapped as Record<string, unknown>
  }
  return root
}

function normalizeHostMcpServer(raw: unknown): {
  server: CanonicalMcpServer
  warnings: string[]
  authMetadata: boolean
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('server 配置必须是对象')
  const source = raw as Record<string, unknown>
  const warnings: string[] = []
  let authMetadata = false
  const isHttp = source.type === 'http' || source.type === 'streamable-http' || source.url !== undefined
  if (source.type === 'sse') invalid('legacy SSE 不是 Piskie 支持的宿主转换目标')

  if (isHttp) {
    if (typeof source.url !== 'string' || source.url.length === 0) invalid('HTTP server 缺少 url')
    const headers: Record<string, string> = {}
    if (source.headers !== undefined) {
      if (!source.headers || typeof source.headers !== 'object' || Array.isArray(source.headers)) {
        invalid('headers 必须是字符串 map')
      }
      for (const [key, value] of Object.entries(source.headers as Record<string, unknown>)) {
        if (typeof value !== 'string') invalid(`header ${key} 必须是字符串`)
        if (hasNonPortablePlaceholder(value)) {
          warnings.push(`header ${key} 使用宿主环境变量，未写入 canonical 配置；请安装后在 MCP 配置中填写`)
          authMetadata = true
          continue
        }
        headers[key] = value
      }
    }
    for (const field of ['oauth_resource', 'bearer_token_env_var']) {
      if (source[field] !== undefined) {
        warnings.push(`${field} 是宿主专属认证元数据，需由 Piskie onboarding/配置器处理`)
        authMetadata = true
      }
    }
    return {
      server: {
        type: 'streamable-http',
        url: source.url,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
      },
      warnings,
      authMetadata,
    }
  }

  if (typeof source.command !== 'string' || source.command.length === 0) invalid('stdio server 缺少 command')
  const command = normalizeHostCommand(source.command)
  const args = optionalStringArray(source.args, 'args')?.map((value) => translateHostPlaceholders(value))
  const env = optionalStringMap(source.env, 'env')
  const translatedEnv = env
    ? Object.fromEntries(Object.entries(env).map(([key, value]) => [key, translateHostPlaceholders(value)]))
    : undefined
  let cwd: string | undefined
  if (source.cwd !== undefined) {
    if (typeof source.cwd !== 'string') invalid('cwd 必须是字符串')
    cwd = source.cwd === '.' ? './' : translateHostPlaceholders(source.cwd)
  }
  if (source.env_vars !== undefined || source.tool_timeout_sec !== undefined) {
    warnings.push('env_vars/tool_timeout_sec 是宿主专属 MCP 元数据，未写入 canonical 配置')
  }
  if ([...(args ?? []), ...Object.values(translatedEnv ?? {})].some(hasNonPortablePlaceholder)) {
    warnings.push('配置包含非 PLUGIN_ROOT/PLUGIN_DATA 的宿主环境变量占位符，安装后可能需要补充参数')
    authMetadata = true
  }
  return {
    server: { type: 'stdio', command, args, env: translatedEnv, cwd },
    warnings,
    authMetadata,
  }
}

function normalizeHostCommand(value: string): string {
  const translated = translateHostPlaceholders(value)
  if (translated.startsWith('${PLUGIN_ROOT}/')) return `./${translated.slice('${PLUGIN_ROOT}/'.length)}`
  if (translated.includes('${PLUGIN_DATA}')) invalid('command 不能从持久数据目录执行')
  return translated
}

function translateHostPlaceholders(value: string): string {
  return value
    .replace(/\$\{(?:CLAUDE_|CODEX_)?PLUGIN_ROOT\}/g, '${PLUGIN_ROOT}')
    .replace(/\$\{(?:CLAUDE_|CODEX_)?PLUGIN_DATA\}/g, '${PLUGIN_DATA}')
}

function hasNonPortablePlaceholder(value: string): boolean {
  return /\$\{(?!PLUGIN_(?:ROOT|DATA)\})[^}]+\}/.test(value)
}

async function discoverUnsupportedCapabilities(
  format: PluginMarketplaceFormat,
  directory: string,
  manifest: Record<string, unknown> | undefined,
  overlay: Record<string, unknown>,
  authMetadata: boolean,
): Promise<PluginHostCapability[]> {
  const unsupported = new Set<PluginHostCapability>()
  if (authMetadata) unsupported.add('mcp-auth')
  if (format === 'openai') {
    if (manifest?.apps !== undefined) unsupported.add('apps')
    if (manifest?.hooks !== undefined || await isFile(path.join(directory, 'hooks', 'hooks.json'))) unsupported.add('hooks')
    if (manifest?.interface !== undefined) unsupported.add('interface')
    return [...unsupported]
  }

  const merged = { ...(manifest ?? {}), ...overlay }
  if (merged.commands !== undefined || await hasEntries(path.join(directory, 'commands'))) unsupported.add('commands')
  if (merged.agents !== undefined || await hasEntries(path.join(directory, 'agents'))) unsupported.add('agents')
  if (merged.hooks !== undefined || await isFile(path.join(directory, 'hooks', 'hooks.json'))) unsupported.add('hooks')
  if (merged.lspServers !== undefined || await isFile(path.join(directory, '.lsp.json'))) unsupported.add('lsp')
  if (merged.monitors !== undefined || await hasEntries(path.join(directory, 'monitors'))) unsupported.add('monitors')
  if (merged.outputStyles !== undefined || await hasEntries(path.join(directory, 'output-styles'))) unsupported.add('output-styles')
  if (merged.workflows !== undefined || await hasEntries(path.join(directory, 'workflows'))) unsupported.add('workflows')
  if (merged.themes !== undefined || await hasEntries(path.join(directory, 'themes'))) unsupported.add('themes')
  if (merged.channels !== undefined) unsupported.add('channels')
  return [...unsupported]
}

function optionalMetadata(
  manifest: Record<string, unknown> | undefined,
  overlay: Record<string, unknown>,
): Omit<PluginManifest, '$schema' | 'name' | 'extensions'> {
  const result: Omit<PluginManifest, '$schema' | 'name' | 'extensions'> = {}
  for (const field of ['version', 'description', 'homepage', 'repository', 'license'] as const) {
    const value = metadataString(manifest, overlay, field, false)
    if (value !== undefined) result[field] = value
  }
  const authorValue = manifest?.author ?? overlay.author
  if (authorValue !== undefined) {
    if (!authorValue || typeof authorValue !== 'object' || Array.isArray(authorValue)) invalid('author 必须是对象')
    const author = authorValue as Record<string, unknown>
    const projected = Object.fromEntries(
      ['name', 'email', 'url']
        .filter((field) => author[field] !== undefined)
        .map((field) => {
          if (typeof author[field] !== 'string') invalid(`author.${field} 必须是字符串`)
          return [field, author[field]]
        }),
    )
    result.author = projected
  }
  const keywords = manifest?.keywords ?? overlay.keywords
  if (keywords !== undefined) result.keywords = optionalStringArray(keywords, 'keywords')
  return result
}

function metadataString(
  manifest: Record<string, unknown> | undefined,
  overlay: Record<string, unknown>,
  field: string,
  required: boolean,
): string | undefined {
  const value = manifest?.[field] ?? overlay[field]
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || value.length === 0) invalid(`${field} 必须是非空字符串`)
  return value
}

function assertMetadataConsistency(
  manifest: Record<string, unknown> | undefined,
  overlay: Record<string, unknown>,
  field: string,
): void {
  const left = manifest?.[field]
  const right = overlay[field]
  if (left !== undefined && right !== undefined && left !== right) {
    invalid(`宿主 plugin.json 与 marketplace 的 ${field} 不一致：${String(left)} != ${String(right)}`)
  }
}

function readStrict(value: unknown): boolean {
  if (value === undefined) return true
  if (typeof value !== 'boolean') invalid('strict 必须是 boolean')
  return value
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) invalid(`${field} 必须是字符串数组`)
  return value as string[]
}

function optionalStringMap(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${field} 必须是字符串 map`)
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== 'string') invalid(`${field}.${key} 必须是字符串`)
    result[key] = item
  }
  return result
}

function containedPath(root: string, value: string): string {
  const candidate = path.resolve(root, value)
  const relative = path.relative(path.resolve(root), candidate)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    invalid(`组件路径越界：${value}`)
  }
  return candidate
}

async function readRequiredJson(file: string, field: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    throw new PluginAdapterError(`${field} 无法读取：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function readOptionalJson(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new PluginAdapterError(`${path.basename(file)} 无法读取：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function readOptionalJsonObject(file: string): Promise<Record<string, unknown> | undefined> {
  const value = await readOptionalJson(file)
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${file} 顶层必须是对象`)
  return value as Record<string, unknown>
}

async function isFile(file: string): Promise<boolean> {
  return (await fs.stat(file).catch(() => undefined))?.isFile() === true
}

async function hasEntries(directory: string): Promise<boolean> {
  try {
    return (await fs.readdir(directory)).length > 0
  } catch {
    return false
  }
}

function invalid(message: string): never {
  throw new PluginAdapterError(message)
}
