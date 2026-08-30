/**
 * mcp__{server}__{tool} visible-name generation.
 *
 * Sanitizing, truncation, and hash suffixes only affect the model-visible name. Raw protocol
 * identity remains structured on CatalogEntry.identity and is used for tools/call.
 */

import { createHash } from 'node:crypto'

export const MCP_NAME_PREFIX = 'mcp__'
const MAX_NAME_LENGTH = 64
const IDENTITY_SUFFIX_LENGTH = 12

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/** A raw identity always maps to the same name, independent of discovery/admission order. */
export function mcpVisibleName(server: string, tool: string): string {
  const safeServer = sanitizeSegment(server)
  const safeTool = sanitizeSegment(tool)
  const base = `${MCP_NAME_PREFIX}${safeServer}__${safeTool}`
  if (safeServer === server && safeTool === tool && base.length <= MAX_NAME_LENGTH) return base

  const suffix = createHash('sha1')
    .update(server)
    .update('\0')
    .update(tool)
    .digest('hex')
    .slice(0, IDENTITY_SUFFIX_LENGTH)
  const trimmed = base.slice(
    0,
    Math.max(MCP_NAME_PREFIX.length, MAX_NAME_LENGTH - IDENTITY_SUFFIX_LENGTH - 1),
  )
  return `${trimmed}_${suffix}`
}

export interface NamedMcpTool {
  server: string
  /** Raw protocol name. */
  tool: string
  visibleName: string
}

/** Exact duplicate identities and the vanishingly rare fixed-name hash collision are unavailable. */
export function assignVisibleNames(
  items: ReadonlyArray<{ server: string; tool: string }>,
): { named: NamedMcpTool[]; duplicates: Array<{ server: string; tool: string }> } {
  const seenRaw = new Set<string>()
  const used = new Set<string>()
  const named: NamedMcpTool[] = []
  const duplicates: Array<{ server: string; tool: string }> = []

  for (const item of items) {
    const rawKey = `${item.server}\0${item.tool}`
    if (seenRaw.has(rawKey)) {
      duplicates.push({ server: item.server, tool: item.tool })
      continue
    }
    seenRaw.add(rawKey)

    const name = mcpVisibleName(item.server, item.tool)
    if (used.has(name)) {
      duplicates.push({ server: item.server, tool: item.tool })
      continue
    }
    used.add(name)
    named.push({ server: item.server, tool: item.tool, visibleName: name })
  }

  return { named, duplicates }
}
