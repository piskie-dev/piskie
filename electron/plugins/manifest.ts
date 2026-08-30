import type {
  PluginCompatibility,
  PluginManifest,
  PluginManifestIssue,
  PluginManifestParseResult,
} from '@shared/types/plugin.js'

import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Agent Plugins 1.0.0 Working Draft 的 canonical schema；加载时绝不联网取 schema。 */
export const AGENT_PLUGINS_SCHEMA_PREFIX = 'https://agent-plugins.org/schemas/'

export const SUPPORTED_PLUGIN_SCHEMAS: readonly string[] = [
  `${AGENT_PLUGINS_SCHEMA_PREFIX}1.0.0/plugin.schema.json`,
]

export const OWN_EXTENSION_NAMESPACE = 'com.piskie'

export function readPiskieAdapterMetadata(manifest: PluginManifest): {
  compatibility?: PluginCompatibility
  warnings: string[]
} {
  const value = manifest.extensions?.[OWN_EXTENSION_NAMESPACE]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { warnings: [] }
  const metadata = value as Record<string, unknown>
  const warnings = Array.isArray(metadata.warnings)
    ? metadata.warnings.filter((warning): warning is string => typeof warning === 'string')
    : []
  const rawCompatibility = metadata.compatibility
  if (!rawCompatibility || typeof rawCompatibility !== 'object' || Array.isArray(rawCompatibility)) {
    return { warnings }
  }
  const candidate = rawCompatibility as Partial<PluginCompatibility>
  if (!['compatible', 'partial', 'unsupported', 'unknown'].includes(candidate.status ?? '')
    || !Array.isArray(candidate.supported)
    || !Array.isArray(candidate.unsupported)) {
    return { warnings }
  }
  return { compatibility: candidate as PluginCompatibility, warnings }
}

/** 成员路径由开放标准固定，不允许自定义 */
export const PLUGIN_MCP_FILE = 'mcp.json'
export const PLUGIN_MANIFEST_FILE = 'plugin.json'

const KNOWN_FIELDS = new Set([
  '$schema',
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'extensions',
])

const AUTHOR_FIELDS = new Set(['name', 'email', 'url'])

export function parsePluginManifest(raw: unknown): PluginManifestParseResult {
  const warnings: string[] = []
  const issues: PluginManifestIssue[] = []

  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch (err) {
      return fail([{ code: 'MANIFEST_INVALID', message: `plugin.json 不是合法 JSON：${String(err)}` }], warnings)
    }
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail([{ code: 'MANIFEST_INVALID', message: 'plugin.json 顶层必须是对象' }], warnings)
  }

  const obj = raw as Record<string, unknown>

  for (const key of Object.keys(obj)) {
    if (!KNOWN_FIELDS.has(key)) {
      issues.push({ code: 'MANIFEST_INVALID', message: `plugin.json 不允许字段 "${key}"` })
    }
  }

  const schemaIssue = validateSchemaField(obj.$schema)
  if (schemaIssue) issues.push(schemaIssue)

  const name = obj.name
  if (typeof name !== 'string' || name.length === 0) {
    issues.push({ code: 'NAME_MISSING', message: 'name 为必填字段' })
  } else {
    const nameError = validatePluginName(name)
    if (nameError) issues.push({ code: 'NAME_INVALID', message: nameError })
  }

  if (issues.length > 0) return fail(issues, warnings)

  const manifest: PluginManifest = {
    $schema: obj.$schema as string,
    name: name as string,
  }

  for (const field of ['version', 'description', 'homepage', 'repository', 'license'] as const) {
    const value = obj[field]
    if (value === undefined) continue
    if (typeof value !== 'string') {
      issues.push({ code: 'MANIFEST_INVALID', message: `${field} 必须是字符串` })
    } else {
      manifest[field] = value
    }
  }

  if (obj.keywords !== undefined) {
    if (!Array.isArray(obj.keywords) || obj.keywords.some((item) => typeof item !== 'string')) {
      issues.push({ code: 'MANIFEST_INVALID', message: 'keywords 必须是字符串数组' })
    } else {
      manifest.keywords = obj.keywords as string[]
    }
  }

  if (obj.author !== undefined) {
    if (obj.author !== null && typeof obj.author === 'object' && !Array.isArray(obj.author)) {
      const author: Record<string, string> = {}
      for (const [k, v] of Object.entries(obj.author as Record<string, unknown>)) {
        if (!AUTHOR_FIELDS.has(k)) {
          issues.push({ code: 'MANIFEST_INVALID', message: `author 不允许字段 "${k}"` })
        } else if (typeof v !== 'string') {
          issues.push({ code: 'MANIFEST_INVALID', message: `author.${k} 必须是字符串` })
        } else {
          author[k] = v
        }
      }
      manifest.author = author
    } else {
      issues.push({ code: 'MANIFEST_INVALID', message: 'author 必须是对象' })
    }
  }

  if (obj.extensions !== undefined) {
    if (obj.extensions !== null && typeof obj.extensions === 'object' && !Array.isArray(obj.extensions)) {
      const kept: Record<string, unknown> = {}
      for (const [ns, value] of Object.entries(obj.extensions as Record<string, unknown>)) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          issues.push({ code: 'MANIFEST_INVALID', message: `extensions.${ns} 必须是对象` })
        } else if (ns === OWN_EXTENSION_NAMESPACE) {
          kept[ns] = value
        } else {
          warnings.push(`extensions 命名空间 "${ns}" 非本客户端所有，已忽略`)
        }
      }
      if (Object.keys(kept).length > 0) manifest.extensions = kept
    } else {
      issues.push({ code: 'MANIFEST_INVALID', message: 'extensions 必须是对象' })
    }
  }

  if (issues.length > 0) return fail(issues, warnings)
  return { ok: true, manifest, warnings }
}

