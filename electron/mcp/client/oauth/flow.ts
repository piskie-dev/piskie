/**
 * OAuth 2.1 + PKCE 授权流。
 *
 * - 探测：请求 MCP endpoint 期待 401 + WWW-Authenticate resource_metadata
 *   （RFC 9728），回退直接试 /.well-known/oauth-protected-resource；
 * - client 身份：配置 oauth.client_id 优先（URL 形式即 Client ID Metadata
 *   Document，authorization server 侧解引用，客户端无需特殊处理）；否则
 *   有 registration_endpoint 时走动态注册（RFC 7591 兼容回退）；
 * - scope 优先级：显式传入 > 配置域 scopes > metadata 发现；provider 拒绝
 *   已发现 scope（回调 error=invalid_scope）时自动无 scope 重试一次；
 * - iss 按 RFC 9207 校验：回调携带 iss 时必须与记录的 issuer 一致才兑换 code；
 * - 回调：本地 127.0.0.1 随机端口（CLI 场景）；授权 URL 经 openAuthorizationUrl
 *   回调打开（app 侧可换成 Electron 窗口）。
 */

import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'

import type { McpServerConfig } from '../../../../shared/types/mcp.js'
import { saveIssuerRecord, type OAuthIssuerRecord } from './store.js'

const FETCH_TIMEOUT_MS = 15_000
const CALLBACK_TIMEOUT_MS = 5 * 60_000

export class OAuthFlowError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'OAuthFlowError'
  }
}

export interface AuthServerMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  scopes_supported?: string[]
  code_challenge_methods_supported?: string[]
}

async function fetchJson(
  url: string,
  timeoutMs = FETCH_TIMEOUT_MS,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return undefined
    return await response.json() as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** RFC 9728：从 WWW-Authenticate 头提取 resource_metadata URL */
function resourceMetadataFromHeader(header: string | null): string | undefined {
  const match = header?.match(/resource_metadata="([^"]+)"/)
  return match?.[1]
}

export interface OAuthProbeResult {
  supported: boolean
  metadata?: AuthServerMetadata
  /** protected resource metadata 声明的 scopes（发现级 scope 来源） */
  scopesSupported?: string[]
}

