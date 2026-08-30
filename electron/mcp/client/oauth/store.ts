import { createUuid } from '@shared/utils/identifiers.js';
/**
 * OAuth 凭据存储：不入任何配置层，独立文件按 issuer 键控
 * （规范硬要求：凭据不得跨 authorization server 复用）。
 *
 * 文件 {configRoot}/credentials/mcp-oauth.json，0600 权限。
 * 刷新并发安全：per-issuer 进程内锁 + 全文件事务化写回。
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs'
import path from 'node:path'

export interface OAuthTokenSet {
  accessToken: string
  refreshToken?: string
  /** epoch ms；无过期信息时缺省 */
  expiresAt?: number
  scope?: string
}

export interface OAuthIssuerRecord {
  issuer: string
  clientId: string
  tokenEndpoint: string
  tokens: OAuthTokenSet
  /** 该 issuer 已授权覆盖的 MCP server URL（登录时登记，查找入口） */
  resources: string[]
  /**
   * 一次显式登录产生的持久 generation。Token refresh 保留它，重新登录则轮换。
   * optional 用于兼容未包含该字段的 version 1 凭据文件。
   */
  credentialGeneration?: string
}

interface CredentialFile {
  version: 1
  issuers: Record<string, OAuthIssuerRecord>
}

const EMPTY_FILE: CredentialFile = { version: 1, issuers: {} }

/** 过期判定提前量：临期 token 视为已过期，避免请求途中失效 */
const EXPIRY_SKEW_MS = 30_000

export function credentialFilePath(configRoot: string): string {
  return path.join(configRoot, 'credentials', 'mcp-oauth.json')
}

async function readFileState(configRoot: string): Promise<CredentialFile> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(credentialFilePath(configRoot), 'utf8'))
    if (raw && typeof raw === 'object' && (raw as CredentialFile).version === 1) {
      return raw as CredentialFile
    }
  } catch {
    // 文件缺失或损坏：视为空存储
  }
  return structuredClone(EMPTY_FILE)
}

