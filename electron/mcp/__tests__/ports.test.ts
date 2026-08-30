import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { SUPPORTED_PLUGIN_SCHEMAS } from '../../plugins/manifest.js'
import { AGENT_PLUGINS_MCP_SCHEMA } from '../../plugins/mcp-members.js'
import { projectPluginsRoot } from '../../skills/store/layout.js'
import {
  createMcpPort,
  McpPortError,
  type McpPort,
  type McpPortOptions,
} from '../ports.js'
import { configFingerprint } from '../bridge/snapshot.js'
import {
  resolveOAuthCredentialIdentity,
  saveIssuerRecord,
} from '../client/oauth/store.js'
import { projectMcpConfigPath } from '../config/project-overlay.js'
import { McpConnectionManager } from '../runtime/manager.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

async function temporaryDirectory(prefix: string): Promise<string> {
  // realpath：见 inventory.test.ts 同款注释（macOS /var → /private/var）
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)))
  temporaryDirectories.push(directory)
  return directory
}

async function makePort(
  overrides: Pick<McpPortOptions, 'onChanged'> = {},
): Promise<{ port: McpPort; configRoot: string; defaultWorkspaceDir: string }> {
  const configRoot = await temporaryDirectory('piskie-mcp-port-')
  const defaultWorkspaceDir = path.join(configRoot, 'workspace')
  const port = createMcpPort({ configRoot, defaultWorkspaceDir, ...overrides })
  return { port, configRoot, defaultWorkspaceDir }
}

async function expectPortError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise
    expect.unreachable(`expected McpPortError ${code}`)
  } catch (cause) {
    expect(cause).toBeInstanceOf(McpPortError)
    expect((cause as McpPortError).code).toBe(code)
  }
}

