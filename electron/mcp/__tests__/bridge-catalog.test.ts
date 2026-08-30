import { isCallToolResult, type CallToolResult } from '@modelcontextprotocol/client'
import { describe, expect, it, vi } from 'vitest'

import type { EffectiveMcpServer, McpServerSnapshot, McpToolDescriptor } from '@shared/types/mcp.js'
import { renderToolResult } from '../../agent/conversation/model-text.js'
import type { ToolContext } from '../../tools/types.js'
import { toToolResult } from '../../tools/types.js'
import { planMcpBudget } from '../bridge/budget.js'
import { buildMcpCatalogEntries, reduceMcpResult } from '../bridge/catalog.js'
import type { McpToolCallPort } from '../bridge/catalog.js'

function protocolResult(value: unknown): CallToolResult {
  if (!isCallToolResult(value)) throw new Error('invalid MCP CallToolResult fixture')
  return value
}

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

describe('reduceMcpResult（图 D 归约）', () => {
  it('text 块拼接为主文本，structuredContent 进 data', () => {
    const output = reduceMcpResult({
      content: [
        { type: 'text', text: 'line one' },
        { type: 'text', text: 'line two' },
      ],
      structuredContent: { total: 2 },
    })
    expect(output.ok).toBe(true)
    expect(output.text).toBe('line one\nline two')
    expect(output.data).toEqual({ structuredContent: { total: 2 } })
  })

  it('isError → ok:false，文本保持 server 原文', () => {
    const output = reduceMcpResult({
      content: [{ type: 'text', text: 'rate limit exceeded' }],
      isError: true,
    })
    expect(output.ok).toBe(false)
    expect(output.text).toBe('rate limit exceeded')
  })

  it('标准 image 进入模型图片结果，只有 audio 保留 UI artifact', () => {
    const output = reduceMcpResult(protocolResult({
      content: [
        { type: 'text', text: 'chart attached' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        { type: 'audio', data: 'c291bmQ=', mimeType: 'audio/wav' },
      ],
    }))
    expect(output.images).toEqual([
      { base64: 'aGVsbG8=', mediaType: 'image/png' },
    ])
    expect(output.artifacts).toEqual([
      { kind: 'mcp_audio', payload: { mimeType: 'audio/wav', dataBase64: 'c291bmQ=' } },
    ])
    expect(output.text).toContain('chart attached')
    expect(output.text).not.toContain('aGVsbG8=')
    expect(output.text).toContain('1 个音频块')
    expect(renderToolResult(toToolResult(output), 'mcp__charts__render').content).toEqual([
      { type: 'text', text: 'chart attached\n[返回了 1 个音频块，已交前端播放]' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
      },
    ])
  })

  it('标准内嵌 resource 按内容投影，图片 blob 复用模型图片链路', () => {
    const output = reduceMcpResult(protocolResult({
      content: [
        {
          type: 'resource',
          resource: { uri: 'mcp://report/readme', mimeType: 'text/plain', text: 'resource text' },
        },
        {
          type: 'resource',
          resource: { uri: 'mcp://report/chart', mimeType: 'image/webp', blob: 'aW1hZ2U=' },
        },
        {
          type: 'resource_link',
          name: 'full report',
          uri: 'mcp://report/full',
          mimeType: 'application/pdf',
        },
      ],
    }))
    expect(output.text).toBe('resource text\n[MCP resource: full report (mcp://report/full)]')
    expect(output.images).toEqual([{ base64: 'aW1hZ2U=', mediaType: 'image/webp' }])
    expect(output.artifacts).toBeUndefined()
  })

  it('isError 仍保留协议图片，供模型和前端理解失败结果', () => {
    const output = reduceMcpResult(protocolResult({
      content: [{ type: 'image', data: 'ZmFpbHVyZQ==', mimeType: 'image/png' }],
      isError: true,
    }))
    expect(output.ok).toBe(false)
    expect(output.images).toEqual([{ base64: 'ZmFpbHVyZQ==', mediaType: 'image/png' }])
  })

  it('空 content 也给出非空文本', () => {
    expect(reduceMcpResult({ content: [] }).text).toBe('(empty result)')
  })
})

describe('buildMcpCatalogEntries', () => {
  function planFor(tools: McpToolDescriptor[]) {
    return planMcpBudget({ servers: [{ server: server('ctx7'), snapshot: snapshotOf('ctx7', tools) }] })
  }

  it('条目带 mcp identity、exposure 与原样 JSON Schema 定义', () => {
    const inputSchema = {
      type: 'object',
      properties: { libraryName: { type: 'string', description: 'Library to resolve.' } },
      required: ['libraryName'],
    }
    const plan = planFor([{ name: 'resolve-library-id', description: 'Resolve a library.', inputSchema }])
    const entries = buildMcpCatalogEntries(plan, { callTool: vi.fn() } as unknown as McpToolCallPort)

    expect(entries).toHaveLength(1)
    const entry = entries[0]
    expect(entry.modelName).toBe('mcp__ctx7__resolve-library-id')
    expect(entry.identity).toEqual({
      kind: 'mcp', server: 'ctx7', tool: 'resolve-library-id', transport: 'stdio', origin: 'global-explicit',
    })
    expect(entry.exposure).toBe('direct')
    expect(entry.definitionOverride).toEqual({
      name: 'mcp__ctx7__resolve-library-id',
      description: 'Resolve a library.',
      input_schema: { ...inputSchema, properties: inputSchema.properties },
    })
  })

  it('execute 用 raw 名上协议、透传 signal，结果走归约', async () => {
    const callTool = vi.fn(async (): Promise<CallToolResult> => ({
      content: [{ type: 'text', text: 'done' }],
    }))
    const plan = planFor([{ name: 'do.thing', inputSchema: { type: 'object', properties: {} } }])
    const entries = buildMcpCatalogEntries(plan, { callTool } as unknown as McpToolCallPort)
    const ctx = fakeCtx()

    const output = await entries[0].tool.execute({ q: 1 }, ctx)
    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ctx7' }),
      'do.thing',
      { q: 1 },
      { signal: ctx.signal, elicitationSink: expect.any(Function) },
    )
    expect(output).toMatchObject({ ok: true, text: 'done' })
  })

  it('调用抛错归约为 ok:false，不上抛', async () => {
    const callTool = vi.fn(async () => { throw new Error('spawn ENOENT') })
    const plan = planFor([{ name: 't', inputSchema: { type: 'object', properties: {} } }])
    const entries = buildMcpCatalogEntries(plan, { callTool } as unknown as McpToolCallPort)
    const output = await entries[0].tool.execute({}, fakeCtx())
    expect(output).toMatchObject({ ok: false, text: 'spawn ENOENT' })
  })

  it('普通 thrown error 与 server isError 文本在进入模型前脱敏', async () => {
    const thrownCall = vi.fn(async () => {
      throw new Error(
        '{"api-key":"model-json-secret"} https://api.test/run?token=model-query-secret',
      )
    })
    const plan = planFor([{ name: 't', inputSchema: { type: 'object', properties: {} } }])
    const thrownEntry = buildMcpCatalogEntries(
      plan,
      { callTool: thrownCall } as unknown as McpToolCallPort,
    )[0]
    const thrown = await thrownEntry.tool.execute({}, fakeCtx())
    expect(thrown).toMatchObject({ ok: false })
    expect('text' in thrown ? thrown.text : '').not.toContain('model-json-secret')
    expect('text' in thrown ? thrown.text : '').not.toContain('model-query-secret')

    const serverError = reduceMcpResult({
      content: [{ type: 'text', text: "password='server-error-secret'" }],
      isError: true,
      structuredContent: { access_token: 'structured-error-secret' },
    })
    expect(serverError.ok).toBe(false)
    expect(serverError.text).not.toContain('server-error-secret')
    expect(serverError.data).toBeUndefined()
    expect(JSON.stringify(serverError)).not.toContain('structured-error-secret')
  })

  it('Abort 保持控制流语义，不归约成普通 ToolOutput', async () => {
    const abort = new DOMException('caller stopped', 'AbortError')
    const callTool = vi.fn(async () => { throw abort })
    const plan = planFor([{ name: 't', inputSchema: { type: 'object', properties: {} } }])
    const entry = buildMcpCatalogEntries(
      plan,
      { callTool } as unknown as McpToolCallPort,
    )[0]
    const controller = new AbortController()
    controller.abort(abort)
    const ctx = { ...fakeCtx(), signal: controller.signal }
    await expect(entry.tool.execute({}, ctx)).rejects.toBe(abort)
  })

  it('hidden server 与 hidden tool 不产条目', () => {
    const bigSchema = {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 200 }, (_, i) => [`f${i}`, { type: 'string', description: 'y'.repeat(64) }]),
      ),
    }
    const plan = planFor([
      { name: 'big', inputSchema: bigSchema },
      { name: 'ok', inputSchema: { type: 'object', properties: {} } },
    ])
    const entries = buildMcpCatalogEntries(plan, { callTool: vi.fn() } as unknown as McpToolCallPort)
    expect(entries.map((entry) => entry.identity?.kind === 'mcp' ? entry.identity.tool : '')).toEqual(['ok'])
  })
})
