import { promises as fs } from 'node:fs'
import path from 'node:path'

import { mcpServerConfigSchema } from '@shared/schemas/mcp.js'
import type { McpServerConfig } from '@shared/types/mcp.js'

import { projectPluginsRootsForRead } from '../skills/store/layout.js'
import { PLUGIN_MCP_FILE, readPluginManifestFromDir } from './manifest.js'
import { globalPluginsRoot, pluginDataDir } from './store.js'

export interface PluginMcpIssue {
  server?: string
  code: 'MCP_JSON_INVALID' | 'MCP_SERVER_INVALID' | 'TRANSPORT_UNSUPPORTED' | 'PATH_ESCAPE'
  message: string
}

export interface PluginMcpParseResult {
  /** 只表示 mcp.json 文档级契约有效；单 server 失败通过 issues 隔离。 */
  ok: boolean
  servers: Record<string, McpServerConfig>
  issues: PluginMcpIssue[]
  warnings: string[]
}

export const AGENT_PLUGINS_MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'

const MCP_DOCUMENT_FIELDS = new Set(['$schema', 'mcpServers'])
const STDIO_FIELDS = new Set(['type', 'command', 'args', 'env', 'cwd'])
const HTTP_FIELDS = new Set(['type', 'url', 'headers'])

/** 只解析 Agent Plugins 现行根级 mcp.json；宿主配置必须先经对应 adapter 归一化。 */
export async function parsePluginMcpFile(options: {
  pluginDir: string
  pluginName: string
  dataDir: string
}): Promise<PluginMcpParseResult> {
  const file = path.join(options.pluginDir, PLUGIN_MCP_FILE)
  let raw: unknown
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, servers: {}, issues: [], warnings: [] }
    }
    return {
      ok: false,
      servers: {},
      issues: [{ code: 'MCP_JSON_INVALID', message: `mcp.json 不是合法 JSON：${String(error)}` }],
      warnings: [],
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      servers: {},
      issues: [{ code: 'MCP_JSON_INVALID', message: 'mcp.json 顶层必须是对象' }],
      warnings: [],
    }
  }

  const root = raw as Record<string, unknown>
  const documentIssues: PluginMcpIssue[] = []
  const unknownDocumentFields = Object.keys(root).filter((field) => !MCP_DOCUMENT_FIELDS.has(field))
  if (unknownDocumentFields.length > 0) {
    documentIssues.push({
      code: 'MCP_JSON_INVALID',
      message: `mcp.json 不允许顶层字段：${unknownDocumentFields.join(', ')}`,
    })
  }
  if (root.$schema !== AGENT_PLUGINS_MCP_SCHEMA) {
    documentIssues.push({
      code: 'MCP_JSON_INVALID',
      message: `$schema 必须是 ${AGENT_PLUGINS_MCP_SCHEMA}`,
    })
  }
  const table = root.mcpServers
  if (!table || typeof table !== 'object' || Array.isArray(table)) {
    documentIssues.push({
      code: 'MCP_JSON_INVALID',
      message: 'mcp.json 的 mcpServers 必须是对象',
    })
  }
  if (documentIssues.length > 0) {
    return {
      ok: false,
      servers: {},
      issues: documentIssues,
      warnings: [],
    }
  }

  const servers: Record<string, McpServerConfig> = {}
  const issues: PluginMcpIssue[] = []
  for (const [name, value] of Object.entries(table as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      issues.push({ server: name, code: 'MCP_SERVER_INVALID', message: `server "${name}" 配置必须是对象` })
      continue
    }
    const source = value as Record<string, unknown>
    if (source.type === 'sse') {
      issues.push({
        server: name,
        code: 'TRANSPORT_UNSUPPORTED',
        message: `插件 server "${name}" 使用本客户端不支持的 legacy HTTP+SSE 传输`,
      })
      continue
    }
    try {
      servers[name] = source.type === 'stdio'
        ? parseStdioServer(source, options.pluginDir, options.dataDir)
        : source.type === 'streamable-http'
          ? parseHttpServer(source)
          : throwInvalid(`type 必须是 stdio、streamable-http 或 sse`)
    } catch (error) {
      issues.push({
        server: name,
        code: /越界/.test(String(error)) ? 'PATH_ESCAPE' : 'MCP_SERVER_INVALID',
        message: `server "${name}" 配置无效：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
  return { ok: true, servers, issues, warnings: [] }
}

function parseStdioServer(
  source: Record<string, unknown>,
  pluginDir: string,
  dataDir: string,
): McpServerConfig {
  assertClosedServer(source, STDIO_FIELDS)
  if (typeof source.command !== 'string' || source.command.length === 0) {
    throw new Error('command 必须是非空字符串')
  }
  const command = resolveCommand(source.command, pluginDir)
  if (source.args !== undefined && (!Array.isArray(source.args) || source.args.some((item) => typeof item !== 'string'))) {
    throw new Error('args 必须是字符串数组')
  }
  if (source.env !== undefined && (!source.env || typeof source.env !== 'object' || Array.isArray(source.env))) {
    throw new Error('env 必须是字符串 map')
  }
  const envSource = source.env as Record<string, unknown> | undefined
  if (envSource && Object.values(envSource).some((item) => typeof item !== 'string')) {
    throw new Error('env 必须是字符串 map')
  }
  if (envSource && Object.keys(envSource).some(isReservedPluginEnvName)) {
    throw new Error('env 不得覆盖 PLUGIN_ROOT 或 PLUGIN_DATA')
  }
  if (source.cwd !== undefined && typeof source.cwd !== 'string') {
    throw new Error('cwd 必须是字符串')
  }

  const env = Object.fromEntries(
    Object.entries(envSource ?? {}).map(([key, value]) => [
      key,
      expandPluginPlaceholders(value as string, pluginDir, dataDir),
    ]),
  )
  env.PLUGIN_ROOT = pluginDir
  env.PLUGIN_DATA = dataDir

  return mcpServerConfigSchema.parse({
    command,
    args: (source.args as string[] | undefined)?.map((value) => (
      expandPluginPlaceholders(value, pluginDir, dataDir)
    )),
    env,
    cwd: resolveWorkingDirectory(source.cwd as string | undefined, pluginDir, dataDir),
  })
}

function parseHttpServer(source: Record<string, unknown>): McpServerConfig {
  assertClosedServer(source, HTTP_FIELDS)
  if (typeof source.url !== 'string' || source.url.length === 0) throw new Error('url 必须是非空字符串')
  const url = validateRemoteUrl(source.url)
  if (source.headers !== undefined && (!source.headers || typeof source.headers !== 'object' || Array.isArray(source.headers))) {
    throw new Error('headers 必须是字符串 map')
  }
  const headers = source.headers as Record<string, unknown> | undefined
  if (headers && Object.values(headers).some((item) => typeof item !== 'string')) {
    throw new Error('headers 必须是字符串 map')
  }
  const normalizedNames = new Set<string>()
  for (const [name, value] of Object.entries(headers ?? {})) {
    const normalized = name.toLowerCase()
    if (normalizedNames.has(normalized)) throw new Error(`headers 包含大小写重复字段：${name}`)
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new Error(`header 名称无效：${name}`)
    if (/[\r\n]/.test(value as string)) throw new Error(`header "${name}" 值包含换行`)
    normalizedNames.add(normalized)
  }
  return mcpServerConfigSchema.parse({
    url,
    http_headers: headers as Record<string, string> | undefined,
  })
}

function assertClosedServer(source: Record<string, unknown>, fields: ReadonlySet<string>): void {
  const unknown = Object.keys(source).filter((field) => !fields.has(field))
  if (unknown.length > 0) throw new Error(`不允许字段：${unknown.join(', ')}`)
}

function resolveCommand(command: string, pluginDir: string): string {
  if (command.startsWith('./')) {
    const resolved = path.resolve(pluginDir, command)
    assertContained(pluginDir, resolved, 'command')
    return resolved
  }
  if (/\s|[/\\]/.test(command)) {
    throw new Error('command 必须是单个裸 executable 或以 ./ 开头的插件相对路径')
  }
  return command
}

function resolveWorkingDirectory(value: string | undefined, pluginDir: string, dataDir: string): string {
  if (value === undefined) return pluginDir
  if (value.startsWith('./')) {
    const resolved = path.resolve(pluginDir, value)
    assertContained(pluginDir, resolved, 'cwd')
    return resolved
  }
  if (value === '${PLUGIN_ROOT}' || value.startsWith('${PLUGIN_ROOT}/')) {
    const resolved = path.resolve(expandPluginPlaceholders(value, pluginDir, dataDir))
    assertContained(pluginDir, resolved, 'cwd')
    return resolved
  }
  if (value === '${PLUGIN_DATA}' || value.startsWith('${PLUGIN_DATA}/')) {
    const resolved = path.resolve(expandPluginPlaceholders(value, pluginDir, dataDir))
    assertContained(dataDir, resolved, 'cwd')
    return resolved
  }
  throw new Error('cwd 必须以 ./、${PLUGIN_ROOT} 或 ${PLUGIN_DATA} 开头')
}

function expandPluginPlaceholders(value: string, pluginDir: string, dataDir: string): string {
  return value.replace(/\$\{PLUGIN_(ROOT|DATA)\}/g, (_match, name: string) => {
    if (name === 'ROOT') return pluginDir
    return dataDir
  })
}

function isReservedPluginEnvName(name: string): boolean {
  const candidate = process.platform === 'win32' ? name.toUpperCase() : name
  return candidate === 'PLUGIN_ROOT' || candidate === 'PLUGIN_DATA'
}

function validateRemoteUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`url 不是合法绝对地址：${value}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('url 只支持 http 或 https')
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error('url 不得包含用户信息或 fragment')
  }
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    throw new Error('非 loopback MCP endpoint 必须使用 https')
  }
  return parsed.toString()
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (normalized === 'localhost' || normalized === '::1') return true
  const parts = normalized.split('.').map(Number)
  return parts.length === 4 && parts.every(Number.isInteger) && parts[0] === 127
}

function throwInvalid(message: string): never {
  throw new Error(message)
}

function assertContained(root: string, candidate: string, field: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${field} 相对路径越界：${candidate}`)
  }
}

export interface DiscoveredPluginMcp {
  global: Array<{ plugin: string; version?: string; servers: Record<string, McpServerConfig> }>
  project: Array<{ plugin: string; version?: string; servers: Record<string, McpServerConfig> }>
  warnings: string[]
}

/** 注入、Connections 与市场预览共用的插件贡献发现。 */
export async function discoverPluginMcpContributions(options: {
  configRoot: string
  workspace?: string
}): Promise<DiscoveredPluginMcp> {
  const warnings: string[] = []
  const scan = async (
    root: string,
  ): Promise<Array<{ plugin: string; version?: string; servers: Record<string, McpServerConfig> }>> => {
    const result: Array<{
      plugin: string
      version?: string
      servers: Record<string, McpServerConfig>
    }> = []
    let entries
    try {
      entries = await fs.readdir(root, { withFileTypes: true })
    } catch {
      return result
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name === '.tmp') continue
      const pluginDir = path.join(root, entry.name)
      const manifest = await readPluginManifestFromDir(pluginDir)
      if (!manifest.ok) {
        warnings.push(`插件目录 ${pluginDir} manifest 无效，已跳过`)
        continue
      }
      const parsed = await parsePluginMcpFile({
        pluginDir,
        pluginName: manifest.manifest.name,
        dataDir: pluginDataDir(options.configRoot, manifest.manifest.name),
      })
      warnings.push(...parsed.warnings, ...parsed.issues.map((issue) => issue.message))
      if (parsed.ok && Object.keys(parsed.servers).length > 0) {
        result.push({
          plugin: manifest.manifest.name,
          version: manifest.manifest.version,
          servers: parsed.servers,
        })
      }
    }
    return result
  }

  const projectPromise = async () => {
    if (!options.workspace) return []
    const byName = new Map<string, { plugin: string; version?: string; servers: Record<string, McpServerConfig> }>()
    for (const root of await projectPluginsRootsForRead(options.workspace)) {
      for (const plugin of await scan(root)) byName.set(plugin.plugin, plugin)
    }
    return [...byName.values()]
  }
  const [global, project] = await Promise.all([
    scan(globalPluginsRoot(options.configRoot)),
    projectPromise(),
  ])
  return { global, project, warnings }
}
