import { describe, expect, it, vi } from 'vitest'

import type { EffectiveMcpServer, McpServerConfig } from '@shared/types/mcp.js'
import {
  configFingerprint,
  evaluateEffectiveServers,
  fetchServerSnapshots,
} from '../bridge/snapshot.js'
import { buildTrustRecord, isTrusted, trustKey } from '../config/trust.js'
import { McpCatalogCache } from '../runtime/catalog-cache.js'

const WS = '/real/workspace'

function stdio(command = 'run-server'): McpServerConfig {
  return { command }
}

function trusted(server: string, config: McpServerConfig) {
  return { [trustKey(WS, server, config)]: buildTrustRecord(WS, server) }
}

describe('evaluateEffectiveServers', () => {
  it('四来源同名整条覆盖：项目显式 > 项目插件 > 全局显式 > 全局插件', () => {
    const projectConfig = stdio('project-explicit-bin')
    const result = evaluateEffectiveServers({
      global: { shared: stdio('global-explicit-bin'), 'global-only': stdio() },
      globalPlugins: [{ plugin: 'gp', servers: { shared: stdio('global-plugin-bin') } }],
      projectPlugins: [{ plugin: 'pp', servers: { shared: stdio('project-plugin-bin') } }],
      projectExplicit: { shared: projectConfig },
      workspace: WS,
      trustTable: trusted('shared', projectConfig),
    })

    const shared = result.servers.find((s) => s.name === 'shared')
    expect(shared?.origin).toBe('project-explicit')
    expect(shared?.config.command).toBe('project-explicit-bin')
    expect(result.servers.find((s) => s.name === 'global-only')?.origin).toBe('global-explicit')
  })

  it('enabled=false 与勾选交集过滤', () => {
    const result = evaluateEffectiveServers({
      global: {
        a: stdio(),
        b: { ...stdio(), enabled: false },
        c: stdio(),
      },
      trustTable: {},
      selection: ['a', 'b'],
    })
    expect(result.servers.map((s) => s.name)).toEqual(['a'])
  })

  it('未过信任门的项目级 server 跳过并产出告警条目', () => {
    const result = evaluateEffectiveServers({
      global: {},
      projectExplicit: { repo: stdio() },
      workspace: WS,
      trustTable: {},
    })
    expect(result.servers).toEqual([])
    expect(result.skipped).toMatchObject([{ name: 'repo', reason: 'untrusted' }])
  })

  it('配置内容一变信任即失效（args 多一个 flag）', () => {
    const original: McpServerConfig = { command: 'srv', args: ['--a'] }
    const table = trusted('repo', original)
    expect(isTrusted(table, WS, 'repo', original)).toBe(true)
    expect(isTrusted(table, WS, 'repo', { command: 'srv', args: ['--a', '--b'] })).toBe(false)
  })

  it('合并层不改写 server 配置', () => {
    const pluginConfig: McpServerConfig = {
      ...stdio(),
      tool_timeout_sec: 42,
      enabled_tools: ['read'],
    }
    const result = evaluateEffectiveServers({
      global: {},
      globalPlugins: [{ plugin: 'p', servers: { fromPlugin: pluginConfig } }],
      trustTable: {},
    })
    expect(result.servers.find((s) => s.name === 'fromPlugin')?.config).toEqual(pluginConfig)
  })

  it('command 与 url 同时存在（非法形状）的条目不进生效集', () => {
    const result = evaluateEffectiveServers({
      global: { bad: { command: 'x', url: 'https://e.com/mcp' }, good: stdio() },
      trustTable: {},
    })
    expect(result.servers.map((s) => s.name)).toEqual(['good'])
  })
})

