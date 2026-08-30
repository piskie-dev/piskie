/**
 * MCP elicitation 挂起链（catalog 侧）：
 * - 服务器发起 elicitation → McpProxyTool 返回带续跑的 ToolSuspension
 * - requestedSchema 扁平字段 → ask_user 形态问题（title/description/enum/boolean/array 多选）
 * - resume 答案按声明类型回填（boolean/number/integer/array 切分、空答案非必填省略）
 * - 多轮追问递归挂起；cancel 对服务器回 cancel
 */
import type { CallToolResult } from '@modelcontextprotocol/client'
import { describe, expect, it, vi } from 'vitest'

import type { EffectiveMcpServer, McpServerSnapshot, McpToolDescriptor } from '@shared/types/mcp.js'
import type { ToolContext, ToolOutput, ToolSuspension } from '../../tools/types.js'
import { planMcpBudget } from '../bridge/budget.js'
import { buildMcpCatalogEntries } from '../bridge/catalog.js'
import type {
  McpElicitationRequest,
  McpElicitationResponse,
  McpElicitationSink,
} from '../client/connection.js'
import type { McpToolCallPort } from '../bridge/catalog.js'

function server(name: string): EffectiveMcpServer {
  return { name, origin: 'global-explicit', transport: 'stdio', config: { command: 'srv' } }
}

function snapshotOf(name: string, tools: McpToolDescriptor[]): McpServerSnapshot {
  return { server: name, tools, fetchedAt: 't', configFingerprint: 'fp' }
}

function fakeCtx(): ToolContext {
  return {
    agentId: 'a', callId: 'c',
    workspace: { dir: '/w', tempDir: '/t' },
    signal: new AbortController().signal,
    declareTerminal: vi.fn(), post: vi.fn(() => true), log: vi.fn(),
    agentType: 'main', agentSpec: 'director', mainAgentId: 'a',
    runConfig: { name: 'run', description: '', promptTemplate: '' },
    resourceIds: {},
    currentModel: 'p::m',
    modes: { modeId: () => 'normal', approvalMode: () => 'auto' },
  }
}

interface PoolCallOptions {
  signal?: AbortSignal
  elicitationSink?: McpElicitationSink
}

/** 造一个会发起 elicitation 的假 server：每轮请求依次弹出，答复推入 received */
function buildTool(rounds: McpElicitationRequest[], received: McpElicitationResponse[]) {
  const callTool = vi.fn(async (
    _server: EffectiveMcpServer,
    _tool: string,
    _args: Record<string, unknown> | undefined,
    options?: PoolCallOptions,
  ): Promise<CallToolResult> => {
    for (const request of rounds) {
      const answer = await options!.elicitationSink!(request)
      received.push(answer)
      if (answer.action !== 'accept') {
        return { content: [{ type: 'text', text: 'request cancelled by user' }], isError: true }
      }
    }
    return { content: [{ type: 'text', text: 'final-result' }] }
  })
  const plan = planMcpBudget({
    servers: [{
      server: server('srv'),
      snapshot: snapshotOf('srv', [{ name: 'ask-me', inputSchema: { type: 'object', properties: {} } }]),
    }],
  })
  const entries = buildMcpCatalogEntries(plan, { callTool } as unknown as McpToolCallPort)
  return { tool: entries[0].tool, callTool }
}

function asSuspension(value: ToolOutput<unknown> | ToolSuspension): ToolSuspension {
  expect(value).toMatchObject({ suspended: true, reason: 'user_input' })
  return value as ToolSuspension
}

const FORM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    name: { type: 'string', title: '姓名', description: '真实姓名' },
    role: { type: 'string', enum: ['admin', 'user'] },
    confirm: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string', enum: ['a', 'b', 'c'] } },
  },
  required: ['name'],
}

