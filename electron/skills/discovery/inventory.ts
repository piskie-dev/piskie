import path from 'node:path'

import type { SkillInventorySnapshot, SkillInventoryTier, SkillScope } from '@shared/types/skill.js'

/**
 * <available_skills> 清单渲染：预算三级降级 + 路径别名压缩 + 触发规则 + 机读 manifest。
 * 纯函数——枚举合并视图在调用方（core/pilot/skill-inventory.ts），这里只管渲染与降级。
 */
export interface InventorySkill {
  name: string
  description: string
  scope: SkillScope
  /** SKILL.md 绝对路径 */
  path: string
  functions: string[]
}

export interface RenderedInventory {
  /** <available_skills> 块内文本（别名表 + 技能行 + 触发规则） */
  text: string
  snapshot: SkillInventorySnapshot
  /** 被整条丢弃的技能名（调用方记告警日志） */
  omitted: string[]
}

/** 单条 description 硬上限（agentskills.io 规范同款） */
const DESCRIPTION_MAX_CHARS = 1024
/** 无窗口信息时的降级预算（字符） */
const DEFAULT_BUDGET_CHARS = 8000
/** token→字符估算系数（与预算口径配套的粗估，中英混排均值） */
const CHARS_PER_TOKEN = 4
/** 预算比例：≤ 上下文窗口 2% */
const BUDGET_RATIO = 0.02

const TRIGGER_RULES = [
  '- 若用户点名某技能，或当前任务明确匹配上面某条 description，本轮必须使用该技能：',
  '  亲自使用时先 load_skill；委派时将技能名填入 Worker 的 skills。多个匹配则都用，跨轮重新判断。',
  '- 任务需要委派但未匹配到技能时，根据任务所需能力选择合适的 Worker。',
  '- 点名的技能不在此清单？先 tool_search 找（清单只保证常用技能可见）；',
  '  仍没有就明说缺失，并用现有工具给出最佳替代方案。',
].join('\n')

export function inventoryBudgetChars(contextWindowTokens?: number): number {
  return contextWindowTokens && contextWindowTokens > 0
    ? Math.max(2000, Math.floor(contextWindowTokens * BUDGET_RATIO * CHARS_PER_TOKEN))
    : DEFAULT_BUDGET_CHARS
}

export function renderSkillInventory(
  skills: InventorySkill[],
  options: { contextWindowTokens?: number; now?: Date } = {},
): RenderedInventory {
  const budget = inventoryBudgetChars(options.contextWindowTokens)
  const renderedAt = (options.now ?? new Date()).toISOString()

  const items = skills.map((skill) => ({
    skill,
    description: oneLine(skill.description).slice(0, DESCRIPTION_MAX_CHARS),
    displayPath: skill.path,
    tier: 'full' as SkillInventoryTier,
  }))

  const overhead = TRIGGER_RULES.length + 2
  let aliasHeader = ''

  const fixedCost = () =>
    aliasHeader.length + overhead + items.reduce((sum, item) => sum + lineCost(item, ''), 0)
  const totalCost = () =>
    aliasHeader.length + overhead + items.reduce((sum, item) => sum + lineCost(item, item.description), 0)

  // ① 全量 → ② 描述公平裁剪（waterfill：长者先裁，保底不低于均值）
  if (totalCost() > budget) {
    const descBudget = budget - fixedCost()
    if (descBudget > 0 && items.length > 0) {
      const cap = waterfillCap(items.map((i) => i.description.length), descBudget)
      for (const item of items) {
        if (item.description.length > cap) {
          item.description = cap > 1 ? `${item.description.slice(0, cap - 1)}…` : ''
          item.tier = 'trimmed'
        }
      }
    } else {
      for (const item of items) {
        item.description = ''
        item.tier = 'trimmed'
      }
    }
  }

  // ③ 之前：路径别名压缩（技能根前缀提为别名表；仅当实际更省时采用）
  if (totalCost() > budget) {
    const aliases = buildPathAliases(items.map((i) => i.skill.path))
    if (aliases.size > 0) {
      const header = [...aliases.entries()].map(([prefix, alias]) => `${alias} = ${prefix}`).join('\n')
      const saved = items.reduce((sum, item) => {
        const compressed = compressPath(item.skill.path, aliases)
        return sum + (item.displayPath.length - compressed.length)
      }, 0)
      if (saved > header.length + 1) {
        aliasHeader = `${header}\n`
        for (const item of items) item.displayPath = compressPath(item.skill.path, aliases)
      }
    }
  }

  // ③ 最小行：描述砍光（连 functions 一并省去），名字与路径仍可见——从尾部起逐条降
  for (let i = items.length - 1; i >= 0 && totalCost() > budget; i--) {
    items[i].description = ''
    items[i].tier = 'minimal'
  }

  // ④ 整条丢弃（omit，记 manifest）
  const omitted: string[] = []
  while (totalCost() > budget && items.length > 0) {
    const dropped = items.pop()!
    dropped.tier = 'omitted'
    omitted.unshift(dropped.skill.name)
  }

  const lines = items.map((item) => renderLine(item))
  const text = [aliasHeader.trimEnd(), lines.join('\n'), '', TRIGGER_RULES]
    .filter((part, idx) => part !== '' || idx === 2)
    .join('\n')

  const snapshot: SkillInventorySnapshot = { renderedAt, entries: {} }
  for (const item of items) {
    snapshot.entries[item.skill.name] = { tier: item.tier, scope: item.skill.scope }
  }
  for (const name of omitted) {
    const source = skills.find((s) => s.name === name)
    snapshot.entries[name] = { tier: 'omitted', scope: source?.scope ?? 'user' }
  }

  return { text, snapshot, omitted }
}