/** 探测 server 是否要求 OAuth，并解出 authorization server metadata */
export async function probeOAuthSupport(
  serverUrl: string,
  timeoutMs = FETCH_TIMEOUT_MS,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<OAuthProbeResult> {
  let resourceMetadataUrl: string | undefined
  try {
    const response = await fetchImpl(serverUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.status !== 401) return { supported: false }
    resourceMetadataUrl = resourceMetadataFromHeader(response.headers.get('www-authenticate'))
  } catch {
    return { supported: false }
  }

  const origin = new URL(serverUrl).origin
  const candidates = [
    ...(resourceMetadataUrl ? [resourceMetadataUrl] : []),
    `${origin}/.well-known/oauth-protected-resource${new URL(serverUrl).pathname}`,
    `${origin}/.well-known/oauth-protected-resource`,
  ]

  let issuer: string | undefined
  let scopesSupported: string[] | undefined
  for (const candidate of candidates) {
    const resource = await fetchJson(candidate, timeoutMs, fetchImpl)
    const servers = resource?.authorization_servers
    if (Array.isArray(servers) && typeof servers[0] === 'string') {
      issuer = servers[0]
      if (Array.isArray(resource?.scopes_supported)) {
        scopesSupported = resource.scopes_supported.filter((s): s is string => typeof s === 'string')
      }
      break
    }
  }
  // 无 protected resource metadata 的兼容回退：server origin 即 issuer
  issuer ??= origin

  const metadata = await discoverAuthServerMetadata(issuer, timeoutMs, fetchImpl)
  if (!metadata) return { supported: true }
  return { supported: true, metadata, scopesSupported }
}

/** RFC 8414 / OIDC discovery，按 issuer 路径规则依次尝试 */
export async function discoverAuthServerMetadata(
  issuer: string,
  timeoutMs = FETCH_TIMEOUT_MS,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<AuthServerMetadata | undefined> {
  const base = new URL(issuer)
  const pathSuffix = base.pathname === '/' ? '' : base.pathname
  const candidates = [
    `${base.origin}/.well-known/oauth-authorization-server${pathSuffix}`,
    `${base.origin}${pathSuffix}/.well-known/oauth-authorization-server`,
    `${base.origin}/.well-known/openid-configuration${pathSuffix}`,
    `${base.origin}${pathSuffix}/.well-known/openid-configuration`,
  ]
  for (const candidate of candidates) {
    const raw = await fetchJson(candidate, timeoutMs, fetchImpl)
    if (raw
      && typeof raw.issuer === 'string'
      && typeof raw.authorization_endpoint === 'string'
      && typeof raw.token_endpoint === 'string') {
      return raw as unknown as AuthServerMetadata
    }
  }
  return undefined
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** RFC 7591 动态注册（Client ID Metadata Documents 不可用时的兼容回退） */
async function registerClient(
  metadata: AuthServerMetadata,
  redirectUri: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<string> {
  if (!metadata.registration_endpoint) {
    throw new OAuthFlowError(
      'NO_CLIENT_ID',
      '该 authorization server 不支持动态注册，请配置 oauth.client_id（或 --oauth-client-id）。',
    )
  }
  const response = await fetchImpl(metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'piskie',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new OAuthFlowError(
      'REGISTRATION_FAILED',
      `动态注册失败（${response.status}）：${await response.text().catch(() => '')}`,
    )
  }
  const payload = await response.json() as { client_id?: string }
  if (!payload.client_id) throw new OAuthFlowError('REGISTRATION_FAILED', '动态注册响应缺少 client_id')
  return payload.client_id
}

interface CallbackResult {
  code?: string
  state?: string
  iss?: string
  error?: string
  errorDescription?: string
}

interface CallbackServer {
  redirectUri: string
  /** 每次等待一个回调命中（no-scope 重试会等第二次） */
  next(signal?: AbortSignal): Promise<CallbackResult>
  close(): void
}

async function startCallbackServer(): Promise<CallbackServer> {
  let deliver: ((result: CallbackResult) => void) | undefined
  const pending: CallbackResult[] = []

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/callback') {
      res.writeHead(404).end()
      return
    }
    const result: CallbackResult = {
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
      iss: url.searchParams.get('iss') ?? undefined,
      error: url.searchParams.get('error') ?? undefined,
      errorDescription: url.searchParams.get('error_description') ?? undefined,
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(result.error
      ? `<html><body><h3>授权失败：${result.error}</h3><p>可回到终端查看详情。</p></body></html>`
      : '<html><body><h3>授权完成</h3><p>可以关闭此页面，回到终端继续。</p></body></html>')
    if (deliver) {
      const send = deliver
      deliver = undefined
      send(result)
    } else {
      pending.push(result)
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new OAuthFlowError('CALLBACK_FAILED', '回调端口分配失败')

  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    next: (signal) => {
      const queued = pending.shift()
      if (queued) return Promise.resolve(queued)
      return new Promise<CallbackResult>((resolve, reject) => {
        const cancel = () => {
          clearTimeout(timer)
          deliver = undefined
          reject(signal?.reason instanceof Error
            ? signal.reason
            : new OAuthFlowError('AUTHORIZATION_CANCELLED', '授权窗口已关闭'))
        }
        const timer = setTimeout(
          () => {
            signal?.removeEventListener('abort', cancel)
            deliver = undefined
            reject(new OAuthFlowError('CALLBACK_TIMEOUT', `等待浏览器授权回调超时（${CALLBACK_TIMEOUT_MS / 60000} 分钟）`))
          },
          CALLBACK_TIMEOUT_MS,
        )
        deliver = (result) => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', cancel)
          resolve(result)
        }
        if (signal?.aborted) cancel()
        else signal?.addEventListener('abort', cancel, { once: true })
      })
    },
    close: () => server.close(),
  }
}

function defaultOpenUrl(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).unref()
  } catch {
    // 打不开浏览器不致命：URL 已打印，用户可手动打开
  }
}

export interface OAuthLoginOptions {
  serverName: string
  config: McpServerConfig
  configRoot: string
  /** 显式 scope（CLI --scopes），优先级最高 */
  scopes?: string[]
  /** 授权 URL 打开方式；缺省系统浏览器。app 侧可换 Electron 窗口 */
  openAuthorizationUrl?: (url: string) => void | Promise<void>
  /** app 授权窗口关闭时取消回调等待；CLI 通常不传。 */
  signal?: AbortSignal
  /** 类型化进度把可复制授权 URL 与可脱敏普通文本分开。 */
  onProgress?: (event: OAuthProgressEvent) => void
  /** MCP server 选择的全局代理所对应的 fetch。 */
  fetch?: typeof globalThis.fetch
}

export type OAuthProgressEvent =
  | Readonly<{ kind: 'authorization_url'; url: string }>
  | Readonly<{ kind: 'status'; message: string }>

export interface OAuthLoginResult {
  issuer: string
  scope?: string
  expiresAt?: number
}

export async function performOAuthLogin(options: OAuthLoginOptions): Promise<OAuthLoginResult> {
  const serverUrl = options.config.url
  if (!serverUrl) {
    throw new OAuthFlowError('NOT_HTTP', `MCP server "${options.serverName}" 是 stdio 传输，无 OAuth 登录`)
  }
  const reportProgress = options.onProgress ?? ((_event: OAuthProgressEvent) => undefined)
  const fetchImpl = options.fetch ?? globalThis.fetch

  const probe = await probeOAuthSupport(serverUrl, FETCH_TIMEOUT_MS, fetchImpl)
  if (!probe.metadata) {
    throw new OAuthFlowError(
      'DISCOVERY_FAILED',
      probe.supported
        ? '发现失败：server 要求鉴权但未能解析 authorization server metadata'
        : '该 server 未要求 OAuth 鉴权（未返回 401），无需登录',
    )
  }
  const metadata = probe.metadata

  // scope 优先级：显式 > 配置域 > metadata 发现
  const explicitScopes = options.scopes && options.scopes.length > 0 ? options.scopes : undefined
  const configScopes = options.config.scopes && options.config.scopes.length > 0 ? options.config.scopes : undefined
  const discovered = probe.scopesSupported ?? metadata.scopes_supported
  const scopes = explicitScopes ?? configScopes ?? discovered
  const scopeFromDiscovery = !explicitScopes && !configScopes && discovered !== undefined

  const callback = await startCallbackServer()
  try {
    const clientId = options.config.oauth?.client_id
      ?? await registerClient(metadata, callback.redirectUri, fetchImpl)

    const attempt = async (
      scope: string | undefined,
    ): Promise<{ result: CallbackResult; verifier: string }> => {
      const { verifier, challenge } = pkcePair()
      const state = randomBytes(24).toString('base64url')
      const authorizeUrl = new URL(metadata.authorization_endpoint)
      authorizeUrl.searchParams.set('response_type', 'code')
      authorizeUrl.searchParams.set('client_id', clientId)
      authorizeUrl.searchParams.set('redirect_uri', callback.redirectUri)
      authorizeUrl.searchParams.set('state', state)
      authorizeUrl.searchParams.set('code_challenge', challenge)
      authorizeUrl.searchParams.set('code_challenge_method', 'S256')
      if (scope) authorizeUrl.searchParams.set('scope', scope)
      if (options.config.oauth_resource) authorizeUrl.searchParams.set('resource', options.config.oauth_resource)

      reportProgress({ kind: 'authorization_url', url: authorizeUrl.href })
      await (options.openAuthorizationUrl ?? defaultOpenUrl)(authorizeUrl.href)

      const result = await callback.next(options.signal)
      if (result.error) return { result, verifier }
      if (result.state !== state) {
        throw new OAuthFlowError('STATE_MISMATCH', '授权回调 state 不匹配，已丢弃（可能是过期回调或 CSRF）')
      }
      if (result.iss !== undefined && result.iss !== metadata.issuer) {
        throw new OAuthFlowError(
          'ISS_MISMATCH',
          `授权回调 iss（${result.iss}）与记录的 issuer（${metadata.issuer}）不一致，拒绝兑换 code`,
        )
      }
      if (!result.code) throw new OAuthFlowError('NO_CODE', '授权回调缺少 code')
      return { result, verifier }
    }

    let scopeUsed = scopes?.join(' ')
    let outcome = await attempt(scopeUsed)
    if (outcome.result.error === 'invalid_scope' && scopeFromDiscovery) {
      reportProgress({ kind: 'status', message: 'provider 拒绝了发现得到的 scope，无 scope 重试一次…' })
      scopeUsed = undefined
      outcome = await attempt(undefined)
    }
    if (outcome.result.error) {
      throw new OAuthFlowError(
        'AUTHORIZATION_DENIED',
        `授权失败：${outcome.result.error}`
        + `${outcome.result.errorDescription ? `（${outcome.result.errorDescription}）` : ''}`,
      )
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: outcome.result.code!,
      redirect_uri: callback.redirectUri,
      client_id: clientId,
      code_verifier: outcome.verifier,
    })
    if (options.config.oauth_resource) body.set('resource', options.config.oauth_resource)
    const tokenResponse = await fetchImpl(metadata.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!tokenResponse.ok) {
      throw new OAuthFlowError(
        'TOKEN_EXCHANGE_FAILED',
        `token 兑换失败（${tokenResponse.status}）：${await tokenResponse.text().catch(() => '')}`,
      )
    }
    const payload = await tokenResponse.json() as {
      access_token: string
      refresh_token?: string
      expires_in?: number
      scope?: string
    }

    const record: OAuthIssuerRecord = {
      issuer: metadata.issuer,
      clientId,
      tokenEndpoint: metadata.token_endpoint,
      tokens: {
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token,
        expiresAt: payload.expires_in !== undefined ? Date.now() + payload.expires_in * 1000 : undefined,
        scope: payload.scope ?? scopeUsed,
      },
      resources: [serverUrl],
    }
    await saveIssuerRecord(options.configRoot, record)
    return { issuer: metadata.issuer, scope: record.tokens.scope, expiresAt: record.tokens.expiresAt }
  } finally {
    callback.close()
  }
}
