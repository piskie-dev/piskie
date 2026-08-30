import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { EffectiveMcpServer } from '@shared/types/mcp.js'

import { resolveOAuthCredentialIdentity, saveIssuerRecord } from '../client/oauth/store.js'
import {
  launchFingerprint,
  resolveMcpServerCredentialIdentity,
} from '../runtime/identity.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'piskie-mcp-identity-'))
  temporaryDirectories.push(directory)
  return directory
}

function remote(overrides: Partial<EffectiveMcpServer> = {}): EffectiveMcpServer {
  return {
    name: 'remote',
    origin: 'global-explicit',
    transport: 'streamable_http',
    config: { url: 'https://mcp.example/api' },
    ...overrides,
  }
}

describe('MCP launch credential identity', () => {
  it('keeps legacy and auto protocol modes in different launch identities', () => {
    const legacy: EffectiveMcpServer = {
      name: 'local',
      origin: 'global-explicit',
      transport: 'stdio',
      config: { command: 'node' },
    }
    const auto: EffectiveMcpServer = {
      ...legacy,
      config: { ...legacy.config, enable_2026_protocol: true },
    }

    expect(launchFingerprint(legacy)).not.toBe(launchFingerprint(auto))
  })

  it('launch fingerprint 跨 OAuth credential generation 变化', () => {
    const first = remote({ oauthCredentialIdentity: 'identity-a' })
    const second = remote({ oauthCredentialIdentity: 'identity-b' })

    expect(launchFingerprint(first)).not.toBe(launchFingerprint(second))
    expect(launchFingerprint(first)).not.toBe(launchFingerprint(remote()))
  })

  it('只把 store 的不可逆摘要附加到 EffectiveMcpServer', async () => {
    const root = await temporaryDirectory()
    const accessToken = 'never-copy-this-token'
    await saveIssuerRecord(root, {
      issuer: 'https://as.example',
      clientId: 'client',
      tokenEndpoint: 'https://as.example/token',
      tokens: { accessToken },
      resources: ['https://mcp.example/api'],
    })

    const resolved = await resolveMcpServerCredentialIdentity(root, remote())
    expect(resolved.oauthCredentialIdentity)
      .toBe(await resolveOAuthCredentialIdentity(root, 'https://mcp.example/api'))
    expect(JSON.stringify(resolved)).not.toContain(accessToken)
  })

  it('bearer 传输不误用同 URL 的 OAuth credential identity', async () => {
    const root = await temporaryDirectory()
    await saveIssuerRecord(root, {
      issuer: 'https://as.example',
      clientId: 'client',
      tokenEndpoint: 'https://as.example/token',
      tokens: { accessToken: 'oauth-token' },
      resources: ['https://mcp.example/api'],
    })

    const resolved = await resolveMcpServerCredentialIdentity(root, remote({
      config: {
        url: 'https://mcp.example/api',
        bearer_token_env_var: 'MCP_TEST_BEARER_TOKEN',
      },
    }))
    expect(resolved.oauthCredentialIdentity).toBeUndefined()
  })
})
