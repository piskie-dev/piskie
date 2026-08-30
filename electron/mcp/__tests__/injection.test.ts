import { describe, expect, it } from 'vitest'

import {
  intersectMcpSelections,
  renderMcpPromptBlock,
} from '../bridge/injection.js'

describe('intersectMcpSelections', () => {
  it('Flow/Spec only intersect and retain Flow order', () => {
    expect(intersectMcpSelections(['gamma', 'alpha'], ['alpha', 'beta', 'gamma']))
      .toEqual(['gamma', 'alpha'])
    expect(intersectMcpSelections([], ['alpha'])).toEqual([])
    expect(intersectMcpSelections(['alpha'], ['beta'])).toEqual([])
    expect(intersectMcpSelections(undefined, ['beta'])).toEqual(['beta'])
    expect(intersectMcpSelections(undefined, undefined)).toBeUndefined()
  })

  it('deduplicates the selected MCP names without changing their order', () => {
    expect(intersectMcpSelections(['beta', 'alpha', 'beta'], ['alpha', 'beta']))
      .toEqual(['beta', 'alpha'])
  })
})

describe('renderMcpPromptBlock', () => {
  it('returns undefined without projection material', () => {
    expect(renderMcpPromptBlock({ deferredLines: [], serverInstructions: [] })).toBeUndefined()
  })

  it('renders deferred tool guidance and server instructions', () => {
    const block = renderMcpPromptBlock({
      deferredLines: ['- mcp__s__t: does things'],
      serverInstructions: [{ server: 's2', text: 'be gentle' }],
    })
    expect(block).toContain('tool_search("select:<工具名>")')
    expect(block).toContain('- mcp__s__t: does things')
    expect(block).toContain('[server "s2" 使用说明]\nbe gentle')
  })
})