async function writeFileState(configRoot: string, state: CredentialFile): Promise<void> {
  const file = credentialFilePath(configRoot)
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${createUuid()}.tmp`
  try {
    await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(tmp, file)
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
  }
}

/** 同一 issuer 的读改写串行化（刷新锁复用同一队列） */
const issuerLocks = new Map<string, Promise<unknown>>()
/** 凭据文件是整文件 RMW；不同 issuer 也必须按 configRoot 串行提交。 */
const credentialFileLocks = new Map<string, Promise<unknown>>()

async function withLock<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  const next = previous.then(action, action)
  const settled = next.then(() => undefined, () => undefined)
  locks.set(key, settled)
  try {
    return await next
  } finally {
    if (locks.get(key) === settled) locks.delete(key)
  }
}

async function withIssuerLock<T>(issuer: string, action: () => Promise<T>): Promise<T> {
  return withLock(issuerLocks, issuer, action)
}

async function withCredentialFileLock<T>(
  configRoot: string,
  action: () => Promise<T>,
): Promise<T> {
  return withLock(credentialFileLocks, path.resolve(configRoot), action)
}

export async function saveIssuerRecord(configRoot: string, record: OAuthIssuerRecord): Promise<void> {
  await withIssuerLock(record.issuer, async () => {
    await withCredentialFileLock(configRoot, async () => {
      const state = await readFileState(configRoot)
      const existing = state.issuers[record.issuer]
      const claimedResources = new Set(record.resources)
      // One resource must resolve to exactly one issuer. If the protected-resource metadata moved
      // to another authorization server, the newest completed login atomically wins the lookup.
      for (const [issuer, previous] of Object.entries(state.issuers)) {
        if (issuer === record.issuer) continue
        const resources = previous.resources.filter((resource) => !claimedResources.has(resource))
        if (resources.length === previous.resources.length) continue
        if (resources.length === 0) delete state.issuers[issuer]
        else state.issuers[issuer] = { ...previous, resources }
      }
      const resources = [...new Set([...(existing?.resources ?? []), ...record.resources])]
      state.issuers[record.issuer] = {
        ...record,
        resources,
        // Every completed authorization is a new account/credential boundary, even when the
        // provider happens to issue the same token values for the same account.
        credentialGeneration: createUuid(),
      }
      await writeFileState(configRoot, state)
    })
  })
}

export async function findIssuerRecordByResource(
  configRoot: string,
  resourceUrl: string,
): Promise<OAuthIssuerRecord | undefined> {
  const state = await readFileState(configRoot)
  return Object.values(state.issuers).find((record) => record.resources.includes(resourceUrl))
}

/**
 * Returns an irreversible, token-independent identity for the credential used by one resource.
 * Legacy v1 records derive a stable fallback from non-secret issuer/client metadata; the next
 * explicit login persists a random generation and therefore crosses the launch boundary.
 */
export async function resolveOAuthCredentialIdentity(
  configRoot: string,
  resourceUrl: string,
): Promise<string | undefined> {
  return (await resolveOAuthCredentialIdentities(configRoot, [resourceUrl])).get(resourceUrl)
}

function credentialIdentity(record: OAuthIssuerRecord): string {
  const generation = record.credentialGeneration
    ? `generation-v1\0${record.credentialGeneration}`
    : `legacy-v1\0${record.issuer}\0${record.clientId}\0${record.tokenEndpoint}`
  return createHash('sha256')
    .update('piskie-mcp-oauth-credential\0')
    .update(generation)
    .digest('hex')
}

/** Resolves one coherent credential-file snapshot for a whole capability/effective server set. */
export async function resolveOAuthCredentialIdentities(
  configRoot: string,
  resourceUrls: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const requested = new Set(resourceUrls)
  if (requested.size === 0) return new Map()
  const state = await readFileState(configRoot)
  const identities = new Map<string, string>()
  for (const record of Object.values(state.issuers)) {
    for (const resource of record.resources) {
      // Preserve the legacy lookup order if a hand-edited old file maps one resource twice.
      if (requested.has(resource) && !identities.has(resource)) {
        identities.set(resource, credentialIdentity(record))
      }
    }
  }
  return identities
}

export async function removeResource(configRoot: string, resourceUrl: string): Promise<boolean> {
  return withCredentialFileLock(configRoot, async () => {
    const state = await readFileState(configRoot)
    let removed = false
    for (const [issuer, record] of Object.entries(state.issuers)) {
      if (!record.resources.includes(resourceUrl)) continue
      removed = true
      const remaining = record.resources.filter((resource) => resource !== resourceUrl)
      if (remaining.length === 0) delete state.issuers[issuer]
      else state.issuers[issuer] = { ...record, resources: remaining }
    }
    if (removed) await writeFileState(configRoot, state)
    return removed
  })
}

function isExpired(tokens: OAuthTokenSet): boolean {
  return tokens.expiresAt !== undefined && tokens.expiresAt - EXPIRY_SKEW_MS <= Date.now()
}

async function refreshTokens(
  record: OAuthIssuerRecord,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<OAuthTokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: record.tokens.refreshToken!,
    client_id: record.clientId,
  })
  const response = await fetchImpl(record.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    throw new Error(`OAuth token refresh failed (${response.status}): ${await response.text().catch(() => '')}`)
  }
  const payload = await response.json() as {
    access_token: string
    refresh_token?: string
    expires_in?: number
    scope?: string
  }
  return {
    accessToken: payload.access_token,
    // 未轮换 refresh token 时沿用旧值
    refreshToken: payload.refresh_token ?? record.tokens.refreshToken,
    expiresAt: payload.expires_in !== undefined ? Date.now() + payload.expires_in * 1000 : undefined,
    scope: payload.scope ?? record.tokens.scope,
  }
}

/**
 * 取该 server URL 的可用 access token：无凭据返回 undefined（server 可能本就
 * 不要求鉴权）；临期且有 refresh token 时在 issuer 锁内刷新并写回。
 */
export async function getValidAccessToken(
  configRoot: string,
  resourceUrl: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<string | undefined> {
  const record = await findIssuerRecordByResource(configRoot, resourceUrl)
  if (!record) return undefined
  if (!isExpired(record.tokens)) return record.tokens.accessToken

  if (!record.tokens.refreshToken) return undefined
  return withIssuerLock(record.issuer, async () => {
    // issuer 锁内重读：并发请求里第一个已经刷新过时直接复用。
    const current = await withCredentialFileLock(configRoot, async () =>
      (await readFileState(configRoot)).issuers[record.issuer])
    if (!current) return undefined
    if (!current.resources.includes(resourceUrl)) return undefined
    if (!isExpired(current.tokens)) return current.tokens.accessToken
    if (!current.tokens.refreshToken) return undefined
    const tokens = await refreshTokens(current, fetchImpl)
    // Network I/O never holds the whole-file lock. Commit only if logout/relogin did not change
    // this resource's owning credential while refresh was in flight.
    return withCredentialFileLock(configRoot, async () => {
      const state = await readFileState(configRoot)
      const latest = state.issuers[record.issuer]
      if (!latest || !latest.resources.includes(resourceUrl)) return undefined
      if (latest.credentialGeneration !== current.credentialGeneration) {
        return isExpired(latest.tokens) ? undefined : latest.tokens.accessToken
      }
      if (!isExpired(latest.tokens)) return latest.tokens.accessToken
      state.issuers[record.issuer] = { ...latest, tokens }
      await writeFileState(configRoot, state)
      return tokens.accessToken
    })
  })
}