describe('elicitation → ToolSuspension（问题映射）', () => {
  it('扁平字段表映射为问题列表：message 前缀首问、title+description、enum/boolean 选项、array 多选', async () => {
    const received: McpElicitationResponse[] = []
    const { tool } = buildTool([{ message: '需要补充资料', requestedSchema: FORM_SCHEMA }], received)

    const suspension = asSuspension(await tool.execute({}, fakeCtx()))
    expect(suspension.continuation).toBeDefined()
    expect(suspension.continuation!.questions).toEqual([
      { question: '需要补充资料\n姓名（真实姓名）' },
      { question: 'role', options: ['admin', 'user'] },
      { question: 'confirm', options: ['true', 'false'] },
      { question: 'tags', options: ['a', 'b', 'c'], multiSelect: true },
    ])
  })

  it('无字段 schema 退化为单问题（message 即问题）', async () => {
    const received: McpElicitationResponse[] = []
    const { tool } = buildTool([{ message: '确认继续？', requestedSchema: { type: 'object' } }], received)

    const suspension = asSuspension(await tool.execute({}, fakeCtx()))
    expect(suspension.continuation!.questions).toEqual([{ question: '确认继续？' }])
  })
})

describe('resume 答案回填（类型 coercion）', () => {
  it('boolean/enum/array 按声明类型回填，多选答案按「、」切分', async () => {
    const received: McpElicitationResponse[] = []
    const { tool } = buildTool([{ message: '', requestedSchema: FORM_SCHEMA }], received)

    const suspension = asSuspension(await tool.execute({}, fakeCtx()))
    const output = await suspension.continuation!.resume(['张三', 'admin', '是', 'a、c'])

    expect(output).toMatchObject({ ok: true, text: 'final-result' })
    expect(received).toEqual([{
      action: 'accept',
      content: { name: '张三', role: 'admin', confirm: true, tags: ['a', 'c'] },
    }])
  })

  it('number/integer 数值化（integer 截断），非数字保留原文', async () => {
    const received: McpElicitationResponse[] = []
    const schema = {
      type: 'object',
      properties: {
        count: { type: 'integer' },
        ratio: { type: 'number' },
        note: { type: 'number' },
      },
    }
    const { tool } = buildTool([{ message: '', requestedSchema: schema }], received)

    const suspension = asSuspension(await tool.execute({}, fakeCtx()))
    await suspension.continuation!.resume(['3.9', '0.5', 'abc'])

    expect(received[0]).toEqual({
      action: 'accept',
      content: { count: 3, ratio: 0.5, note: 'abc' },
    })
  })

  it('空答案：非必填字段省略，必填字段保留空串', async () => {
    const received: McpElicitationResponse[] = []
    const { tool } = buildTool([{ message: '', requestedSchema: FORM_SCHEMA }], received)

    const suspension = asSuspension(await tool.execute({}, fakeCtx()))
    await suspension.continuation!.resume(['', '', '', ''])

    expect(received[0]).toEqual({ action: 'accept', content: { name: '' } })
  })
})

describe('多轮与取消', () => {
  it('多轮追问：resume 后服务器再问 → 下一轮挂起，再答 → 最终结果', async () => {
    const received: McpElicitationResponse[] = []
    const { tool } = buildTool([
      { message: '第一轮', requestedSchema: { type: 'object', properties: { a: { type: 'string' } } } },
      { message: '第二轮', requestedSchema: { type: 'object', properties: { b: { type: 'string' } } } },
    ], received)

    const first = asSuspension(await tool.execute({}, fakeCtx()))
    expect(first.continuation!.questions[0].question).toContain('第一轮')

    const second = asSuspension(await first.continuation!.resume(['答一']))
    expect(second.continuation!.questions[0].question).toContain('第二轮')

    const output = await second.continuation!.resume(['答二'])
    expect(output).toMatchObject({ ok: true, text: 'final-result' })
    expect(received).toEqual([
      { action: 'accept', content: { a: '答一' } },
      { action: 'accept', content: { b: '答二' } },
    ])
  })

  it('cancel 对服务器回 cancel，在途调用随之退场', async () => {
    const received: McpElicitationResponse[] = []
    const { tool } = buildTool([{ message: '要登录', requestedSchema: { type: 'object' } }], received)

    const suspension = asSuspension(await tool.execute({}, fakeCtx()))
    suspension.continuation!.cancel()
    await vi.waitFor(() => expect(received).toEqual([{ action: 'cancel' }]))
  })

  it('结果先到（无 elicitation）→ 直接返回归约输出，不挂起', async () => {
    const received: McpElicitationResponse[] = []
    const { tool } = buildTool([], received)

    const output = await tool.execute({}, fakeCtx())
    expect(output).toMatchObject({ ok: true, text: 'final-result' })
  })
})
