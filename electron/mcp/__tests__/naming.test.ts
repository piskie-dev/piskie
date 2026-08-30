import { describe, expect, it } from 'vitest'

import { assignVisibleNames, mcpVisibleName } from '../bridge/naming.js'

describe('mcpVisibleName', () => {
  it('简单 identity 保留明文；发生字符替换时无条件加稳定 hash', () => {
    expect(mcpVisibleName('context7', 'resolve-library-id')).toBe('mcp__context7__resolve-library-id')
    expect(mcpVisibleName('my server', 'do.things')).toMatch(
      /^mcp__my_server__do_things_[0-9a-f]{12}$/,
    )
  })

  it('超 64 字符截断并加稳定 hash', () => {
    const name = mcpVisibleName('a'.repeat(40), 'b'.repeat(40))
    expect(name.length).toBe(64)
    expect(name.startsWith('mcp__')).toBe(true)
    expect(name).toMatch(/_[0-9a-f]{12}$/)
  })
})

describe('assignVisibleNames', () => {
  it('无冲突时可见名即拼接结果', () => {
    const { named, duplicates } = assignVisibleNames([
      { server: 's1', tool: 'alpha' },
      { server: 's2', tool: 'beta' },
    ])
    expect(named.map((n) => n.visibleName)).toEqual(['mcp__s1__alpha', 'mcp__s2__beta'])
    expect(duplicates).toEqual([])
  })

  it('sanitize identity 与原生下划线 identity 的名字不依赖到达顺序', () => {
    const { named } = assignVisibleNames([
      { server: 's', tool: 'a.b' },
      { server: 's', tool: 'a_b' },
    ])
    expect(named[0].visibleName).toMatch(/^mcp__s__a_b_[0-9a-f]{12}$/)
    expect(named[1].visibleName).toBe('mcp__s__a_b')

    const reversed = assignVisibleNames([
      { server: 's', tool: 'a_b' },
      { server: 's', tool: 'a.b' },
    ]).named
    expect(Object.fromEntries(reversed.map((item) => [item.tool, item.visibleName]))).toEqual(
      Object.fromEntries(named.map((item) => [item.tool, item.visibleName])),
    )
  })

  it('截断撞名也能经后缀消歧', () => {
    const long = 'x'.repeat(80)
    const { named, duplicates } = assignVisibleNames([
      { server: 'srv', tool: `${long}1` },
      { server: 'srv', tool: `${long}2` },
    ])
    expect(duplicates).toEqual([])
    expect(new Set(named.map((n) => n.visibleName)).size).toBe(2)
    for (const n of named) expect(n.visibleName.length).toBeLessThanOrEqual(64)
  })

  it('完全相同的 (server, tool) 是重复条目，跳过并上报', () => {
    const { named, duplicates } = assignVisibleNames([
      { server: 's', tool: 't' },
      { server: 's', tool: 't' },
    ])
    expect(named).toHaveLength(1)
    expect(duplicates).toEqual([{ server: 's', tool: 't' }])
  })

  it('raw 名保持原样，只有可见名被 sanitize', () => {
    const { named } = assignVisibleNames([{ server: 's', tool: 'read.file' }])
    expect(named[0].tool).toBe('read.file')
    expect(named[0].visibleName).toMatch(/^mcp__s__read_file_[0-9a-f]{12}$/)
  })
})
