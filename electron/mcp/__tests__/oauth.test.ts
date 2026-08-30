import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { OAuthFlowError, performOAuthLogin, probeOAuthSupport } from '../client/oauth/flow.js'
import {
  credentialFilePath,
  findIssuerRecordByResource,
  getValidAccessToken,
  removeResource,
  resolveOAuthCredentialIdentity,
  saveIssuerRecord,
} from '../client/oauth/store.js'

const temporaryDirectories: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
  for (const server of servers.splice(0)) server.close()
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'piskie-oauth-'))
  temporaryDirectories.push(directory)
  return directory
}

async function listen(server: Server): Promise<string> {
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('listen failed')
  return `http://127.0.0.1:${address.port}`
}

describe('OAuth 凭据存储', () => {
  it('显式登录轮换持久 generation，logout 清除 resource identity', async () => {
    const root = await temporaryDirectory()
    const resource = 'https://mcp.example/account'
    const accessToken = 'top-secret-access-token'
    await saveIssuerRecord(root, {
      issuer: 'https://as.example',
      clientId: 'client-1',
      tokenEndpoint: 'https://as.example/token',
      tokens: { accessToken },
      resources: [resource],
    })

    const first = await resolveOAuthCredentialIdentity(root, resource)
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(first).not.toContain(accessToken)
    const persisted = JSON.parse(await readFile(credentialFilePath(root), 'utf8')) as {
      issuers: Record<string, { credentialGeneration?: string; tokens: { accessToken: string } }>
    }
    expect(persisted.issuers['https://as.example']?.credentialGeneration).toBeTruthy()
    expect(persisted.issuers['https://as.example']?.credentialGeneration).not.toBe(accessToken)

    await saveIssuerRecord(root, {
      issuer: 'https://as.example',
      clientId: 'client-1',
      tokenEndpoint: 'https://as.example/token',
      tokens: { accessToken: 'second-token' },
      resources: [resource],
    })
    const second = await resolveOAuthCredentialIdentity(root, resource)
    expect(second).not.toBe(first)

    expect(await removeResource(root, resource)).toBe(true)
    expect(await resolveOAuthCredentialIdentity(root, resource)).toBeUndefined()

    await saveIssuerRecord(root, {
      issuer: 'https://as.example',
      clientId: 'client-1',
      tokenEndpoint: 'https://as.example/token',
      tokens: { accessToken: 'third-token' },
      resources: [resource],
    })
    expect(await resolveOAuthCredentialIdentity(root, resource)).not.toBe(second)
  })

  it('同一 resource 重登到新 issuer 时新账号唯一生效', async () => {
    const root = await temporaryDirectory()
    const resource = 'https://mcp.example/moved-issuer'
    await saveIssuerRecord(root, {
      issuer: 'https://old-as.example',
      clientId: 'old-client',
      tokenEndpoint: 'https://old-as.example/token',
      tokens: { accessToken: 'old-token' },
      resources: [resource],
    })
    const oldIdentity = await resolveOAuthCredentialIdentity(root, resource)

    await saveIssuerRecord(root, {
      issuer: 'https://new-as.example',
      clientId: 'new-client',
      tokenEndpoint: 'https://new-as.example/token',
      tokens: { accessToken: 'new-token' },
      resources: [resource],
    })

    expect((await findIssuerRecordByResource(root, resource))?.issuer)
      .toBe('https://new-as.example')
    expect(await resolveOAuthCredentialIdentity(root, resource)).not.toBe(oldIdentity)
    const persisted = JSON.parse(await readFile(credentialFilePath(root), 'utf8')) as {
      issuers: Record<string, unknown>
    }
    expect(persisted.issuers['https://old-as.example']).toBeUndefined()
  })

  it('两个 issuer 并发保存时整文件事务不丢失任一记录', async () => {
    const root = await temporaryDirectory()
    await Promise.all([
      saveIssuerRecord(root, {
        issuer: 'https://as-a.example',
        clientId: 'client-a',
        tokenEndpoint: 'https://as-a.example/token',
        tokens: { accessToken: 'token-a' },
        resources: ['https://mcp-a.example/api'],
      }),
      saveIssuerRecord(root, {
        issuer: 'https://as-b.example',
        clientId: 'client-b',
        tokenEndpoint: 'https://as-b.example/token',
        tokens: { accessToken: 'token-b' },
        resources: ['https://mcp-b.example/api'],
      }),
    ])

    expect((await findIssuerRecordByResource(root, 'https://mcp-a.example/api'))?.issuer)
      .toBe('https://as-a.example')
    expect((await findIssuerRecordByResource(root, 'https://mcp-b.example/api'))?.issuer)
      .toBe('https://as-b.example')
  })

  it('旧 version 1 文件无 generation 时仍能得到稳定、不含 token 的 identity', async () => {
    const root = await temporaryDirectory()
    const file = credentialFilePath(root)
    const accessToken = 'legacy-secret-token'
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({
      version: 1,
      issuers: {
        'https://legacy-as.example': {
          issuer: 'https://legacy-as.example',
          clientId: 'legacy-client',
          tokenEndpoint: 'https://legacy-as.example/token',
          tokens: { accessToken },
          resources: ['https://legacy-mcp.example/api'],
        },
      },
    }), 'utf8')

    const first = await resolveOAuthCredentialIdentity(root, 'https://legacy-mcp.example/api')
    const second = await resolveOAuthCredentialIdentity(root, 'https://legacy-mcp.example/api')
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(second).toBe(first)
    expect(first).not.toContain(accessToken)
  })

  it('按 issuer 保存、按 resource 查找、logout 移除', async () => {
    const root = await temporaryDirectory()
    await saveIssuerRecord(root, {
      issuer: 'https://as.example',
      clientId: 'client-1',
      tokenEndpoint: 'https://as.example/token',
      tokens: { accessToken: 'at-1' },
      resources: ['https://mcp.example/a'],
    })

    const record = await findIssuerRecordByResource(root, 'https://mcp.example/a')
    expect(record?.tokens.accessToken).toBe('at-1')
    expect(await findIssuerRecordByResource(root, 'https://mcp.example/other')).toBeUndefined()

    // 同 issuer 二次登录另一 resource：resources 合并而不是覆盖
    await saveIssuerRecord(root, {
      issuer: 'https://as.example',
      clientId: 'client-1',
      tokenEndpoint: 'https://as.example/token',
      tokens: { accessToken: 'at-2' },
      resources: ['https://mcp.example/b'],
    })
    expect((await findIssuerRecordByResource(root, 'https://mcp.example/a'))?.tokens.accessToken).toBe('at-2')

    expect(await removeResource(root, 'https://mcp.example/a')).toBe(true)
    expect(await findIssuerRecordByResource(root, 'https://mcp.example/a')).toBeUndefined()
    expect(await findIssuerRecordByResource(root, 'https://mcp.example/b')).toBeDefined()
    expect(await removeResource(root, 'https://mcp.example/nope')).toBe(false)
  })

  it('未过期直接返回；无凭据返回 undefined', async () => {
    const root = await temporaryDirectory()
    await saveIssuerRecord(root, {
      issuer: 'https://as.example',
      clientId: 'c',
      tokenEndpoint: 'https://as.example/token',
      tokens: { accessToken: 'fresh', expiresAt: Date.now() + 3600_000 },
      resources: ['https://mcp.example/x'],
    })
    expect(await getValidAccessToken(root, 'https://mcp.example/x')).toBe('fresh')
    expect(await getValidAccessToken(root, 'https://unknown.example')).toBeUndefined()
  })

  it('临期 token 自动刷新，并发请求只打一次 token endpoint', async () => {
    const root = await temporaryDirectory()
    let refreshHits = 0
    const as = createServer((req, res) => {
      if (req.url === '/token' && req.method === 'POST') {
        refreshHits += 1
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ access_token: `refreshed-${refreshHits}`, expires_in: 3600 }))
        return
      }
      res.writeHead(404).end()
    })
    const asBase = await listen(as)

    await saveIssuerRecord(root, {
      issuer: asBase,
      clientId: 'c',
      tokenEndpoint: `${asBase}/token`,
      tokens: { accessToken: 'stale', refreshToken: 'rt-1', expiresAt: Date.now() - 1000 },
      resources: ['https://mcp.example/y'],
    })
    const identityBeforeRefresh = await resolveOAuthCredentialIdentity(root, 'https://mcp.example/y')

    const results = await Promise.all([
      getValidAccessToken(root, 'https://mcp.example/y'),
      getValidAccessToken(root, 'https://mcp.example/y'),
      getValidAccessToken(root, 'https://mcp.example/y'),
    ])
    expect(results).toEqual(['refreshed-1', 'refreshed-1', 'refreshed-1'])
    expect(refreshHits).toBe(1)

    // 刷新结果已事务化写回
    const record = await findIssuerRecordByResource(root, 'https://mcp.example/y')
    expect(record?.tokens.accessToken).toBe('refreshed-1')
    expect(await resolveOAuthCredentialIdentity(root, 'https://mcp.example/y'))
      .toBe(identityBeforeRefresh)
  })

  it('logout 与在途 refresh 竞态时不会被迟到写回复活', async () => {
    const root = await temporaryDirectory()
    let markRefreshStarted!: () => void
    let releaseRefresh!: () => void
    const refreshStarted = new Promise<void>((resolve) => { markRefreshStarted = resolve })
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve })
    const as = createServer(async (req, res) => {
      if (req.url !== '/token' || req.method !== 'POST') {
        res.writeHead(404).end()
        return
      }
      markRefreshStarted()
      await refreshGate
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ access_token: 'too-late', expires_in: 3600 }))
    })
    const asBase = await listen(as)
    const resource = 'https://mcp.example/logout-race'
    await saveIssuerRecord(root, {
      issuer: asBase,
      clientId: 'client',
      tokenEndpoint: `${asBase}/token`,
      tokens: {
        accessToken: 'expired',
        refreshToken: 'refresh',
        expiresAt: Date.now() - 1_000,
      },
      resources: [resource],
    })

    const refreshing = getValidAccessToken(root, resource)
    await refreshStarted
    expect(await removeResource(root, resource)).toBe(true)
    releaseRefresh()

    expect(await refreshing).toBeUndefined()
    expect(await findIssuerRecordByResource(root, resource)).toBeUndefined()
    expect(await resolveOAuthCredentialIdentity(root, resource)).toBeUndefined()
  })

  it('过期且无 refresh token 时返回 undefined（不抛）', async () => {
    const root = await temporaryDirectory()
    await saveIssuerRecord(root, {
      issuer: 'https://as.example',
      clientId: 'c',
      tokenEndpoint: 'https://as.example/token',
      tokens: { accessToken: 'stale', expiresAt: Date.now() - 1000 },
      resources: ['https://mcp.example/z'],
    })
    expect(await getValidAccessToken(root, 'https://mcp.example/z')).toBeUndefined()
  })
})

