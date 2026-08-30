/**
 * MCP 工具面预算切分：单工具门 + 总量两轮装填。
 *
 * 单工具门：description 截断 1KB；schema 序列化 >8KB 整条隐藏。
 * 总量门：MCP 面 ≤ 上下文窗口 5%（context_budget_ratio 可调）。
 * 两轮装填：第一轮为全部生效 server 的工具预扣"名字行"成本（deferred 呈现形态）；
 * 第二轮按勾选顺序把 server 升格为直注（schema 全文 + instructions ≤2KB），
 * 直至预算耗尽，其余保持 deferred。极端规模下连名字行都放不下的 server 整体隐藏并告警。
 */

import type { EffectiveMcpServer, McpServerSnapshot, McpToolAnnotations } from '../../../shared/types/mcp.js'
import { assignVisibleNames } from './naming.js'

export const DEFAULT_MCP_BUDGET_RATIO = 0.05
/** 无窗口信息时的降级窗口（token） */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000
/** token→字符估算系数（与技能清单预算口径一致的粗估） */
const CHARS_PER_TOKEN = 4
/** 单条 description 硬上限 */
const DESCRIPTION_MAX_CHARS = 1024
/** 单工具 schema 序列化上限，超过整条隐藏 */
const SCHEMA_MAX_CHARS = 8 * 1024
/** server instructions 截断上限（仅直注注入） */
const INSTRUCTIONS_MAX_CHARS = 2 * 1024
/** 名字行里 description 摘要长度 */
const NAME_LINE_DESCRIPTION_CHARS = 64

function roughTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

function firstLine(text: string): string {
  const index = text.indexOf('\n')
  return index === -1 ? text : text.slice(0, index)
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`
}

export interface BudgetedMcpTool {
  server: string
  /** raw 协议名 */
  tool: string
  visibleName: string
  /** 截断后的 description（呈现与注入共用） */
  description: string
  inputSchema: Record<string, unknown>
  annotations?: McpToolAnnotations
  /** deferred 清单里的名字行 */
  nameLine: string
  /** schema 全文注入成本（token） */
  directTokens: number
  /** 名字行成本（token） */
  nameLineTokens: number
}

export interface HiddenMcpTool {
  server: string
  tool: string
  reason: 'schema-too-large'
}

export interface McpServerPlan {
  server: EffectiveMcpServer
  exposure: 'direct' | 'deferred' | 'hidden'
  tools: BudgetedMcpTool[]
  hiddenTools: HiddenMcpTool[]
  /** 截断 2KB 后的 server 使用说明；仅 direct 时有值 */
  instructions?: string
}

export interface McpBudgetPlan {
  servers: McpServerPlan[]
  budgetTokens: number
  usedTokens: number
  warnings: string[]
}

export interface McpBudgetInput {
  /** 已按勾选顺序排列的生效 server 及其工具快照 */
  servers: Array<{ server: EffectiveMcpServer; snapshot: McpServerSnapshot }>
  contextWindowTokens?: number
  /** config domain 的 context_budget_ratio，缺省 0.05 */
  budgetRatio?: number
}

function filterTools(server: EffectiveMcpServer, snapshot: McpServerSnapshot) {
  const allow = server.config.enabled_tools
  const deny = new Set(server.config.disabled_tools ?? [])
  return snapshot.tools.filter((tool) => {
    if (allow && !allow.includes(tool.name)) return false
    return !deny.has(tool.name)
  })
}

/**
 * 对生效 server 集做预算切分。输入顺序即勾选顺序（升格优先级）。
 */
export function planMcpBudget(input: McpBudgetInput): McpBudgetPlan {
  const windowTokens = input.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS
  const ratio = input.budgetRatio ?? DEFAULT_MCP_BUDGET_RATIO
  const budgetTokens = Math.floor(windowTokens * ratio)
  const warnings: string[] = []

  const allNames = assignVisibleNames(
    input.servers.flatMap(({ server, snapshot }) =>
      filterTools(server, snapshot).map((tool) => ({ server: server.name, tool: tool.name })),
    ),
  )
  for (const dup of allNames.duplicates) {
    warnings.push(`server "${dup.server}" 工具 "${dup.tool}" 与同批条目名称冲突且无法消歧，已跳过`)
  }
  const visibleNameOf = new Map(allNames.named.map((n) => [`${n.server} ${n.tool}`, n.visibleName]))

  const servers: McpServerPlan[] = input.servers.map(({ server, snapshot }) => {
    const tools: BudgetedMcpTool[] = []
    const hiddenTools: HiddenMcpTool[] = []
    for (const tool of filterTools(server, snapshot)) {
      const visibleName = visibleNameOf.get(`${server.name} ${tool.name}`)
      if (!visibleName) continue
      const schemaChars = JSON.stringify(tool.inputSchema ?? {}).length
      if (schemaChars > SCHEMA_MAX_CHARS) {
        hiddenTools.push({ server: server.name, tool: tool.name, reason: 'schema-too-large' })
        continue
      }
      const description = truncate(tool.description ?? '', DESCRIPTION_MAX_CHARS)
      const nameLine = `- ${visibleName}: ${truncate(firstLine(description), NAME_LINE_DESCRIPTION_CHARS)}`
      tools.push({
        server: server.name,
        tool: tool.name,
        visibleName,
        description,
        inputSchema: tool.inputSchema ?? {},
        annotations: tool.annotations,
        nameLine,
        directTokens: roughTokens(visibleName.length + description.length + schemaChars),
        nameLineTokens: roughTokens(nameLine.length),
      })
    }
    for (const hidden of hiddenTools) {
      warnings.push(`server "${hidden.server}" 工具 "${hidden.tool}" schema 超过 8KB，已隐藏`)
    }
    const instructions = snapshot.instructions
      ? truncate(snapshot.instructions, INSTRUCTIONS_MAX_CHARS)
      : undefined
    return { server, exposure: 'deferred' as const, tools, hiddenTools, instructions }
  })

  // 第一轮：预扣名字行。放不下名字行的 server 整体隐藏。
  let usedTokens = 0
  for (const plan of servers) {
    const nameLineCost = plan.tools.reduce((sum, t) => sum + t.nameLineTokens, 0)
    if (usedTokens + nameLineCost > budgetTokens) {
      plan.exposure = 'hidden'
      warnings.push(`MCP 预算不足（${budgetTokens} token）：server "${plan.server.name}" 连名字行都放不下，本次注入已整体隐藏`)
      continue
    }
    usedTokens += nameLineCost
  }

  // 第二轮：按勾选顺序升格直注，升格释放名字行成本；装不下即停。
  for (const plan of servers) {
    if (plan.exposure === 'hidden') continue
    const nameLineCost = plan.tools.reduce((sum, t) => sum + t.nameLineTokens, 0)
    const directCost = plan.tools.reduce((sum, t) => sum + t.directTokens, 0)
      + (plan.instructions ? roughTokens(plan.instructions.length) : 0)
    const delta = directCost - nameLineCost
    if (usedTokens + delta > budgetTokens) break
    plan.exposure = 'direct'
    usedTokens += delta
  }

  return { servers, budgetTokens, usedTokens, warnings }
}