interface LineItem {
  skill: InventorySkill
  description: string
  displayPath: string
  tier: SkillInventoryTier
}

function renderLine(item: LineItem): string {
  if (item.tier === 'minimal') return `- ${item.skill.name}: (file: ${item.displayPath})`
  const fns = item.skill.functions.length > 0 ? ` [functions: ${item.skill.functions.join(',')}]` : ''
  return `- ${item.skill.name}: ${item.description} (file: ${item.displayPath})${fns}`
}

function lineCost(item: LineItem, description: string): number {
  const fns = item.tier !== 'minimal' && item.skill.functions.length > 0
    ? ` [functions: ${item.skill.functions.join(',')}]`.length
    : 0
  return item.skill.name.length + description.length + item.displayPath.length + fns + 16
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * waterfill：求 cap 使 sum(min(len_i, cap)) ≤ descBudget 且 cap 不低于均值。
 * 长于 cap 的裁到 cap，短的保持原样——即"长者先裁，保底不低于均值"。
 */
function waterfillCap(lengths: number[], descBudget: number): number {
  const mean = Math.floor(descBudget / lengths.length)
  let lo = mean
  let hi = Math.max(...lengths, mean)
  const fits = (cap: number) => lengths.reduce((sum, len) => sum + Math.min(len, cap), 0) <= descBudget
  if (!fits(lo)) return mean
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2)
    if (fits(mid)) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** 出现 ≥2 次的目录前缀提为别名 r0/r1/…（按节省量降序） */
function buildPathAliases(paths: string[]): Map<string, string> {
  const byPrefix = new Map<string, number>()
  for (const p of paths) {
    const prefix = path.dirname(path.dirname(p))
    if (prefix.length > 8) byPrefix.set(prefix, (byPrefix.get(prefix) ?? 0) + 1)
  }
  const shared = [...byPrefix.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[0].length * b[1] - a[0].length * a[1])
    .slice(0, 4)
  const aliases = new Map<string, string>()
  shared.forEach(([prefix], idx) => aliases.set(prefix, `r${idx}`))
  return aliases
}

function compressPath(fullPath: string, aliases: Map<string, string>): string {
  for (const [prefix, alias] of aliases) {
    if (fullPath.startsWith(`${prefix}${path.sep}`)) {
      return `${alias}${fullPath.slice(prefix.length)}`
    }
  }
  return fullPath
}