interface FakeAuthServerOptions {
  /** 带 scope 的授权请求回 error=invalid_scope（测无 scope 重试） */
  rejectScopes?: boolean
  /** 回调里带上的 iss（缺省 = 真实 issuer；用于测 RFC 9207 校验） */
  issOverride?: string
  scopesSupported?: string[]
}

/** 假 authorization server + 受保护 MCP endpoint（同一 origin） */
async function startFakeAuthServer(options: FakeAuthServerOptions = {}) {
  const state = { tokenRequests: [] as URLSearchParams[], issuedCode: 'authcode-1' }
  let base = ''
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', base)
    if (url.pathname === '/mcp') {
      res.writeHead(401, {
        'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
      })
      res.end()
      return
    }
    if (url.pathname === '/.well-known/oauth-protected-resource') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        resource: `${base}/mcp`,
        authorization_servers: [base],
        ...(options.scopesSupported ? { scopes_supported: options.scopesSupported } : {}),
      }))
      return
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        code_challenge_methods_supported: ['S256'],
      }))
      return
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ client_id: 'registered-client' }))
      return
    }
    if (url.pathname === '/authorize') {
      const redirect = new URL(url.searchParams.get('redirect_uri')!)
      redirect.searchParams.set('state', url.searchParams.get('state')!)
      if (options.rejectScopes && url.searchParams.get('scope')) {
        redirect.searchParams.set('error', 'invalid_scope')
      } else {
        redirect.searchParams.set('code', state.issuedCode)
        redirect.searchParams.set('iss', options.issOverride ?? base)
      }
      res.writeHead(302, { location: redirect.href })
      res.end()
      return
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString() })
      req.on('end', () => {
        const params = new URLSearchParams(body)
        state.tokenRequests.push(params)
        if (params.get('code') !== state.issuedCode || !params.get('code_verifier')) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid_grant' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          access_token: 'flow-at',
          refresh_token: 'flow-rt',
          expires_in: 3600,
          scope: params.get('scope') ?? undefined,
        }))
      })
      return
    }
    res.writeHead(404).end()
  })
  base = await listen(server)
  return { base, state }
}

