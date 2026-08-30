/**
 * 把预算切分后的 MCP 工具面物化为 Agent 模型边界投影 CatalogEntry；不进入进程级
 * 共享目录，也不回写冻结的基础 ToolFace。
 *
 * 结果归约（模型上下文只进文本）：
 * - content 里的 text 块拼接为主文本；
 * - 成功结果的 structuredContent 原样进 data（诊断层，不进模型上下文）；
 * - 错误结果丢弃 structuredContent，避免未受信任结构绕过文本脱敏进入日志；
 * - image 与图片 resource → 标准工具结果图片（模型与前端共用）；
 * - audio 与音频 resource → mcp_audio artifact（仅前端播放）；
 * - isError → ok:false，文本脱敏并限制长度后进入模型上下文。
 */

import type { CallToolResult, ContentBlock } from '@modelcontextprotocol/client'

import type { ToolInputSchema } from '../../../shared/types/index.js'
import type { EffectiveMcpServer } from '../../../shared/types/mcp.js'
import type { ToolArtifact } from '../../../shared/types/tool-artifact.js'
import type { CatalogEntry } from '../../tools/catalog.js'
import { z } from '../../tools/params.js'
import type {
  ITool,
  ImageRef,
  SuspensionQuestion,
  ToolContext,
  ToolDef,
  ToolOutput,
  ToolSuspension,
} from '../../tools/types.js'
import type {
  McpElicitationRequest,
  McpElicitationResponse,
  McpElicitationSink,
  McpElicitationValue,
} from '../client/connection.js'
import { isMcpAbortError, sanitizeMcpErrorText, sanitizeMcpText } from '../security/sanitize.js'
import type { BudgetedMcpTool, McpBudgetPlan } from './budget.js'

/** MCP 参数由 server 侧 schema 约束；客户端只保证"单个 JSON 对象"这一形状 */
const passthroughParamsSchema = z.looseObject({})
type McpToolParams = z.infer<typeof passthroughParamsSchema>

type McpCallData = Readonly<{
  structuredContent?: unknown
}>

/** Catalog tools only depend on this session-bound call capability, not a concrete pool. */
export interface McpToolCallPort {
  callTool(
    server: EffectiveMcpServer | string,
    toolName: string,
    args: Record<string, unknown> | undefined,
    options?: { signal?: AbortSignal; elicitationSink?: McpElicitationSink },
  ): Promise<CallToolResult>
}

interface McpContentProjection {
  text: string[]
  images: ImageRef[]
  artifacts: ToolArtifact[]
}

function projectMcpContent(blocks: readonly ContentBlock[]): McpContentProjection {
  const text: string[] = []
  const images: ImageRef[] = []
  const artifacts: ToolArtifact[] = []

  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        text.push(block.text)
        break
      case 'image':
        images.push({ base64: block.data, mediaType: block.mimeType })
        break
      case 'audio':
        artifacts.push({
          kind: 'mcp_audio',
          payload: { mimeType: block.mimeType, dataBase64: block.data },
        })
        break
      case 'resource': {
        const resource = block.resource
        if ('text' in resource) {
          text.push(resource.text)
        } else if (resource.mimeType?.startsWith('image/')) {
          images.push({ base64: resource.blob, mediaType: resource.mimeType })
        } else if (resource.mimeType?.startsWith('audio/')) {
          artifacts.push({
            kind: 'mcp_audio',
            payload: { mimeType: resource.mimeType, dataBase64: resource.blob },
          })
        } else {
          text.push(`[MCP binary resource: ${resource.uri} (${resource.mimeType ?? 'unknown type'})]`)
        }
        break
      }
      case 'resource_link':
        text.push(`[MCP resource: ${block.name} (${block.uri})]`)
        break
      default: {
        const unsupported: never = block
        return unsupported
      }
    }
  }

  return { text, images, artifacts }
}

