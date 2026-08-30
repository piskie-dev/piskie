import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { SkillSystemDependency } from '@shared/types/skill.js'

import { parseSkillManifest, type ParseSkillManifestResult } from '../manifest/parse.js'

/**
 * 知识型/可执行双策略校验：形态判定 + 唯一 parser + 结构规则。
 * error 级 issue 阻断安装；warning 级随结果透出。
 */
export interface SkillValidationIssue {
  type: 'error' | 'warning'
  field: string
  message: string
  suggestion?: string
}

export interface SkillValidationResult {
  executionType: 'knowledge' | 'executable'
  parse: ParseSkillManifestResult
  issues: SkillValidationIssue[]
  ok: boolean
  /** 结构化 compatibility 数组解析出的系统依赖（安装器写 sidecar） */
  systemDependencies?: SkillSystemDependency[]
  hasSettings: boolean
}

export interface ValidateOptions {
  /** 传入则要求 SKILL.md name 与该目录名一致（本地目录来源） */
  directoryName?: string
}

const DESCRIPTION_MAX = 1024

export async function validateSkillDir(
  dir: string,
  options: ValidateOptions = {},
): Promise<SkillValidationResult> {
  const issues: SkillValidationIssue[] = []

  let manifestSource: string | null = null
  try {
    manifestSource = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8')
  } catch {
    issues.push({
      type: 'error',
      field: 'SKILL.md',
      message: '缺少 SKILL.md 文件',
      suggestion: '创建 SKILL.md，包含 frontmatter（name、description 必填）',
    })
  }

  const parse = parseSkillManifest(manifestSource ?? '', {
    directoryName: options.directoryName,
  })
  if (manifestSource !== null) {
    for (const issue of parse.issues) {
      issues.push({ type: 'error', field: issue.code, message: issue.message })
    }
    for (const warning of parse.warnings) {
      issues.push({ type: 'warning', field: 'frontmatter', message: warning })
    }
  }

  const description = parse.manifest?.description ?? ''
  if (description.length > DESCRIPTION_MAX) {
    issues.push({
      type: 'error',
      field: 'description',
      message: `description 超长（${description.length} > ${DESCRIPTION_MAX} 字符）`,
      suggestion: '压缩 description（写"做什么 + 何时用"即可，细节放正文）',
    })
  }

  const hasSkillModule = await exists(path.join(dir, 'skill.ts'))
  const executionType = hasSkillModule ? 'executable' : 'knowledge'

  const hasSettings = await exists(path.join(dir, 'settings.html'))

  return {
    executionType,
    parse,
    issues,
    ok: !issues.some((i) => i.type === 'error'),
    systemDependencies: parse.systemDependencies,
    hasSettings,
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}