describe('McpPort 全局层', () => {
  it('等待统一变化通知，并仅为实际 add/remove/trust 写入发事件', async () => {
    const events: Array<{ type: string; name: string; workspace?: string }> = []
    let releaseFirst!: () => void
    const firstNotification = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const onChanged = vi.fn(async (event: { type: string; name: string; workspace?: string }) => {
      events.push(event)
      if (events.length === 1) await firstNotification
    })
    const { port } = await makePort({ onChanged })

    let addSettled = false
    const add = port.add({
      name: 'global-server',
      scope: 'user',
      config: { command: 'global-server' },
    }).finally(() => {
      addSettled = true
    })
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledOnce())
    expect(addSettled).toBe(false)
    releaseFirst()
    await add

    await port.remove('global-server', { scope: 'user' })
    const workspace = await temporaryDirectory('piskie-mcp-events-ws-')
    await port.add({
      name: 'project-server',
      scope: 'project',
      workspace,
      config: { command: 'project-server' },
    })
    await port.remove('project-server', { scope: 'project', workspace })
    await port.trustConfiguration('plugin-server', workspace, { command: 'plugin-server' })
    await port.trustConfiguration('plugin-server', workspace, { command: 'plugin-server' })

    expect(events).toEqual([
      { type: 'added', name: 'global-server' },
      { type: 'removed', name: 'global-server' },
      { type: 'added', name: 'project-server', workspace },
      { type: 'removed', name: 'project-server', workspace },
      { type: 'trusted', name: 'plugin-server', workspace },
    ])
  })

  it('search 使用 v0.1 latest，并解开 Registry server envelope', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      servers: [{
        server: {
          name: 'io.example/chinese-text',
          version: '1.2.0',
          description: '中文文本工具',
          packages: [{ registryType: 'npm', identifier: 'chinese-text' }],
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    try {
      const { port } = await makePort()
      const result = await port.search('chinese')

      const requested = new URL(String(fetcher.mock.calls[0]![0]))
      expect(requested.pathname).toBe('/v0.1/servers')
      expect(requested.searchParams.get('version')).toBe('latest')
      expect(requested.searchParams.get('limit')).toBe('100')
      expect(requested.searchParams.get('search')).toBe('chinese')
      expect(result).toEqual([expect.objectContaining({
        name: 'io.example/chinese-text',
        description: '中文文本工具',
        version: '1.2.0',
      })])
    } finally {
      fetcher.mockRestore()
    }
  })

  it('add 写入配置域并可 get/list，remove 后消失', async () => {
    const { port, configRoot } = await makePort()
    await port.add({ name: 'echo', scope: 'user', config: { command: 'echo-server', args: ['--fast'] } })

    const detail = await port.get('echo')
    expect(detail.scope).toBe('user')
    expect(detail.transport).toBe('stdio')
    expect(detail.config.args).toEqual(['--fast'])

    const listed = await port.list({ scope: 'user' })
    expect(listed.map((item) => item.name)).toEqual(['echo'])

    const document = JSON.parse(
      await readFile(path.join(configRoot, 'config', 'mcp.json'), 'utf8'),
    ) as { mcpServers: Record<string, unknown> }
    expect(Object.keys(document.mcpServers)).toEqual(['echo'])

    await port.remove('echo', { scope: 'user' })
    await expectPortError(port.get('echo'), 'NOT_FOUND')
  })

  it('安装后的 force 更新可补充并持久化 Context7 API key 环境变量', async () => {
    const { port, configRoot } = await makePort()
    await port.add({
      name: 'context7',
      scope: 'user',
      config: { command: 'npx', args: ['-y', '@upstash/context7-mcp@1.0.31'] },
    })
    await port.add({
      name: 'context7',
      scope: 'user',
      force: true,
      config: {
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp@1.0.31'],
        env: { CONTEXT7_API_KEY: 'test-key' },
      },
    })

    expect((await port.get('context7')).config.env).toEqual({ CONTEXT7_API_KEY: 'test-key' })
    const document = JSON.parse(
      await readFile(path.join(configRoot, 'config', 'mcp.json'), 'utf8'),
    ) as { mcpServers: Record<string, { env?: Record<string, string> }> }
    expect(document.mcpServers.context7?.env).toEqual({ CONTEXT7_API_KEY: 'test-key' })
  })

  it('同名重复 add 拒绝', async () => {
    const { port } = await makePort()
    await port.add({ name: 'dup', scope: 'user', config: { url: 'https://example.com/mcp' } })
    await expectPortError(
      port.add({ name: 'dup', scope: 'user', config: { command: 'other' } }),
      'SERVER_EXISTS',
    )
  })

  it('command 与 url 互斥、两者皆无拒绝', async () => {
    const { port } = await makePort()
    await expectPortError(
      port.add({ name: 'bad', scope: 'user', config: { command: 'x', url: 'https://e.com' } }),
      'INVALID_CONFIG',
    )
    await expectPortError(
      port.add({ name: 'bad', scope: 'user', config: {} }),
      'INVALID_CONFIG',
    )
  })

  it('配置域 schema 校验失败原样上抛 issue', async () => {
    const { port } = await makePort()
    // args 是 stdio 专用字段，配 url 会被域 schema 拒绝
    await expectPortError(
      port.add({ name: 'bad', scope: 'user', config: { url: 'https://e.com/mcp', args: ['x'] } }),
      'VALIDATION_FAILED',
    )
  })

  it('项目级 add 在写文件前同样拒绝错误类型与未知字段', async () => {
    const { port } = await makePort()
    const workspace = await temporaryDirectory('piskie-mcp-ws-')

    await expectPortError(
      port.add({
        name: 'wrong-type',
        scope: 'project',
        workspace,
        config: { command: 'node', args: [42] } as unknown as { command: string; args: string[] },
      }),
      'VALIDATION_FAILED',
    )
    await expectPortError(
      port.add({
        name: 'unknown-field',
        scope: 'project',
        workspace,
        config: { command: 'node', surprise: true } as unknown as { command: string },
      }),
      'VALIDATION_FAILED',
    )
    await expect(readFile(projectMcpConfigPath(workspace), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('stdio 允许持久化 2026 协议 opt-in，HTTP 使用该专属字段会被拒绝', async () => {
    const { port } = await makePort()
    await port.add({
      name: 'modern-stdio',
      scope: 'user',
      config: { command: 'modern-server', enable_2026_protocol: true },
    })
    expect((await port.get('modern-stdio')).config.enable_2026_protocol).toBe(true)

    await expectPortError(
      port.add({
        name: 'modern-http',
        scope: 'user',
        config: { url: 'https://example.com/mcp', enable_2026_protocol: true },
      }),
      'VALIDATION_FAILED',
    )
  })

  it('预算预览复用运行时切分函数，并只读复用 Manager catalog cache', async () => {
    const configRoot = await temporaryDirectory('piskie-mcp-budget-port-')
    const manager = new McpConnectionManager()
    let fetchCount = 0
    const port = createMcpPort({
      configRoot,
      readCachedCatalog: (server) => manager.cachedCatalog(server),
      onCatalogDiscovered: (server, snapshot) => manager.rememberCatalog(server, snapshot),
      snapshotFetcher: async (server) => {
        fetchCount += 1
        return {
          server: server.name,
          tools: [{
            name: 'run',
            description: server.name === 'large' ? 'x'.repeat(240) : 'small',
            inputSchema: server.name === 'large'
              ? { type: 'object', properties: { payload: { type: 'string', description: 'x'.repeat(600) } } }
              : { type: 'object', properties: {} },
          }],
          fetchedAt: new Date().toISOString(),
          configFingerprint: configFingerprint(server.config),
        }
      },
    })
    await port.add({ name: 'small', scope: 'user', config: { command: 'small-server' } })
    await port.add({ name: 'large', scope: 'user', config: { command: 'large-server' } })

    await port.probe('small')
    const preview = await port.budgetPreview({ contextWindowTokens: 2_000 })

    expect(fetchCount).toBe(2)
    expect(preview.budgetTokens).toBe(100)
    expect(preview.servers.map((server) => [server.name, server.exposure])).toEqual([
      ['small', 'direct'],
      ['large', 'deferred'],
    ])
    expect(preview.servers.every((server) => server.toolCount === 1)).toBe(true)
    expect(preview.servers.find((server) => server.name === 'large')!.projectedTokens).toBeGreaterThan(
      preview.servers.find((server) => server.name === 'small')!.projectedTokens,
    )
    await manager.dispose()
  })

  it('CLI 未注入 Manager 时 budget preview 保持 one-shot discovery', async () => {
    const configRoot = await temporaryDirectory('piskie-mcp-cli-budget-port-')
    const snapshotFetcher = vi.fn(async (server: import('@shared/types/mcp.js').EffectiveMcpServer) => ({
      server: server.name,
      tools: [],
      fetchedAt: new Date().toISOString(),
      configFingerprint: configFingerprint(server.config),
    }))
    const port = createMcpPort({ configRoot, snapshotFetcher })
    await port.add({ name: 'one-shot', scope: 'user', config: { command: 'one-shot-server' } })

    await port.budgetPreview()
    await port.budgetPreview()

    expect(snapshotFetcher).toHaveBeenCalledTimes(2)
  })

  it('Project 中探测全局 server 时使用该 Project 的 runtime workspace', async () => {
    const configRoot = await temporaryDirectory('piskie-mcp-project-probe-')
    const workspace = await temporaryDirectory('piskie-mcp-project-workspace-')
    const fetcher = vi.fn(async (server: import('@shared/types/mcp.js').EffectiveMcpServer) => ({
      server: server.name,
      tools: [],
      fetchedAt: new Date().toISOString(),
      configFingerprint: configFingerprint(server.config),
    }))
    const port = createMcpPort({
      configRoot,
      defaultWorkspaceDir: path.join(configRoot, 'workspace'),
      snapshotFetcher: fetcher,
    })
    await port.add({ name: 'global', scope: 'user', config: { command: 'global-server' } })

    await port.probe('global', { workspace })

    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]![0].workspace).toBe(workspace)
  })

  it('probe/budget/effective 共用 OAuth identity，HTTP 不跨 Session cache', async () => {
    const configRoot = await temporaryDirectory('piskie-mcp-oauth-identity-port-')
    const manager = new McpConnectionManager()
    const resource = 'https://mcp.example/identity-boundary'
    const fetched: import('@shared/types/mcp.js').EffectiveMcpServer[] = []
    const fetcher = vi.fn(async (server: import('@shared/types/mcp.js').EffectiveMcpServer) => {
      fetched.push(server)
      return {
        server: server.name,
        tools: [],
        fetchedAt: new Date().toISOString(),
        configFingerprint: configFingerprint(server.config),
      }
    })
    const port = createMcpPort({
      configRoot,
      snapshotFetcher: fetcher,
      readCachedCatalog: (server) => manager.cachedCatalog(server),
      onCatalogDiscovered: (server, snapshot) => manager.rememberCatalog(server, snapshot),
    })
    await port.add({ name: 'remote-identity', scope: 'user', config: { url: resource } })
    await saveIssuerRecord(configRoot, {
      issuer: 'https://as.example',
      clientId: 'client',
      tokenEndpoint: 'https://as.example/token',
      tokens: { accessToken: 'first-token' },
      resources: [resource],
    })
    const identity = await resolveOAuthCredentialIdentity(configRoot, resource)

    expect((await port.effective()).servers[0]?.oauthCredentialIdentity).toBe(identity)
    await port.probe('remote-identity')
    await port.budgetPreview()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetched[0]?.oauthCredentialIdentity).toBe(identity)
    expect(fetched[1]?.oauthCredentialIdentity).toBe(identity)

    expect(await port.logout('remote-identity')).toEqual({ removed: true })
    expect((await port.effective()).servers[0]?.oauthCredentialIdentity).toBeUndefined()
    await port.probe('remote-identity')
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(fetched[2]?.oauthCredentialIdentity).toBeUndefined()

    await saveIssuerRecord(configRoot, {
      issuer: 'https://as.example',
      clientId: 'client',
      tokenEndpoint: 'https://as.example/token',
      tokens: { accessToken: 'second-token' },
      resources: [resource],
    })
    await port.budgetPreview()
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(fetched[3]?.oauthCredentialIdentity).toBe(
      await resolveOAuthCredentialIdentity(configRoot, resource),
    )
    expect(fetched[3]?.oauthCredentialIdentity).not.toBe(identity)
    await manager.dispose()
  })

  it('onboard 使用短超时预取 tools/list 并写入 Manager 安全目录缓存', async () => {
    const configRoot = await temporaryDirectory('piskie-mcp-onboard-')
    const manager = new McpConnectionManager()
    const fetcher = vi.fn(async (server: import('@shared/types/mcp.js').EffectiveMcpServer) => ({
      server: server.name,
      protocolVersion: '2025-06-18',
      tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }],
      fetchedAt: new Date().toISOString(),
      configFingerprint: configFingerprint(server.config),
    }))
    const oauthProber = vi.fn()
    const onCatalogDiscovered = vi.fn((
      server: import('@shared/types/mcp.js').EffectiveMcpServer,
      snapshot: import('@shared/types/mcp.js').McpServerSnapshot,
    ) => manager.rememberCatalog(server, snapshot))
    const port = createMcpPort({
      configRoot,
      onboardingTimeoutSec: 2,
      snapshotFetcher: fetcher,
      oauthProber,
      readCachedCatalog: (server) => manager.cachedCatalog(server),
      onCatalogDiscovered,
    })
    await port.add({ name: 'echo', scope: 'user', config: { command: 'echo-server' } })

    const onboarding = await port.onboard('echo', { login: true })

    expect(onboarding).toMatchObject({
      oauth: { supported: false },
      probe: { protocolVersion: '2025-06-18', toolCount: 1 },
      warnings: [],
    })
    expect(oauthProber).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]![0].config.startup_timeout_sec).toBe(2)
    expect(onCatalogDiscovered).toHaveBeenCalledOnce()
    expect(onCatalogDiscovered.mock.calls[0]![0]).toMatchObject({ name: 'echo' })
    expect(onCatalogDiscovered.mock.calls[0]![1]).toMatchObject({ server: 'echo' })

    await port.budgetPreview()
    expect(fetcher).toHaveBeenCalledOnce()
    await manager.dispose()
  })

  it('onboard 的 OAuth 登录可选，后置失败只返回 warning 不回滚配置', async () => {
    const configRoot = await temporaryDirectory('piskie-mcp-onboard-http-')
    const realPort = createMcpPort({
      configRoot,
      snapshotFetcher: async () => { throw new Error('server unavailable') },
      oauthProber: async () => ({
        supported: true,
        metadata: {
          issuer: 'https://issuer.example.com',
          authorization_endpoint: 'https://issuer.example.com/authorize',
          token_endpoint: 'https://issuer.example.com/token',
        },
      }),
    })
    await realPort.add({ name: 'remote', scope: 'user', config: { url: 'https://remote.example.com/mcp' } })
    const login = vi.fn(async () => ({ issuer: 'https://issuer.example.com' }))
    const port: McpPort = { ...realPort, login }

    const deferred = await port.onboard('remote', { login: false })
    expect(login).not.toHaveBeenCalled()
    expect(deferred.oauth).toMatchObject({ supported: true, authenticated: false })
    expect(deferred.warnings.join('\n')).toContain('piskie mcp login remote')
    expect(deferred.warnings.join('\n')).toContain('server unavailable')

    const immediate = await port.onboard('remote', { login: true })
    expect(login).toHaveBeenCalledOnce()
    expect(immediate.oauth).toMatchObject({
      supported: true,
      authenticated: true,
      issuer: 'https://issuer.example.com',
    })
    expect((await realPort.get('remote')).config.url).toBe('https://remote.example.com/mcp')
  })

  it('probe、onboard 与预算预览不会把 MCP 配置 secret 带到管理面', async () => {
    const configRoot = await temporaryDirectory('piskie-mcp-safe-errors-')
    const headerSecret = 'configured-header-secret'
    const querySecret = 'configured-query-secret'
    const rawFailure = `upstream echoed ${headerSecret} and ${querySecret}`
    const realPort = createMcpPort({
      configRoot,
      snapshotFetcher: async () => { throw new Error(rawFailure) },
      oauthProber: async () => ({
        supported: true,
        metadata: {
          issuer: 'https://issuer.example.com',
          authorization_endpoint: 'https://issuer.example.com/authorize',
          token_endpoint: 'https://issuer.example.com/token',
        },
      }),
    })
    await realPort.add({
      name: 'safe-boundary',
      scope: 'user',
      config: {
        url: `https://remote.example.com/mcp?tenant=${querySecret}`,
        http_headers: { Authorization: `Bearer ${headerSecret}` },
      },
    })
    const port: McpPort = {
      ...realPort,
      authStatus: async (name) => ({ name, method: 'oauth', authenticated: false }),
      login: async () => { throw new Error(`access_token=${headerSecret}`) },
    }

    const onboarding = await port.onboard('safe-boundary', { login: true })
    const onboardingText = onboarding.warnings.join('\n')
    expect(onboardingText).toContain('[redacted]')
    expect(onboardingText).not.toContain(headerSecret)
    expect(onboardingText).not.toContain(querySecret)

    try {
      await realPort.probe('safe-boundary')
      expect.unreachable('expected MCP probe to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(McpPortError)
      expect((error as McpPortError).code).toBe('PROBE_FAILED')
      expect((error as Error).message).not.toContain(headerSecret)
      expect((error as Error).message).not.toContain(querySecret)
    }
    const preview = await realPort.budgetPreview()
    expect(JSON.stringify(preview)).toContain('[redacted]')
    expect(JSON.stringify(preview)).not.toContain(headerSecret)
    expect(JSON.stringify(preview)).not.toContain(querySecret)
  })

  it('OAuth login 保留稳定错误码与可复制授权 URL，同时脱敏错误', async () => {
    const configRoot = await temporaryDirectory('piskie-mcp-safe-oauth-')
    const headerSecret = 'oauth-header-secret'
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.startsWith('https://remote.example.com/mcp')) {
        return new Response('', {
          status: 401,
          headers: {
            'www-authenticate': 'Bearer resource_metadata="https://auth.example.com/resource"',
          },
        })
      }
      if (url === 'https://auth.example.com/resource') {
        return new Response(JSON.stringify({ authorization_servers: ['https://auth.example.com'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url === 'https://auth.example.com/.well-known/oauth-authorization-server') {
        return new Response(JSON.stringify({
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('', { status: 404 })
    })
    try {
      const port = createMcpPort({ configRoot })
      await port.add({
        name: 'safe-oauth',
        scope: 'user',
        config: {
          url: 'https://remote.example.com/mcp',
          http_headers: { Authorization: `Bearer ${headerSecret}` },
          oauth: { client_id: 'public-client-id' },
        },
      })
      const log = vi.fn()

      try {
        await port.login('safe-oauth', {
          log,
          openAuthorizationUrl: async () => {
            throw new Error(`authorization opener echoed ${headerSecret}`)
          },
        })
        expect.unreachable('expected OAuth login to fail')
      } catch (error) {
        expect(error).toBeInstanceOf(McpPortError)
        expect((error as McpPortError).code).toBe('OAUTH_FAILED')
        expect((error as Error).message).not.toContain(headerSecret)
      }
      expect(log).toHaveBeenCalledOnce()
      const progress = String(log.mock.calls[0]![0])
      const authorizationUrl = new URL(progress.slice(progress.indexOf('https://')))
      expect(authorizationUrl.searchParams.get('client_id')).toBe('public-client-id')
      expect(authorizationUrl.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:/)
      expect(authorizationUrl.searchParams.get('state')).toBeTruthy()
      expect(authorizationUrl.searchParams.get('code_challenge')).toBeTruthy()
      expect(progress).not.toContain(headerSecret)
    } finally {
      fetcher.mockRestore()
    }
  })
})

describe('McpPort 项目层与信任门', () => {
  it('add --scope project 写 overlay 且写入即记信任表', async () => {
    const { port } = await makePort()
    const workspace = await temporaryDirectory('piskie-mcp-ws-')

    const added = await port.add({
      name: 'repo-tool',
      scope: 'project',
      workspace,
      config: { command: 'repo-tool-server' },
    })
    expect(added.trusted).toBe(true)

    const overlay = JSON.parse(await readFile(projectMcpConfigPath(workspace), 'utf8')) as {
      mcpServers: Record<string, unknown>
    }
    expect(Object.keys(overlay.mcpServers)).toEqual(['repo-tool'])

    const listed = await port.list({ scope: 'project', workspace })
    expect(listed).toHaveLength(1)
    expect(listed[0]!.trusted).toBe(true)
  })

  it('随仓库到达的 overlay 条目默认未信任，trust 后过门', async () => {
    const { port } = await makePort()
    const workspace = await temporaryDirectory('piskie-mcp-ws-')
    await mkdir(path.dirname(projectMcpConfigPath(workspace)), { recursive: true })
    await writeFile(
      projectMcpConfigPath(workspace),
      JSON.stringify({ mcpServers: { arrived: { command: 'arrived-server' } } }),
      'utf8',
    )

    const before = await port.list({ scope: 'project', workspace })
    expect(before[0]!.trusted).toBe(false)

    await port.trust('arrived', workspace)
    const after = await port.list({ scope: 'project', workspace })
    expect(after[0]!.trusted).toBe(true)
  })

  it('配置内容一变即需重新确认', async () => {
    const { port } = await makePort()
    const workspace = await temporaryDirectory('piskie-mcp-ws-')
    await port.add({
      name: 'mutating',
      scope: 'project',
      workspace,
      config: { command: 'server', args: ['--v1'] },
    })
    expect((await port.list({ scope: 'project', workspace }))[0]!.trusted).toBe(true)

    // 模拟仓库内配置被改动（args 多一个 flag）
    await writeFile(
      projectMcpConfigPath(workspace),
      JSON.stringify({ mcpServers: { mutating: { command: 'server', args: ['--v1', '--extra'] } } }),
      'utf8',
    )
    expect((await port.list({ scope: 'project', workspace }))[0]!.trusted).toBe(false)
  })

  it('项目级写入解析为缺省 workspace 时拒绝', async () => {
    const { port, defaultWorkspaceDir } = await makePort()
    await mkdir(defaultWorkspaceDir, { recursive: true })
    await expectPortError(
      port.add({
        name: 'x',
        scope: 'project',
        workspace: defaultWorkspaceDir,
        config: { command: 'server' },
      }),
      'DEFAULT_WORKSPACE',
    )
  })

  it('未过信任门的项目级 server probe 报 UNTRUSTED', async () => {
    const { port } = await makePort()
    const workspace = await temporaryDirectory('piskie-mcp-ws-')
    await mkdir(path.dirname(projectMcpConfigPath(workspace)), { recursive: true })
    await writeFile(
      projectMcpConfigPath(workspace),
      JSON.stringify({ mcpServers: { arrived: { command: 'arrived-server' } } }),
      'utf8',
    )
    await expectPortError(port.probe('arrived', { workspace }), 'UNTRUSTED')
  })

  it('project remove 只动 overlay，不影响全局同名', async () => {
    const { port } = await makePort()
    const workspace = await temporaryDirectory('piskie-mcp-ws-')
    await port.add({ name: 'both', scope: 'user', config: { command: 'global-server' } })
    await port.add({ name: 'both', scope: 'project', workspace, config: { command: 'project-server' } })

    await port.remove('both', { scope: 'project', workspace })
    expect((await port.list({ scope: 'project', workspace }))).toHaveLength(0)
    expect((await port.get('both')).config.command).toBe('global-server')
  })

  it('项目级 enabled:false 完整覆盖只隐藏当前项目，移除后重新暴露全局层', async () => {
    const { port } = await makePort()
    const workspace = await temporaryDirectory('piskie-mcp-ws-')
    await port.add({
      name: 'shared',
      scope: 'user',
      config: { command: 'global-server', args: ['--read-only'] },
    })
    await port.add({
      name: 'shared',
      scope: 'project',
      workspace,
      config: { command: 'global-server', args: ['--read-only'], enabled: false },
    })

    expect((await port.effective(workspace)).servers).toEqual([])
    expect((await port.effective()).servers[0]?.config.command).toBe('global-server')

    await port.remove('shared', { scope: 'project', workspace })
    expect((await port.effective(workspace)).servers[0]).toMatchObject({
      name: 'shared',
      origin: 'global-explicit',
      config: { command: 'global-server' },
    })
  })

  it('项目插件成员可由同名项目显式层禁用，移除覆盖后恢复插件成员', async () => {
    const { port } = await makePort()
    const workspace = await temporaryDirectory('piskie-mcp-ws-')
    const pluginDir = path.join(projectPluginsRoot(workspace), 'project-kit')
    await mkdir(pluginDir, { recursive: true })
    await writeFile(path.join(pluginDir, 'plugin.json'), JSON.stringify({
      $schema: SUPPORTED_PLUGIN_SCHEMAS[0],
      name: 'project-kit',
      version: '1.0.0',
    }), 'utf8')
    await writeFile(path.join(pluginDir, 'mcp.json'), JSON.stringify({
      $schema: AGENT_PLUGINS_MCP_SCHEMA,
      mcpServers: { shared: { type: 'stdio', command: 'project-plugin', args: ['--safe'] } },
    }), 'utf8')
    const plugin = (await port.list({ scope: 'project', workspace }))[0]!
    await port.trustConfiguration(plugin.name, workspace, plugin.config)

    await port.add({
      name: plugin.name,
      scope: 'project',
      workspace,
      config: { ...plugin.config, enabled: false },
    })
    expect((await port.effective(workspace)).servers).toEqual([])

    await port.remove(plugin.name, { scope: 'project', workspace })
    expect((await port.effective(workspace)).servers[0]).toMatchObject({
      name: 'shared',
      origin: 'project-plugin',
      plugin: 'project-kit',
    })
  })

  it('get 按完整四层优先级返回项目插件 winner，即使它尚未信任', async () => {
    const { port } = await makePort()
    const workspace = await temporaryDirectory('piskie-mcp-ws-')
    await port.add({ name: 'shared', scope: 'user', config: { command: 'global-explicit' } })

    const pluginDir = path.join(projectPluginsRoot(workspace), 'project-kit')
    await mkdir(pluginDir, { recursive: true })
    await writeFile(path.join(pluginDir, 'plugin.json'), JSON.stringify({
      $schema: SUPPORTED_PLUGIN_SCHEMAS[0],
      name: 'project-kit',
      version: '1.0.0',
    }), 'utf8')
    await writeFile(path.join(pluginDir, 'mcp.json'), JSON.stringify({
      $schema: AGENT_PLUGINS_MCP_SCHEMA,
      mcpServers: { shared: { type: 'stdio', command: 'project-plugin' } },
    }), 'utf8')

    const detail = await port.get('shared', { workspace })
    expect(detail).toMatchObject({
      scope: 'project',
      origin: 'plugin',
      plugin: 'project-kit',
      enabled: true,
      trusted: false,
    })
    expect(detail.config.command).toBe('project-plugin')
  })
})
