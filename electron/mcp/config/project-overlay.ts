/**
 * 项目级 MCP overlay：{workspace}/.piskie/mcp.json
 *
 * 随 workspace 走的素材文件（等价 CC 的 .mcp.json），不进控制面 revision 体系；
 * 仅注入时刻读取，不 fs.watch——变更只影响之后的注入时刻。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { mcpServerConfigSchema } from '@shared/schemas/mcp.js'
import type { McpServerConfig } from '@shared/types/mcp.js'
import { PROJECT_STATE_DIR, projectStatePathForRead } from '../../skills/store/layout.js'

export interface ProjectMcpOverlay {
  servers: Record<string, McpServerConfig>
  /** 解析失败/形状非法时的说明（文件缺失不算） */
  warnings: string[]
}

export function projectMcpConfigPath(workspace: string): string {
  return path.join(workspace, PROJECT_STATE_DIR, 'mcp.json')
}

/** 读取项目级 mcp.json；文件缺失返回空表，解析失败返回空表 + warning（不阻塞注入） */
export async function readProjectMcpOverlay(workspace: string): Promise<ProjectMcpOverlay> {
  const file = await projectStatePathForRead(workspace, 'mcp.json')
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    return { servers: {}, warnings: [] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      servers: {},
      warnings: [`${file} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`],
    }
  }

  const doc = parsed as { mcpServers?: unknown }
  if (!doc || typeof doc !== 'object' || doc.mcpServers === undefined) {
    return { servers: {}, warnings: [`${file} 缺少 mcpServers 键`] }
  }
  if (typeof doc.mcpServers !== 'object' || doc.mcpServers === null || Array.isArray(doc.mcpServers)) {
    return { servers: {}, warnings: [`${file} 的 mcpServers 必须是对象`] }
  }

  const servers: Record<string, McpServerConfig> = {}
  const warnings: string[] = []
  for (const [name, value] of Object.entries(doc.mcpServers as Record<string, unknown>)) {
    const parsedServer = mcpServerConfigSchema.safeParse(value)
    if (!parsedServer.success) {
      for (const issue of parsedServer.error.issues) {
        const field = issue.path.length > 0 ? ` 字段 ${issue.path.join('.')}` : ''
        warnings.push(`server "${name}"${field}：${issue.message}，已跳过`)
      }
      continue
    }
    servers[name] = parsedServer.data
  }
  return { servers, warnings }
}