export function reduceMcpResult(
  result: CallToolResult,
  server?: EffectiveMcpServer,
): ToolOutput<McpCallData> {
  const projection = projectMcpContent(result.content)
  const mediaNote = projection.artifacts.length > 0
    ? `[返回了 ${projection.artifacts.length} 个音频块，已交前端播放]`
    : ''
  const text = [...projection.text, mediaNote].filter(Boolean).join('\n')
  const data: McpCallData | undefined = result.structuredContent !== undefined
    ? { structuredContent: result.structuredContent }
    : undefined

  if (result.isError) {
    return {
      ok: false,
      text: sanitizeMcpText(text || 'MCP tool reported an error without a message.', {
        server,
        maxLength: 4_096,
      }),
      images: projection.images.length > 0 ? projection.images : undefined,
      artifacts: projection.artifacts.length > 0 ? projection.artifacts : undefined,
    }
  }
  return {
    ok: true,
    text: text || (projection.images.length > 0 ? '' : '(empty result)'),
    images: projection.images.length > 0 ? projection.images : undefined,
    data,
    artifacts: projection.artifacts.length > 0 ? projection.artifacts : undefined,
  }
}

// ============================================================
// elicitation 轮次通道：sink 每被调用一轮入队一项，
// 调用侧 next() 取下一轮，respond() 把用户答复送回 SDK handler
// ============================================================

interface ElicitationRound {
  request: McpElicitationRequest
  respond(response: McpElicitationResponse): void
}

interface ElicitationChannel {
  sink(request: McpElicitationRequest): Promise<McpElicitationResponse>
  next(): Promise<ElicitationRound>
}

function createElicitationChannel(): ElicitationChannel {
  const queued: ElicitationRound[] = []
  const waiting: Array<(round: ElicitationRound) => void> = []
  return {
    sink(request) {
      return new Promise<McpElicitationResponse>((respond) => {
        const round: ElicitationRound = { request, respond }
        const waiter = waiting.shift()
        if (waiter) waiter(round)
        else queued.push(round)
      })
    },
    next() {
      const round = queued.shift()
      if (round) return Promise.resolve(round)
      return new Promise<ElicitationRound>((resolve) => waiting.push(resolve))
    },
  }
}

interface ElicitationField {
  name: string
  schema: Record<string, unknown>
}

function elicitationFields(requestedSchema: Record<string, unknown>): ElicitationField[] {
  const properties = requestedSchema.properties
  if (!properties || typeof properties !== 'object') return []
  return Object.entries(properties as Record<string, unknown>)
    .filter((pair): pair is [string, Record<string, unknown>] =>
      typeof pair[1] === 'object' && pair[1] !== null)
    .map(([name, schema]) => ({ name, schema }))
}

/** requestedSchema（扁平原语字段表）→ ask_user 形态问题列表，字段序即问题序 */
function elicitationQuestions(request: McpElicitationRequest): SuspensionQuestion[] {
  const fields = elicitationFields(request.requestedSchema)
  if (fields.length === 0) {
    return [{ question: request.message || '服务器请求补充输入' }]
  }
  return fields.map(({ name, schema }, index) => {
    const title = typeof schema.title === 'string' ? schema.title : name
    const description = typeof schema.description === 'string' ? `（${schema.description}）` : ''
    const label = `${title}${description}`
    const question = index === 0 && request.message ? `${request.message}\n${label}` : label
    const itemEnum = Array.isArray((schema.items as Record<string, unknown> | undefined)?.enum)
      ? ((schema.items as Record<string, unknown>).enum as unknown[])
      : undefined
    if (itemEnum) return { question, options: itemEnum.map(String), multiSelect: true }
    if (Array.isArray(schema.enum)) return { question, options: schema.enum.map(String) }
    if (schema.type === 'boolean') return { question, options: ['true', 'false'] }
    return { question }
  })
}

function coerceElicitationValue(schema: Record<string, unknown>, raw: string): McpElicitationValue {
  if (schema.type === 'boolean') {
    return ['true', '是', 'yes', 'y', '1'].includes(raw.trim().toLowerCase())
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    const value = Number(raw)
    if (!Number.isNaN(value)) return schema.type === 'integer' ? Math.trunc(value) : value
  }
  if (schema.type === 'array') {
    // 多选答案由面板以「、」连接（自由输入可能用半角逗号）
    return raw.split(/[、,]/).map((item) => item.trim()).filter(Boolean)
  }
  return raw
}

