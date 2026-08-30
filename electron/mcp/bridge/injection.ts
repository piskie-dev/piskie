/** Pure helpers for the per-Agent MCP model projection. Live connection ownership belongs to
 * SessionMcpRuntime; this module must never discover servers or create transports. */

export { publishGlobalMcpSnapshot } from '../runtime/capability.js'

export interface McpPromptMaterial {
  /** deferred 工具名字行（进 L5 <mcp_tools> 清单） */
  deferredLines: string[]
  /** 直注 server 的使用说明（已截断 2KB） */
  serverInstructions: Array<{ server: string; text: string }>
}

/** AgentRun 决定能力上界，Spec 只能继续取交集；结果顺序始终以 AgentRun 为准。 */
export function intersectMcpSelections(
  runSelection?: readonly string[],
  specSelection?: readonly string[],
): readonly string[] | undefined {
  if (runSelection === undefined && specSelection === undefined) return undefined
  const ordered = runSelection ?? specSelection ?? []
  const spec = specSelection === undefined ? undefined : new Set(specSelection)
  return [...new Set(ordered)].filter((name) => spec === undefined || spec.has(name))
}

/** L5 <mcp_tools> 块正文；没有任何素材时返回 undefined（不渲染空块） */
export function renderMcpPromptBlock(material: McpPromptMaterial): string | undefined {
  const sections: string[] = []
  if (material.deferredLines.length > 0) {
    sections.push(
      '以下 MCP 工具尚未装载 schema（deferred）。要使用时先调用 '
      + 'tool_search("select:<工具名>") 装载，装载后即可直接调用：',
      ...material.deferredLines,
    )
  }
  if (material.serverInstructions.length > 0) {
    for (const { server, text } of material.serverInstructions) {
      sections.push(`[server "${server}" 使用说明]\n${text}`)
    }
  }
  return sections.length > 0 ? sections.join('\n') : undefined
}
