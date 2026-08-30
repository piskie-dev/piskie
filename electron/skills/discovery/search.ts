import type { SkillInventorySnapshot, SkillScope } from '@shared/types/skill.js'

/**
 * tool_search 技能侧引擎：字段加权匹配 + 与可见面的互斥过滤。
 * 对三层合并视图工作；MCP deferred 侧在 mcp 域接入（同一工具、结果 kind 分流）。
 */
export interface SearchableSkill {
  name: string
  description: string
  type?: string
  scope: SkillScope
  /** SKILL.md 绝对路径 */
  path: string
  functions: string[]
  /** SKILL.md 正文（可得时参与最低权重匹配） */
  body?: string
}

/** tool_search 技能侧数据源（app 侧实现枚举三层合并视图） */
export interface SkillSearchSource {
  listSearchableSkills(workspace?: string): Promise<SearchableSkill[]>
}

export interface SkillSearchHit {
  kind: 'skill'
  name: string
  description: string
  type?: string
  scope: SkillScope
  path: string
  functions: string[]
}

const MAX_RESULTS = 10
const DESCRIPTION_LIMIT = 256

const WEIGHT_NAME = 100
const WEIGHT_FUNCTION = 60
const WEIGHT_DESCRIPTION = 30
const WEIGHT_BODY = 10

/**
 * 可见集：本次注入时刻快照 manifest 中 full + trimmed 的技能
 * （模型能从清单按 description 匹配到的部分）。manifest 缺席时可见集为空。
 */
export function visibleSkillNames(snapshot: SkillInventorySnapshot | undefined): Set<string> {
  const names = new Set<string>()
  if (!snapshot) return names
  for (const [name, entry] of Object.entries(snapshot.entries)) {
    if (entry.tier === 'full' || entry.tier === 'trimmed') names.add(name)
  }
  return names
}

export function searchSkills(
  skills: SearchableSkill[],
  query: string,
  options: { exclude?: Set<string> } = {},
): SkillSearchHit[] {
  const terms = tokenize(query)
  if (terms.length === 0) return []

  const candidates = skills.filter((skill) => !options.exclude?.has(skill.name))
  const scored = candidates
    .map((skill) => ({ skill, ...scoreSkill(skill, terms) }))
    .filter((s) => s.score > 0)

  // 多词 AND 优先：有全词命中的结果时只取它们，零命中退化 OR
  const allTermHits = scored.filter((s) => s.matchedTerms === terms.length)
  const pool = allTermHits.length > 0 ? allTermHits : scored

  return pool
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, MAX_RESULTS)
    .map(({ skill }) => ({
      kind: 'skill' as const,
      name: skill.name,
      description: truncate(skill.description, DESCRIPTION_LIMIT),
      type: skill.type,
      scope: skill.scope,
      path: skill.path,
      functions: skill.functions,
    }))
}

function scoreSkill(
  skill: SearchableSkill,
  terms: string[],
): { score: number; matchedTerms: number } {
  const name = skill.name.toLowerCase()
  const functions = skill.functions.map((f) => f.toLowerCase())
  const description = skill.description.toLowerCase()
  const body = skill.body?.toLowerCase()

  let score = 0
  let matchedTerms = 0
  for (const term of terms) {
    let termScore = 0
    if (name === term) termScore = WEIGHT_NAME * 2
    else if (name.includes(term)) termScore = WEIGHT_NAME
    else if (functions.some((f) => f.includes(term))) termScore = WEIGHT_FUNCTION
    else if (description.includes(term)) termScore = WEIGHT_DESCRIPTION
    else if (body?.includes(term)) termScore = WEIGHT_BODY
    if (termScore > 0) {
      matchedTerms += 1
      score += termScore
    }
  }
  return { score, matchedTerms }
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,，、]+/)
    .map((t) => t.trim())
    .filter(Boolean)
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}