/** 答案按字段序回填为 elicitation content；空答案的非必填字段省略 */
function buildElicitationContent(
  requestedSchema: Record<string, unknown>,
  answers: string[],
): Record<string, McpElicitationValue> {
  const fields = elicitationFields(requestedSchema)
  const required = new Set(
    Array.isArray(requestedSchema.required) ? requestedSchema.required.map(String) : [],
  )
  const content: Record<string, McpElicitationValue> = {}
  fields.forEach(({ name, schema }, index) => {
    const raw = answers[index] ?? ''
    if (raw === '' && !required.has(name)) return
    content[name] = coerceElicitationValue(schema, raw)
  })
  return content
}

class McpProxyTool implements ITool<McpToolParams, McpCallData> {
  readonly def: ToolDef<McpToolParams>

  constructor(
    private readonly server: EffectiveMcpServer,
    private readonly budgeted: BudgetedMcpTool,
    private readonly pool: McpToolCallPort,
  ) {
    this.def = {
      name: budgeted.visibleName,
      description: budgeted.description,
      schema: passthroughParamsSchema,
      scope: 'shared',
      effects: ['external'],
    }
  }

  async execute(
    params: McpToolParams,
    ctx: ToolContext,
  ): Promise<ToolOutput<McpCallData> | ToolSuspension> {
    const channel = createElicitationChannel()
    const callPromise: Promise<ToolOutput<McpCallData>> = this.pool
      .callTool(this.server, this.budgeted.tool, params as Record<string, unknown>, {
        signal: ctx.signal,
        elicitationSink: channel.sink,
      })
      .then(
        (result) => reduceMcpResult(result, this.server),
        (error: unknown) => {
          if (isMcpAbortError(error, ctx.signal)) throw ctx.signal.reason ?? error
          return {
            ok: false as const,
            text: sanitizeMcpErrorText(error, { server: this.server, maxLength: 4_096 }),
          }
        },
      )
    return this.awaitRound(callPromise, channel)
  }

  /**
   * 等待在途调用出结果，或服务器发起下一轮 elicitation。
   * elicitation 先到 → 带续跑挂起：用户作答喂回 handler（SDK 完成两种协议
   * 各自的续跑），再等下一轮或最终结果——多轮追问自然递归。
   */
  private async awaitRound(
    callPromise: Promise<ToolOutput<McpCallData>>,
    channel: ElicitationChannel,
  ): Promise<ToolOutput<McpCallData> | ToolSuspension> {
    const winner = await Promise.race([
      callPromise.then((result) => ({ kind: 'done' as const, result })),
      channel.next().then((round) => ({ kind: 'elicit' as const, round })),
    ])
    if (winner.kind === 'done') return winner.result

    const { request, respond } = winner.round
    return {
      suspended: true,
      reason: 'user_input',
      continuation: {
        questions: elicitationQuestions(request),
        resume: async (answers) => {
          respond({
            action: 'accept',
            content: buildElicitationContent(request.requestedSchema, answers),
          })
          return this.awaitRound(callPromise, channel)
        },
        cancel: () => {
          respond({ action: 'cancel' })
        },
      },
    }
  }
}

function toDefinitionSchema(inputSchema: Record<string, unknown>): ToolInputSchema {
  const rest = { ...inputSchema }
  delete rest.$schema
  return {
    ...rest,
    type: 'object',
    properties: (rest.properties && typeof rest.properties === 'object'
      ? rest.properties
      : {}) as Record<string, unknown>,
  }
}

/**
 * 由预算切分结果物化本次注入的 MCP 条目（hidden server / hidden tool 不产条目）。
 */
export function buildMcpCatalogEntries(
  plan: McpBudgetPlan,
  pool: McpToolCallPort,
): CatalogEntry[] {
  const entries: CatalogEntry[] = []
  for (const serverPlan of plan.servers) {
    if (serverPlan.exposure === 'hidden') continue
    for (const budgeted of serverPlan.tools) {
      entries.push(Object.freeze({
        modelName: budgeted.visibleName,
        tool: new McpProxyTool(serverPlan.server, budgeted, pool),
        trust: 'custom',
        identity: {
          kind: 'mcp' as const,
          server: serverPlan.server.name,
          tool: budgeted.tool,
          transport: serverPlan.server.transport,
          origin: serverPlan.server.origin,
        },
        exposure: serverPlan.exposure,
        definitionOverride: {
          name: budgeted.visibleName,
          description: budgeted.description,
          input_schema: toDefinitionSchema(budgeted.inputSchema),
        },
      }))
    }
  }
  return entries
}
