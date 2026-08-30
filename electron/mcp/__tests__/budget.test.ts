import { describe, expect, it } from 'vitest'

import type { EffectiveMcpServer, McpServerConfig, McpServerSnapshot, McpToolDescriptor } from '@shared/types/mcp.js'
import { planMcpBudget } from '../bridge/budget.js'

function server(name: string, config: McpServerConfig = { command: 'srv' }): EffectiveMcpServer {
  return { name, origin: 'global-explicit', transport: 'stdio', config }
}

function tool(name: string, description = `${name} description`, schema: Record<string, unknown> = { type: 'object', properties: {} }): McpToolDescriptor {
  return { name, description, inputSchema: schema }
}

function snapshotOf(name: string, tools: McpToolDescriptor[], instructions?: string): McpServerSnapshot {
  return {
    server: name,
    tools,
    instructions,
    fetchedAt: '2026-08-08T00:00:00.000Z',
    configFingerprint: 'fp',
  }
}

describe('planMcpBudget 单工具门', () => {
  it('description 截断 1KB', () => {
    const plan = planMcpBudget({
      servers: [{ server: server('s'), snapshot: snapshotOf('s', [tool('t', 'x'.repeat(5000))]) }],
    })
    const budgeted = plan.servers[0].tools[0]
    expect(budgeted.description.length).toBe(1024)
    expect(budgeted.description.endsWith('…')).toBe(true)
  })

  it('schema 序列化超 8KB 的工具整条隐藏并告警', () => {
    const bigSchema = {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 200 }, (_, i) => [`field_${i}`, { type: 'string', description: 'y'.repeat(64) }]),
      ),
    }
    const plan = planMcpBudget({
      servers: [{ server: server('s'), snapshot: snapshotOf('s', [tool('big', 'd', bigSchema), tool('small')]) }],
    })
    expect(plan.servers[0].tools.map((t) => t.tool)).toEqual(['small'])
    expect(plan.servers[0].hiddenTools).toEqual([{ server: 's', tool: 'big', reason: 'schema-too-large' }])
    expect(plan.warnings.some((w) => w.includes('big') && w.includes('8KB'))).toBe(true)
  })

  it('enabled_tools 白名单先于 disabled_tools 黑名单', () => {
    const plan = planMcpBudget({
      servers: [{
        server: server('s', { command: 'srv', enabled_tools: ['a', 'b'], disabled_tools: ['b'] }),
        snapshot: snapshotOf('s', [tool('a'), tool('b'), tool('c')]),
      }],
    })
    expect(plan.servers[0].tools.map((t) => t.tool)).toEqual(['a'])
  })
})

describe('planMcpBudget 两轮装填', () => {
  it('预算充裕时全部 server 升格直注，instructions 仅直注保留', () => {
    const plan = planMcpBudget({
      servers: [
        { server: server('a'), snapshot: snapshotOf('a', [tool('t1')], 'use me well') },
        { server: server('b'), snapshot: snapshotOf('b', [tool('t2')]) },
      ],
      contextWindowTokens: 200_000,
    })
    expect(plan.servers.map((s) => s.exposure)).toEqual(['direct', 'direct'])
    expect(plan.servers[0].instructions).toBe('use me well')
    expect(plan.usedTokens).toBeLessThanOrEqual(plan.budgetTokens)
  })

  it('预算只够第一个 server 直注时，后续保持 deferred（按勾选顺序）', () => {
    const manyTools = (prefix: string) =>
      Array.from({ length: 20 }, (_, i) => tool(`${prefix}_${i}`, 'd'.repeat(500)))
    const plan = planMcpBudget({
      servers: [
        { server: server('first'), snapshot: snapshotOf('first', manyTools('f')) },
        { server: server('second'), snapshot: snapshotOf('second', manyTools('s')) },
      ],
      // 5% = 500 token：名字行放得下，直注只够一个 server
      contextWindowTokens: 200_000,
      budgetRatio: 0.02,
    })
    const exposures = plan.servers.map((s) => s.exposure)
    expect(exposures[0]).toBe('direct')
    expect(exposures[1]).toBe('deferred')
    expect(plan.servers[1].tools.every((t) => t.nameLine.startsWith('- mcp__second__'))).toBe(true)
  })

  it('极端规模：连名字行都放不下的 server 整体隐藏并告警', () => {
    const plan = planMcpBudget({
      servers: [
        {
          server: server('huge'),
          snapshot: snapshotOf('huge', Array.from({ length: 400 }, (_, i) => tool(`t${i}`, 'desc '.repeat(20)))),
        },
        { server: server('tiny'), snapshot: snapshotOf('tiny', [tool('one')]) },
      ],
      contextWindowTokens: 20_000,
      budgetRatio: 0.05,
    })
    expect(plan.servers[0].exposure).toBe('hidden')
    expect(plan.warnings.some((w) => w.includes('huge') && w.includes('隐藏'))).toBe(true)
    // 后续小 server 仍可正常参与装填
    expect(plan.servers[1].exposure).not.toBe('hidden')
  })

  it('instructions 截断 2KB 并计入直注成本', () => {
    const plan = planMcpBudget({
      servers: [{
        server: server('s'),
        snapshot: snapshotOf('s', [tool('t')], 'i'.repeat(5000)),
      }],
    })
    expect(plan.servers[0].exposure).toBe('direct')
    expect(plan.servers[0].instructions!.length).toBe(2048)
  })

  it('context_budget_ratio 可调（更小比例 → 更早停止升格）', () => {
    const manyTools = Array.from({ length: 30 }, (_, i) => tool(`t${i}`, 'd'.repeat(800)))
    const generous = planMcpBudget({
      servers: [{ server: server('s'), snapshot: snapshotOf('s', manyTools) }],
      contextWindowTokens: 200_000,
      budgetRatio: 0.05,
    })
    const strict = planMcpBudget({
      servers: [{ server: server('s'), snapshot: snapshotOf('s', manyTools) }],
      contextWindowTokens: 200_000,
      budgetRatio: 0.01,
    })
    expect(generous.servers[0].exposure).toBe('direct')
    expect(strict.servers[0].exposure).toBe('deferred')
  })
})