/** 模拟浏览器：请求授权 URL 并跟随 302 到本地回调 */
async function fakeBrowser(url: string): Promise<void> {
  await fetch(url, { redirect: 'follow' })
}

describe('OAuth 授权流（假 AS 全链）', () => {
  it('探测 401 + resource_metadata → metadata 解析', async () => {
    const { base } = await startFakeAuthServer()
    const probe = await probeOAuthSupport(`${base}/mcp`)
    expect(probe.supported).toBe(true)
    expect(probe.metadata?.issuer).toBe(base)
    expect(probe.metadata?.token_endpoint).toBe(`${base}/token`)
  })

  it('未要求鉴权的 server 探测为不支持', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
    const base = await listen(server)
    expect((await probeOAuthSupport(`${base}/mcp`)).supported).toBe(false)
  })

  it('PKCE 全链：动态注册 → 授权 → 兑换 → 凭据按 issuer 落盘', async () => {
    const root = await temporaryDirectory()
    const { base, state } = await startFakeAuthServer()

    const result = await performOAuthLogin({
      serverName: 'fake',
      config: { url: `${base}/mcp` },
      configRoot: root,
      openAuthorizationUrl: fakeBrowser,
      onProgress: () => undefined,
    })
    expect(result.issuer).toBe(base)

    // PKCE verifier 确实上送
    expect(state.tokenRequests).toHaveLength(1)
    expect(state.tokenRequests[0]!.get('code_verifier')).toBeTruthy()
    expect(state.tokenRequests[0]!.get('client_id')).toBe('registered-client')

    const record = await findIssuerRecordByResource(root, `${base}/mcp`)
    expect(record?.tokens.accessToken).toBe('flow-at')
    expect(record?.tokens.refreshToken).toBe('flow-rt')
  })

  it('回调 iss 与 issuer 不一致时拒绝兑换（RFC 9207）', async () => {
    const root = await temporaryDirectory()
    const { base, state } = await startFakeAuthServer({ issOverride: 'https://attacker.example' })

    await expect(performOAuthLogin({
      serverName: 'fake',
      config: { url: `${base}/mcp` },
      configRoot: root,
      openAuthorizationUrl: fakeBrowser,
      onProgress: () => undefined,
    })).rejects.toSatisfy((cause: unknown) =>
      cause instanceof OAuthFlowError && cause.code === 'ISS_MISMATCH')
    expect(state.tokenRequests).toHaveLength(0)
  })

  it('provider 拒绝发现得到的 scope 时无 scope 重试一次', async () => {
    const root = await temporaryDirectory()
    const { base, state } = await startFakeAuthServer({
      rejectScopes: true,
      scopesSupported: ['mcp.read', 'mcp.write'],
    })

    const result = await performOAuthLogin({
      serverName: 'fake',
      config: { url: `${base}/mcp` },
      configRoot: root,
      openAuthorizationUrl: fakeBrowser,
      onProgress: () => undefined,
    })
    expect(result.issuer).toBe(base)
    // 第二轮（无 scope）成功兑换
    expect(state.tokenRequests).toHaveLength(1)
  })

  it('显式 scope 被拒时不重试（只有发现级 scope 才自动降级）', async () => {
    const root = await temporaryDirectory()
    const { base } = await startFakeAuthServer({ rejectScopes: true })

    await expect(performOAuthLogin({
      serverName: 'fake',
      config: { url: `${base}/mcp` },
      configRoot: root,
      scopes: ['explicit.scope'],
      openAuthorizationUrl: fakeBrowser,
      onProgress: () => undefined,
    })).rejects.toSatisfy((cause: unknown) =>
      cause instanceof OAuthFlowError && cause.code === 'AUTHORIZATION_DENIED')
  })

  it('授权窗口关闭会立即取消回调等待，不悬挂到五分钟超时', async () => {
    const root = await temporaryDirectory()
    const { base } = await startFakeAuthServer()
    const controller = new AbortController()

    await expect(performOAuthLogin({
      serverName: 'cancelled',
      config: { url: `${base}/mcp` },
      configRoot: root,
      signal: controller.signal,
      openAuthorizationUrl: () => {
        controller.abort(new OAuthFlowError('AUTHORIZATION_CANCELLED', 'window closed'))
      },
      onProgress: () => undefined,
    })).rejects.toSatisfy((cause: unknown) =>
      cause instanceof OAuthFlowError && cause.code === 'AUTHORIZATION_CANCELLED')
  })

  it('stdio server 无 OAuth 登录', async () => {
    const root = await temporaryDirectory()
    await expect(performOAuthLogin({
      serverName: 'stdio-one',
      config: { command: 'server' },
      configRoot: root,
      onProgress: () => undefined,
    })).rejects.toSatisfy((cause: unknown) =>
      cause instanceof OAuthFlowError && cause.code === 'NOT_HTTP')
  })
})
