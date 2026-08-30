import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { projectMcpConfigPath, readProjectMcpOverlay } from '../config/project-overlay.js'

let workspace: string

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'mcp-overlay-'))
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

async function writeOverlay(content: string): Promise<void> {
  const file = projectMcpConfigPath(workspace)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content, 'utf8')
}

describe('readProjectMcpOverlay', () => {
  it('文件缺失返回空表零告警', async () => {
    const overlay = await readProjectMcpOverlay(workspace)
    expect(overlay).toEqual({ servers: {}, warnings: [] })
  })

  it('读取合法 mcpServers 条目', async () => {
    await writeOverlay(JSON.stringify({
      mcpServers: {
        repo: { command: 'node', args: ['server.js'] },
        api: { url: 'https://mcp.example.com/mcp' },
      },
    }))
    const overlay = await readProjectMcpOverlay(workspace)
    expect(Object.keys(overlay.servers).sort()).toEqual(['api', 'repo'])
    expect(overlay.warnings).toEqual([])
  })

  it('非法 JSON 返回空表 + 告警（不抛出）', async () => {
    await writeOverlay('{ not json')
    const overlay = await readProjectMcpOverlay(workspace)
    expect(overlay.servers).toEqual({})
    expect(overlay.warnings).toHaveLength(1)
  })

  it('互斥/缺失传输的条目逐个跳过并告警，合法条目保留', async () => {
    await writeOverlay(JSON.stringify({
      mcpServers: {
        both: { command: 'x', url: 'https://e.com' },
        neither: { enabled: true },
        good: { command: 'ok' },
      },
    }))
    const overlay = await readProjectMcpOverlay(workspace)
    expect(Object.keys(overlay.servers)).toEqual(['good'])
    expect(overlay.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('server "both" 字段 command'),
      expect.stringContaining('server "both" 字段 url'),
      expect.stringContaining('server "neither" 字段 command'),
    ]))
  })

  it('逐 server 严格校验传输专属字段、值类型与未知字段', async () => {
    await writeOverlay(JSON.stringify({
      mcpServers: {
        httpWithArgs: { url: 'https://e.com/mcp', args: ['invalid'] },
        wrongType: { command: 'node', enabled: 'yes' },
        unknown: { command: 'node', surprise: true },
        modern: { command: 'node', enable_2026_protocol: true },
      },
    }))

    const overlay = await readProjectMcpOverlay(workspace)
    expect(overlay.servers).toEqual({
      modern: { command: 'node', enable_2026_protocol: true },
    })
    expect(overlay.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('server "httpWithArgs" 字段 args'),
      expect.stringContaining('server "wrongType" 字段 enabled'),
      expect.stringContaining('server "unknown"'),
    ]))
  })
})
