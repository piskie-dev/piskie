import type { SkillSystemDependency, SkillType } from '@shared/types/skill.js'

import { parseYamlWithRepair } from './repair.js'
import { validateSkillName } from './name.js'

/**
 * SKILL.md 唯一 parser：安装期与加载期共用同一字段集同一实现，
 * 两个消费方各取解析结果的不同投影（安装期要求零 error，加载期容忍降级）。
 *
 * frontmatter 契约 = agentskills.io 规范原样：必填 name/description，
 * 识别并保存 license/compatibility/metadata/allowed-tools；
 * compatibility 为自由文本（结构化数组形态解析出的系统依赖交安装器写 sidecar，不进 manifest）。
 */
export const SKILL_TYPES: readonly SkillType[] = ['browser', 'local']

export interface SkillManifest {
  name: string
  description: string
  type?: SkillType
  version?: string
  license?: string
  /** 环境要求自由文本（规范 compatibility 字段为字符串时原样保留） */
  compatibility?: string
  /** 运行时版本要求（生态兼容字段） */
  runtime?: { python?: string; node?: string }
  metadata?: Record<string, unknown>
  /** 只入库展示，不自动授权 */
  allowedTools?: string[]
}

export interface ManifestIssue {
  code:
    | 'FRONTMATTER_MISSING'
    | 'FRONTMATTER_INVALID'
    | 'NAME_MISSING'
    | 'NAME_INVALID'
    | 'DESCRIPTION_MISSING'
    | 'TYPE_INVALID'
  severity: 'error'
  message: string
}

export interface ParseSkillManifestResult {
  /** name 可用即产出（加载期容忍投影）；安装期以 issues 为准 */
  manifest?: SkillManifest
  /** frontmatter 之后的 markdown 正文 */
  body: string
  issues: ManifestIssue[]
  warnings: string[]
  repaired: boolean
  /** compatibility 为结构化数组时解析出的系统依赖（安装器写 sidecar 用） */
  systemDependencies?: SkillSystemDependency[]
}

export interface ParseSkillManifestOptions {
  /** 传入则按规范要求 name 与目录名一致（不一致为 error） */
  directoryName?: string
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

export function parseSkillManifest(
  source: string,
  options: ParseSkillManifestOptions = {},
): ParseSkillManifestResult {
  const issues: ManifestIssue[] = []
  const warnings: string[] = []

  const match = FRONTMATTER.exec(source)
  if (!match) {
    return {
      body: source.trim(),
      issues: [
        { code: 'FRONTMATTER_MISSING', severity: 'error', message: 'SKILL.md 缺少 YAML frontmatter' },
      ],
      warnings,
      repaired: false,
    }
  }

  const body = source.slice(match[0].length).trim()
  const { data, repaired, error } = parseYamlWithRepair(match[1])
  if (repaired && !error) {
    warnings.push('frontmatter 含未加引号的特殊字符，已容错修复解析')
  }
  if (error || data === null || typeof data !== 'object' || Array.isArray(data)) {
    return {
      body,
      issues: [
        {
          code: 'FRONTMATTER_INVALID',
          severity: 'error',
          message: `frontmatter 不是合法 YAML 映射${error ? `：${error.message}` : ''}`,
        },
      ],
      warnings,
      repaired,
    }
  }

  const raw = data as Record<string, unknown>

  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name) {
    issues.push({ code: 'NAME_MISSING', severity: 'error', message: '缺少必填字段 name' })
  } else {
    for (const issue of validateSkillName(name, options.directoryName)) {
      issues.push({ code: 'NAME_INVALID', severity: 'error', message: issue.message })
    }
  }

  const description = typeof raw.description === 'string' ? raw.description.trim() : ''
  if (!description) {
    issues.push({ code: 'DESCRIPTION_MISSING', severity: 'error', message: '缺少必填字段 description' })
  }

  let type: SkillType | undefined
  if (raw.type !== undefined) {
    if (typeof raw.type === 'string' && (SKILL_TYPES as readonly string[]).includes(raw.type)) {
      type = raw.type as SkillType
    } else {
      issues.push({
        code: 'TYPE_INVALID',
        severity: 'error',
        message: `type 必须是 ${SKILL_TYPES.join('/')} 之一：${String(raw.type)}`,
      })
    }
  }

  if (!name) {
    return { body, issues, warnings, repaired }
  }

  const manifest: SkillManifest = { name, description }
  if (type) manifest.type = type
  if (raw.version !== undefined) manifest.version = String(raw.version)
  if (typeof raw.license === 'string') manifest.license = raw.license

  let systemDependencies: SkillSystemDependency[] | undefined
  if (typeof raw.compatibility === 'string') {
    manifest.compatibility = raw.compatibility
  } else if (Array.isArray(raw.compatibility)) {
    systemDependencies = parseSystemDependencies(raw.compatibility)
    warnings.push('compatibility 为结构化数组：按系统依赖声明解析，将记入 sidecar')
  }

  if (raw.runtime && typeof raw.runtime === 'object' && !Array.isArray(raw.runtime)) {
    const runtime = raw.runtime as Record<string, unknown>
    manifest.runtime = {
      python: typeof runtime.python === 'string' ? runtime.python : undefined,
      node: typeof runtime.node === 'string' ? runtime.node : undefined,
    }
  }

  if (raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)) {
    manifest.metadata = raw.metadata as Record<string, unknown>
  }

  const allowedTools = raw['allowed-tools'] ?? raw.allowedTools
  if (Array.isArray(allowedTools)) {
    manifest.allowedTools = allowedTools.filter((t): t is string => typeof t === 'string')
  }

  return { manifest, body, issues, warnings, repaired, systemDependencies }
}

function parseSystemDependencies(deps: unknown[]): SkillSystemDependency[] {
  const out: SkillSystemDependency[] = []
  for (const dep of deps) {
    if (typeof dep === 'string') {
      out.push({ name: dep, required: true, install: {} })
    } else if (dep !== null && typeof dep === 'object' && typeof (dep as Record<string, unknown>).name === 'string') {
      const record = dep as Record<string, unknown>
      out.push({
        name: record.name as string,
        required: record.required !== false,
        install: (record.install as SkillSystemDependency['install']) ?? {},
      })
    }
  }
  return out
}
