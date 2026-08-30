import { createUuid } from '@shared/utils/identifiers.js';
import { createHash } from 'node:crypto';
import path from 'node:path'

import type { EffectiveMcpServer, McpServerConfig } from '@shared/types/mcp.js'
import {
  resolveOAuthCredentialIdentities,
  resolveOAuthCredentialIdentity,
} from '../client/oauth/store.js'

export type ProjectContextId = string
export type McpSessionRuntimeId = string
export type LaunchFingerprint = string

export interface SessionServerRuntimeKey {
  readonly sessionRuntimeId: McpSessionRuntimeId
  readonly serverName: string
  readonly launchFingerprint: LaunchFingerprint
}

export interface ConnectionHandle {
  readonly key: SessionServerRuntimeKey
  readonly epoch: number
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function stableFingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex')
}

export function resolveMcpServerCwd(server: EffectiveMcpServer): string | undefined {
  if (server.transport !== 'stdio') return undefined
  const cwd = server.config.cwd ?? server.workspace ?? process.cwd()
  return path.resolve(server.workspace ?? process.cwd(), cwd)
}

/**
 * Resolves the local credential generation used by an HTTP launch. Only the irreversible digest
 * is attached to the effective server; raw tokens and the persisted generation stay in the store.
 */
export async function resolveMcpServerCredentialIdentity(
  configRoot: string,
  server: EffectiveMcpServer,
): Promise<EffectiveMcpServer> {
  const identity = server.transport === 'streamable_http'
    && server.config.url
    && !server.config.bearer_token_env_var
    ? await resolveOAuthCredentialIdentity(configRoot, server.config.url)
    : undefined
  if (identity === server.oauthCredentialIdentity) return server
  return { ...server, oauthCredentialIdentity: identity }
}

export async function resolveMcpServerCredentialIdentities(
  configRoot: string,
  servers: readonly EffectiveMcpServer[],
): Promise<EffectiveMcpServer[]> {
  const resourceUrls = servers.flatMap((server) => server.transport === 'streamable_http'
    && server.config.url
    && !server.config.bearer_token_env_var
    ? [server.config.url]
    : [])
  const identities = await resolveOAuthCredentialIdentities(configRoot, resourceUrls)
  return servers.map((server) => {
    const identity = server.transport === 'streamable_http'
      && server.config.url
      && !server.config.bearer_token_env_var
      ? identities.get(server.config.url)
      : undefined
    return identity === server.oauthCredentialIdentity
      ? server
      : { ...server, oauthCredentialIdentity: identity }
  })
}

function referencedEnvironment(config: McpServerConfig): Record<string, string | undefined> {
  const names = new Set<string>()
  if (config.bearer_token_env_var) names.add(config.bearer_token_env_var)
  for (const name of Object.values(config.env_http_headers ?? {})) names.add(name)
  return Object.fromEntries([...names].sort().map((name) => [name, process.env[name]]))
}

/**
 * Hashes resolved launch semantics. Secret values participate only inside the hash and are never
 * retained in a readable key or runtime view.
 */
export function launchFingerprint(server: EffectiveMcpServer): LaunchFingerprint {
  const protocolMode = server.transport === 'streamable_http'
    || server.config.enable_2026_protocol === true
    ? 'auto'
    : 'legacy'
  return stableFingerprint({
    name: server.name,
    transport: server.transport,
    command: server.config.command,
    args: server.config.args,
    url: server.config.url,
    workspace: server.workspace,
    cwd: resolveMcpServerCwd(server),
    env: server.config.env,
    headers: server.config.http_headers,
    referencedEnvironment: referencedEnvironment(server.config),
    oauthCredentialIdentity: server.oauthCredentialIdentity,
    oauth: server.config.oauth,
    oauthResource: server.config.oauth_resource,
    scopes: server.config.scopes,
    protocolMode,
    clientCapabilities: ['elicitation.form'],
    plugin: server.plugin,
    pluginVersion: server.pluginVersion,
  })
}

export function projectContextId(workspace?: string): ProjectContextId {
  return workspace ? `project:${workspace}` : 'global-default'
}

export function createSessionRuntimeId(): McpSessionRuntimeId {
  return `mcp-session-${createUuid()}`
}

export function sessionServerRuntimeKey(
  sessionRuntimeId: McpSessionRuntimeId,
  server: EffectiveMcpServer,
): SessionServerRuntimeKey {
  return Object.freeze({
    sessionRuntimeId,
    serverName: server.name,
    launchFingerprint: launchFingerprint(server),
  })
}
