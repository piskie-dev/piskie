import type { CallToolResult } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { EffectiveMcpServer, McpServerSnapshot } from '@shared/types/mcp.js'
import type { McpConnection } from '../client/connection.js'
import { capabilityFromServers } from '../runtime/capability.js'
import { McpConnectionManager } from '../runtime/manager.js'
import type { McpConnector } from '../runtime/server-runtime.js'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function server(name = 'github', command = 'mcp-server'): EffectiveMcpServer {
  return {
    name,
    origin: 'global-explicit',
    transport: 'stdio',
    config: { command },
  }
}

function live(
  target: EffectiveMcpServer,
  label: string,
  callTool = vi.fn(async () => ({ content: [{ type: 'text', text: label }] })),
): {
  connection: McpConnection
  snapshot: McpServerSnapshot
  close: ReturnType<typeof vi.fn>
  callTool: ReturnType<typeof vi.fn>
} {
  const close = vi.fn(async () => undefined)
  const connection = {
    client: { callTool } as unknown as McpConnection['client'],
    server: target,
    protocolVersion: '2025-06-18',
    isClosed: () => false,
    setElicitationSink: vi.fn(),
    close,
  }
  return {
    connection,
    snapshot: {
      server: target.name,
      protocolVersion: '2025-06-18',
      instructions: `instructions-${label}`,
      tools: [{
        name: 'search',
        description: `search-${label}`,
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
      }],
      fetchedAt: new Date().toISOString(),
      configFingerprint: `config-${label}`,
    },
    close,
    callTool,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('MCP session connection isolation', () => {
  it('同 Session 跨 turn 复用，两个 Session 的同名 server 建立独立连接', async () => {
    const connections: ReturnType<typeof live>[] = []
    const connector: McpConnector = vi.fn(async (target) => {
      const connection = live(target, `connection-${connections.length + 1}`)
      connections.push(connection)
      return connection
    })
    const manager = new McpConnectionManager({ connector })
    const target = server()
    const first = await manager.createSession({
      sessionRuntimeId: 'main-a', ownerId: 'main-a', servers: [target],
    })
    const second = await manager.createSession({
      sessionRuntimeId: 'main-b', ownerId: 'main-b', servers: [target],
    })

    first.startAll()
    second.startAll()
    await Promise.all([
      first.waitForInitialGrace(1_000),
      second.waitForInitialGrace(1_000),
    ])
    expect(connector).toHaveBeenCalledTimes(2)

    await first.call('github', 'search', { q: 1 })
    await first.call('github', 'search', { q: 2 })
    await second.call('github', 'search', { q: 3 })
    expect(connector).toHaveBeenCalledTimes(2)
    expect(connections[0].callTool).toHaveBeenCalledTimes(2)
    expect(connections[1].callTool).toHaveBeenCalledTimes(1)

    await first.release()
    expect(connections[0].close).toHaveBeenCalledTimes(1)
    expect(connections[1].close).not.toHaveBeenCalled()
    await second.call('github', 'search', { q: 4 })
    expect(connector).toHaveBeenCalledTimes(2)
    await manager.dispose()
  })

  it('不同 Session 的同名 server 工具调用可同时在途', async () => {
    const calls = [deferred<CallToolResult>(), deferred<CallToolResult>()]
    let index = 0
    const callMocks: Array<ReturnType<typeof vi.fn>> = []
    const connector: McpConnector = vi.fn(async (target) => {
      const current = index++
      const callTool = vi.fn(() => calls[current].promise)
      callMocks.push(callTool)
      return live(target, `connection-${current}`, callTool)
    })
    const manager = new McpConnectionManager({ connector })
    const target = server()
    const first = await manager.createSession({ ownerId: 'a', servers: [target] })
    const second = await manager.createSession({ ownerId: 'b', servers: [target] })
    first.startAll()
    second.startAll()
    await Promise.all([first.waitForInitialGrace(100), second.waitForInitialGrace(100)])

    const firstCall = first.call('github', 'search', {})
    const secondCall = second.call('github', 'search', {})
    await vi.waitFor(() => expect(callMocks.every((mock) => mock.mock.calls.length === 1)).toBe(true))
    calls[0].resolve({ content: [] })
    calls[1].resolve({ content: [] })
    await Promise.all([firstCall, secondCall])
    await manager.dispose()
  })
})

describe('MCP connection epochs and teardown', () => {
  it('dispose 与异步 create/prewarm 求值竞态时不会 register-after-dispose', async () => {
    const capability = capabilityFromServers({ servers: [server('late-register')] })
    const manager = new McpConnectionManager({ connector: vi.fn(async (target) => live(target, 'late')) })
    const creating = manager.createSession({ ownerId: 'main', capability })
    await manager.dispose()

    await expect(creating).rejects.toThrow('disposed')
    expect(manager.sessions()).toEqual([])

    const prewarmManager = new McpConnectionManager()
    const prewarming = prewarmManager.prewarm({ capability })
    await prewarmManager.dispose()
    await expect(prewarming).rejects.toThrow('disposed')
    expect(prewarmManager.sessions()).toEqual([])
  })

  it('transport 主动断开会立即把 owning Session 标为 failed，其他 Session 不受影响', async () => {
    let closed = false
    let notifyClose: (() => void) | undefined
    const firstConnection = live(server('events'), 'first')
    firstConnection.connection.isClosed = () => closed
    firstConnection.connection.onClose = (listener) => {
      notifyClose = listener
      return () => {
        if (notifyClose === listener) notifyClose = undefined
      }
    }
    const secondConnection = live(server('events'), 'second')
    const connector: McpConnector = vi.fn()
      .mockResolvedValueOnce(firstConnection)
      .mockResolvedValueOnce(secondConnection)
    const manager = new McpConnectionManager({ connector })
    const handle = await manager.createSession({ ownerId: 'main', servers: [server('events')] })
    handle.startAll()
    await handle.waitForInitialGrace(100)

    closed = true
    notifyClose?.()
    expect(handle.view().servers[0]).toMatchObject({
      state: 'failed',
      errorCode: 'MCP_CONNECTION_LOST',
      retryable: true,
    })

    await handle.retry(['events'])
    expect(handle.view().servers[0].state).toBe('ready')
    expect(connector).toHaveBeenCalledTimes(2)
    await manager.dispose()
  })

  it('retry 使用新 epoch，迟到的旧连接只关闭自身且不能覆盖 ready', async () => {
    type LiveResult = ReturnType<typeof live>
    const firstAttempt = deferred<LiveResult>()
    const secondAttempt = deferred<LiveResult>()
    const connector: McpConnector = vi.fn()
      .mockImplementationOnce(() => firstAttempt.promise)
      .mockImplementationOnce(() => secondAttempt.promise)
    const manager = new McpConnectionManager({ connector })
    const target = server('database')
    const handle = await manager.createSession({ ownerId: 'main', servers: [target] })
    handle.startAll()
    await vi.waitFor(() => expect(connector).toHaveBeenCalledTimes(1))

    const retry = handle.retry(['database'])
    await vi.waitFor(() => expect(connector).toHaveBeenCalledTimes(2))
    const current = live(target, 'epoch-2')
    secondAttempt.resolve(current)
    await retry
    expect(handle.view().servers[0]).toMatchObject({ state: 'ready', toolCount: 1 })

    const stale = live(target, 'epoch-1')
    firstAttempt.resolve(stale)
    await vi.waitFor(() => expect(stale.close).toHaveBeenCalledTimes(1))
    await handle.call('database', 'search', {})
    expect(current.callTool).toHaveBeenCalledTimes(1)
    await manager.dispose()
  })

  it('并发 retry 合并为同一个新 epoch connection promise', async () => {
    const first = live(server('db'), 'initial')
    const next = deferred<ReturnType<typeof live>>()
    const connector: McpConnector = vi.fn()
      .mockResolvedValueOnce(first)
      .mockImplementationOnce(() => next.promise)
    const manager = new McpConnectionManager({ connector })
    const handle = await manager.createSession({ ownerId: 'main', servers: [server('db')] })
    handle.startAll()
    await handle.waitForInitialGrace(100)

    const one = handle.retry(['db'])
    const two = handle.retry(['db'])
    await vi.waitFor(() => expect(connector).toHaveBeenCalledTimes(2))
    next.resolve(live(server('db'), 'retry'))
    await Promise.all([one, two])
    expect(handle.view().servers[0].state).toBe('ready')
    await manager.dispose()
  })

  it('release 不等待忽略 AbortSignal 的迟到 connector，并 fence/关闭迟到 transport', async () => {
    const pending = deferred<ReturnType<typeof live>>()
    const connector: McpConnector = vi.fn(() => pending.promise)
    const manager = new McpConnectionManager({ connector })
    const target = server('slow')
    const handle = await manager.createSession({ ownerId: 'worker', ownerKind: 'worker', servers: [target] })
    handle.startAll()

    await handle.release()
    expect(manager.sessions()).toEqual([])
    const late = live(target, 'late')
    pending.resolve(late)
    await vi.waitFor(() => expect(late.close).toHaveBeenCalledTimes(1))
    await manager.dispose()
  })

  it('首次边界只等待一个共享 grace，不把多个慢 server 超时相加', async () => {
    vi.useFakeTimers()
    const pending = [deferred<ReturnType<typeof live>>(), deferred<ReturnType<typeof live>>()]
    const connector: McpConnector = vi.fn(() => pending.shift()!.promise)
    const manager = new McpConnectionManager({ connector })
    const handle = await manager.createSession({
      ownerId: 'main',
      servers: [server('one'), server('two')],
    })
    const grace = handle.waitForInitialGrace(250)
    await vi.advanceTimersByTimeAsync(249)
    let settled = false
    void grace.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await grace
    await handle.release()
  })

  it('Renderer errorSummary 会清理 secret 并限制长度', async () => {
    const target = {
      ...server('broken'),
      config: { command: 'mcp-server', env: { PRIVATE_VALUE: 'unlabeled-config-secret' } },
    }
    const connector: McpConnector = vi.fn(async () => {
      throw new Error(
        `Authorization=SUPER_SECRET token=TOKEN_VALUE Bearer BEARER_VALUE unlabeled-config-secret ${'x'.repeat(1_000)}`,
      )
    })
    const manager = new McpConnectionManager({ connector })
    const handle = await manager.createSession({ ownerId: 'main', servers: [target] })
    handle.startAll()
    await handle.waitForInitialGrace(100)
    const summary = handle.view().servers[0].errorSummary ?? ''
    expect(summary).not.toContain('SUPER_SECRET')
    expect(summary).not.toContain('TOKEN_VALUE')
    expect(summary).not.toContain('BEARER_VALUE')
    expect(summary).not.toContain('unlabeled-config-secret')
    expect(summary.length).toBeLessThanOrEqual(512)
    await manager.dispose()
  })

  it('同步 throw 的 connector 也异步归约为 failed，不从 startAll 泄漏', async () => {
    const connector = vi.fn(() => {
      throw new Error('sync connector failed token=sync-secret-value')
    }) as unknown as McpConnector
    const manager = new McpConnectionManager({ connector })
    const handle = await manager.createSession({ ownerId: 'main', servers: [server('sync')] })

    expect(() => handle.startAll()).not.toThrow()
    await handle.waitForInitialGrace(100)
    expect(handle.view().servers[0]).toMatchObject({
      state: 'failed',
      errorCode: 'MCP_START_FAILED',
    })
    expect(handle.view().servers[0].errorSummary).not.toContain('sync-secret-value')
    await manager.dispose()
  })

  it('discovery 结果归一化失败时关闭刚建立的 transport', async () => {
    const connected = live(server('invalid-catalog'), 'invalid-catalog')
    const connector = vi.fn(async () => ({
      ...connected,
      snapshot: { ...connected.snapshot, tools: null },
    })) as unknown as McpConnector
    const manager = new McpConnectionManager({ connector })
    const handle = await manager.createSession({
      ownerId: 'main',
      servers: [server('invalid-catalog')],
    })

    handle.startAll()
    await handle.waitForInitialGrace(100)

    expect(handle.view().servers[0]).toMatchObject({
      state: 'failed',
      errorCode: 'MCP_START_FAILED',
    })
    expect(connected.close).toHaveBeenCalledTimes(1)
    await manager.dispose()
  })

  it('direct timeout 与 connection-lost errors 不包含 server 配置 secret', async () => {
    const configured = {
      ...server('safe-errors'),
      config: {
        command: 'mcp-server',
        env: { PRIVATE_VALUE: 'configured-tool-secret-value' },
      },
    }
    const callTool = vi.fn()
      .mockRejectedValueOnce(new Error(
        'request timeout configured-tool-secret-value https://api.test/run?token=query-secret-value',
      ))
      .mockRejectedValueOnce(Object.assign(
        new Error('socket hang up configured-tool-secret-value'),
        { code: 'ECONNRESET' },
      ))
    const manager = new McpConnectionManager({
      connector: vi.fn(async (target) => live(target, 'safe-errors', callTool)),
    })
    const handle = await manager.createSession({ ownerId: 'main', servers: [configured] })
    handle.startAll()
    await handle.waitForInitialGrace(100)

    for (const expected of ['调用超时', 'MCP_CONNECTION_LOST']) {
      try {
        await handle.call('safe-errors', 'search', {})
        throw new Error('expected MCP call to reject')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).not.toContain('configured-tool-secret-value')
        expect(message).not.toContain('query-secret-value')
        if (expected === 'MCP_CONNECTION_LOST') {
          expect(error).toMatchObject({ code: 'MCP_CONNECTION_LOST' })
        } else {
          expect(message).toContain(expected)
        }
      }
    }
    await manager.dispose()
  })

  it('caller Abort 可退出 cached/dormant startup wait，且不取消共享连接启动', async () => {
    const target = server('abort-startup')
    const pending = deferred<ReturnType<typeof live>>()
    const connector: McpConnector = vi.fn(() => pending.promise)
    const manager = new McpConnectionManager({ connector })
    const handle = await manager.createSession({ ownerId: 'worker', servers: [target] })
    const controller = new AbortController()
    const reason = new Error('caller interrupted')
    const call = handle.call('abort-startup', 'search', {}, { signal: controller.signal })
    await vi.waitFor(() => expect(connector).toHaveBeenCalledTimes(1))

    controller.abort(reason)
    await expect(call).rejects.toBe(reason)
    expect(handle.view().servers[0].state).toBe('starting')

    const connection = live(target, 'after-abort')
    pending.resolve(connection)
    await vi.waitFor(() => expect(handle.view().servers[0].state).toBe('ready'))
    await handle.call('abort-startup', 'search', {})
    expect(connection.callTool).toHaveBeenCalledTimes(1)
    await manager.dispose()
  })
})

describe('MCP catalog cache and composer ownership', () => {
  it('one-shot probe 记入的安全目录可让新 Worker dormant，但不复用 probe connection', async () => {
    const target = server('probe-cache')
    const connector: McpConnector = vi.fn(async (serverTarget) => live(serverTarget, 'worker-live'))
    const manager = new McpConnectionManager({ connector })
    manager.rememberCatalog(target, live(target, 'probe').snapshot)

    const worker = await manager.createSession({
      ownerId: 'worker', ownerKind: 'worker', servers: [target],
    })
    expect(worker.view().servers[0]).toMatchObject({
      state: 'dormant',
      catalogSource: 'cache',
    })
    worker.startAll()
    expect(connector).not.toHaveBeenCalled()
    await worker.call('probe-cache', 'search', {})
    expect(connector).toHaveBeenCalledOnce()
    await manager.dispose()
  })

  it('同一全局配置在不同 Project 使用各自 workspace identity，不跨 Project 命中 cache', async () => {
    const connector: McpConnector = vi.fn(async (target) => live(target, target.workspace ?? 'default'))
    const manager = new McpConnectionManager({ connector })
    const target = server('project-scoped-cache')
    const first = await manager.createSession({
      ownerId: 'a', workspace: '/repo/a', servers: [target],
    })
    first.startAll()
    await first.waitForInitialGrace(100)

    const second = await manager.createSession({
      ownerId: 'b', workspace: '/repo/b', servers: [target],
    })
    expect(first.capability.servers[0].workspace).toBe('/repo/a')
    expect(second.capability.servers[0].workspace).toBe('/repo/b')
    expect(second.catalogs()).toEqual([])
    await manager.dispose()
  })

  it('已决策但未发布的 catalog 不再标记为下一模型边界生效', async () => {
    const target = server('settled-hidden')
    const manager = new McpConnectionManager({
      connector: vi.fn(async () => live(target, 'settled-hidden')),
    })
    const handle = await manager.createSession({ ownerId: 'main', servers: [target] })
    handle.startAll()
    await handle.waitForInitialGrace(100)

    expect(handle.view().servers[0]).toMatchObject({
      published: false,
      appliesAt: 'next-boundary',
    })
    expect(handle.view({ settledServers: new Set([target.name]) }).servers[0]).toMatchObject({
      published: false,
      appliesAt: undefined,
    })
    await manager.dispose()
  })

  it('只共享安全 catalog，第二个 Session 仍建立自己的 live connection', async () => {
    const connections: ReturnType<typeof live>[] = []
    const connector: McpConnector = vi.fn(async (target) => {
      const connection = live(target, `${connections.length + 1}`)
      connections.push(connection)
      return connection
    })
    const manager = new McpConnectionManager({ connector })
    const target = server('cached')
    const first = await manager.createSession({ ownerId: 'a', servers: [target] })
    first.startAll()
    await first.waitForInitialGrace(100)

    const second = await manager.createSession({ ownerId: 'b', servers: [target] })
    expect(second.catalogs()[0]).toMatchObject({ source: 'cache' })
    expect(second.catalogs()[0].snapshot.instructions).toBeUndefined()
    expect(second.catalogs()[0].snapshot.tools[0].annotations).toBeUndefined()
    expect(second.view().servers[0]).toMatchObject({ state: 'not_started', catalogSource: 'cache' })

    await second.call('cached', 'search', {})
    expect(connector).toHaveBeenCalledTimes(2)
    await manager.dispose()
  })

  it('Worker 命中 exact cache 后保持 dormant，首次工具调用才建立自己的连接', async () => {
    const connector: McpConnector = vi.fn(async (target) => live(target, 'connection'))
    const manager = new McpConnectionManager({ connector })
    const target = server('worker-cache')
    const main = await manager.createSession({ ownerId: 'main', servers: [target] })
    main.startAll()
    await main.waitForInitialGrace(100)
    expect(connector).toHaveBeenCalledTimes(1)

    const worker = await manager.createSession({
      ownerId: 'worker', ownerKind: 'worker', parentCapability: main.capability,
    })
    expect(worker.view().servers[0]).toMatchObject({ state: 'dormant', catalogSource: 'cache' })
    worker.startAll()
    await Promise.resolve()
    expect(connector).toHaveBeenCalledTimes(1)
    let graceSettled = false
    void worker.waitForInitialGrace(10_000).then(() => { graceSettled = true })
    await Promise.resolve()
    expect(graceSettled).toBe(true)

    await worker.call('worker-cache', 'search', {})
    expect(connector).toHaveBeenCalledTimes(2)
    expect(worker.view().servers[0].state).toBe('ready')
    await manager.dispose()
  })

  it('prewarm exact capability 可被单个 Main 原子接管，token 随即失效', async () => {
    const connector: McpConnector = vi.fn(async (target) => live(target, 'prewarm'))
    const manager = new McpConnectionManager({ connector, prewarmTtlMs: 10_000 })
    const capability = capabilityFromServers({ servers: [server('prewarmed')] })
    const lease = await manager.prewarm({ capability })
    await vi.waitFor(() => expect(connector).toHaveBeenCalledTimes(1))

    const adopted = await manager.adoptPrewarm(lease.token, {
      sessionRuntimeId: 'ignored-on-adopt',
      ownerId: 'main-agent',
      ownerKind: 'main',
      capability,
    })
    expect(adopted?.sessionRuntimeId).toBe(lease.sessionRuntimeId)
    expect(adopted?.ownerId).toBe('main-agent')
    expect(manager.statusByPrewarmToken(lease.token)).toBeUndefined()
    expect(await manager.adoptPrewarm(lease.token, {
      ownerId: 'other', capability,
    })).toBeNull()
    expect(manager.sessions()[0]).toMatchObject({ ownerId: 'main-agent', ownerKind: 'main' })
    await manager.dispose()
  })

  it('prewarm capability mismatch 返回 null 并关闭临时 Runtime', async () => {
    const connection = live(server('one'), 'prewarm')
    const connector: McpConnector = vi.fn(async () => connection)
    const manager = new McpConnectionManager({ connector })
    const lease = await manager.prewarm({ servers: [server('one')] })
    await vi.waitFor(() => expect(connector).toHaveBeenCalledTimes(1))
    const adopted = await manager.adoptPrewarm(lease.token, {
      ownerId: 'main',
      servers: [server('two')],
    })
    expect(adopted).toBeNull()
    await vi.waitFor(() => expect(connection.close).toHaveBeenCalledTimes(1))
    expect(manager.sessions()).toEqual([])
    await manager.dispose()
  })

  it('prewarm 在 enabled_tools 等投影配置变化后不能被正式 Main adopt', async () => {
    const before = { ...server('projection'), config: {
      ...server('projection').config,
      enabled_tools: ['search'],
    } }
    const after = { ...server('projection'), config: {
      ...server('projection').config,
      enabled_tools: ['other'],
    } }
    const connection = live(before, 'prewarm')
    const connector: McpConnector = vi.fn(async () => connection)
    const manager = new McpConnectionManager({ connector })
    const lease = await manager.prewarm({ servers: [before] })
    await vi.waitFor(() => expect(connector).toHaveBeenCalledTimes(1))

    expect(await manager.adoptPrewarm(lease.token, {
      ownerId: 'main', servers: [after],
    })).toBeNull()
    await vi.waitFor(() => expect(connection.close).toHaveBeenCalledTimes(1))
    await manager.dispose()
  })

  it('未 adopt 的 prewarm 到 TTL 后自动关闭并从 Manager 移除', async () => {
    vi.useFakeTimers()
    const connection = live(server('ttl'), 'prewarm')
    const manager = new McpConnectionManager({
      connector: vi.fn(async () => connection),
      prewarmTtlMs: 25,
    })
    const lease = await manager.prewarm({ servers: [server('ttl')] })
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(25)
    await Promise.resolve()
    expect(manager.statusByPrewarmToken(lease.token)).toBeUndefined()
    expect(connection.close).toHaveBeenCalledTimes(1)
    expect(manager.sessions()).toEqual([])
    await manager.dispose()
  })
})