describe('McpCatalogCache / fetchServerSnapshots', () => {
  function server(name: string, config: McpServerConfig = stdio()): EffectiveMcpServer {
    return { name, origin: 'global-explicit', transport: 'stdio', config }
  }

  function snapshotOf(name: string, config: McpServerConfig) {
    return {
      server: name,
      tools: [],
      fetchedAt: new Date().toISOString(),
      configFingerprint: configFingerprint(config),
    }
  }

  it('App 只读 Manager cache 时命中不拉取，exact launch identity 变化后才 discovery', async () => {
    const cache = new McpCatalogCache()
    const target = server('a')
    cache.set(target, snapshotOf(target.name, target.config))
    const fetcher = vi.fn(async (s: EffectiveMcpServer) => snapshotOf(s.name, s.config))
    const onCatalogDiscovered = vi.fn()
    const options = {
      readCachedCatalog: (value: EffectiveMcpServer) => cache.snapshot(value),
      onCatalogDiscovered,
    }

    await fetchServerSnapshots([target], fetcher, options)
    expect(fetcher).not.toHaveBeenCalled()
    expect(onCatalogDiscovered).not.toHaveBeenCalled()

    const changed = server('a', { command: 'other' })
    await fetchServerSnapshots([changed], fetcher, options)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(onCatalogDiscovered).toHaveBeenCalledWith(changed, expect.objectContaining({ server: 'a' }))
  })

  it('拉取失败进 failures，不阻塞其它 server', async () => {
    const fetcher = vi.fn(async (s: EffectiveMcpServer) => {
      if (s.name === 'broken') throw new Error('spawn ENOENT')
      return snapshotOf(s.name, s.config)
    })

    const result = await fetchServerSnapshots([server('ok'), server('broken')], fetcher)
    expect([...result.snapshots.keys()]).toEqual(['ok'])
    expect(result.failures).toMatchObject([{ server: { name: 'broken' }, error: 'spawn ENOENT' }])
  })

  it('Manager cache clear 后重新拉取', async () => {
    const cache = new McpCatalogCache()
    const target = server('a')
    const fetcher = vi.fn(async (s: EffectiveMcpServer) => snapshotOf(s.name, s.config))
    cache.set(target, snapshotOf(target.name, target.config))
    cache.clear()

    await fetchServerSnapshots([target], fetcher, {
      readCachedCatalog: (value) => cache.snapshot(value),
    })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('cache key 包含 resolved launch identity，不复用不同 workspace cwd', async () => {
    const cache = new McpCatalogCache()
    const first = { ...server('same'), workspace: '/repo/one' }
    const second = { ...server('same'), workspace: '/repo/two' }
    cache.set(first, snapshotOf(first.name, first.config))

    expect(cache.snapshot(first)).toBeDefined()
    expect(cache.snapshot(second)).toBeUndefined()
  })

  it('跨 Session cache 剥离 instructions 与动态 annotations', async () => {
    const cache = new McpCatalogCache()
    const target = server('safe')
    cache.set(target, {
      ...snapshotOf('safe', target.config),
      instructions: 'session-only instructions',
      tools: [{
        name: 'read',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
      }],
    })

    const cached = cache.snapshot(target)
    expect(cached?.instructions).toBeUndefined()
    expect(cached?.tools[0].annotations).toBeUndefined()
    expect(Object.isFrozen(cached?.tools[0].inputSchema)).toBe(true)
  })

  it('HTTP catalog 不进入跨 Session cache', () => {
    const cache = new McpCatalogCache()
    const target: EffectiveMcpServer = {
      name: 'remote',
      origin: 'global-explicit',
      transport: 'streamable_http',
      config: { url: 'https://example.com/mcp' },
    }

    expect(cache.set(target, snapshotOf(target.name, target.config))).toBeUndefined()
    expect(cache.snapshot(target)).toBeUndefined()
  })
})

describe('configFingerprint', () => {
  it('与键序无关，与内容有关', () => {
    expect(configFingerprint({ command: 'x', args: ['1'] }))
      .toBe(configFingerprint({ args: ['1'], command: 'x' } as McpServerConfig))
    expect(configFingerprint({ command: 'x' }))
      .not.toBe(configFingerprint({ command: 'y' }))
  })
})