export async function readPluginManifestFromDir(
  pluginDir: string,
): Promise<PluginManifestParseResult & { file?: string }> {
  const file = path.join(pluginDir, PLUGIN_MANIFEST_FILE)
  try {
    const raw = await fs.readFile(file, 'utf8')
    return { ...parsePluginManifest(raw), file }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return {
        ok: false,
        issues: [{ code: 'MANIFEST_INVALID', message: `无法读取 ${PLUGIN_MANIFEST_FILE}：${String(error)}` }],
        warnings: [],
        file,
      }
    }
  }
  return {
    ok: false,
    issues: [{
      code: 'MANIFEST_INVALID',
      message: `缺少插件 manifest：${PLUGIN_MANIFEST_FILE}`,
    }],
    warnings: [],
  }
}

/**
 * $schema 双文案：以 Agent Plugins 前缀开头但版本不支持 → 列受支持清单；
 * 根本不是该前缀 → 不是 Agent Plugins manifest。两种都拒绝。
 */
function validateSchemaField(value: unknown): PluginManifestIssue | null {
  if (typeof value !== 'string' || value.length === 0) {
    return { code: 'SCHEMA_MISSING', message: '$schema 为必填字段' }
  }
  if (SUPPORTED_PLUGIN_SCHEMAS.includes(value)) return null
  if (value.startsWith(AGENT_PLUGINS_SCHEMA_PREFIX)) {
    return {
      code: 'SCHEMA_UNSUPPORTED',
      message: `不支持的 Agent Plugins schema 版本：${value}；受支持：${SUPPORTED_PLUGIN_SCHEMAS.join(', ')}`,
    }
  }
  return {
    code: 'SCHEMA_NOT_AGENT_PLUGINS',
    message: `$schema 不是 Agent Plugins manifest：${value}`,
  }
}

/** name：≤64、小写/数字/点/连字符、无 `--`/`..`、首尾字母数字 */
export function validatePluginName(name: string): string | null {
  if (name.length > 64) return `name 超过 64 字符（当前 ${name.length}）`
  if (!/^[a-z0-9.-]+$/.test(name)) return `name 只允许小写字母、数字、点与连字符：${name}`
  if (name.includes('--')) return 'name 不得包含连续连字符'
  if (name.includes('..')) return 'name 不得包含连续点号'
  if (!/^[a-z0-9]/.test(name) || !/[a-z0-9]$/.test(name)) return 'name 首尾必须是字母或数字'
  return null
}

function fail(issues: PluginManifestIssue[], warnings: string[]): PluginManifestParseResult {
  return { ok: false, issues, warnings }
}
