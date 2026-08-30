import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { setPilotRoot } from '@electron/piskiepilot/paths.js'
import type { EffectiveMcpServer } from '@shared/types/mcp.js'

import { SUPPORTED_PLUGIN_SCHEMAS } from '../../plugins/manifest.js'
import { AGENT_PLUGINS_MCP_SCHEMA } from '../../plugins/mcp-members.js'
import { configFingerprint } from '../bridge/snapshot.js'
import {
  removeResource,
  resolveOAuthCredentialIdentity,
  saveIssuerRecord,
} from '../client/oauth/store.js'
import { createMcpPort } from '../ports.js'
import {
  narrowMcpCapability,
  resolveMcpCapability,
} from '../runtime/capability.js'
import { launchFingerprint, resolveMcpServerCwd } from '../runtime/identity.js'
import { McpConnectionManager } from '../runtime/manager.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

async function temporaryConfigRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'piskie-mcp-capability-'))
  temporaryDirectories.push(root)
  setPilotRoot(path.join(root, 'piskiepilot'))
  return root
}

async function writeGlobalPlugin(configRoot: string, version: string): Promise<void> {
  const pluginDir = path.join(configRoot, 'plugins', 'echo-kit')
  await mkdir(pluginDir, { recursive: true })
  await writeFile(path.join(pluginDir, 'plugin.json'), JSON.stringify({
    $schema: SUPPORTED_PLUGIN_SCHEMAS[0],
    name: 'echo-kit',
    version,
  }), 'utf8')
  await writeFile(path.join(pluginDir, 'mcp.json'), JSON.stringify({
    $schema: AGENT_PLUGINS_MCP_SCHEMA,
    mcpServers: {
      echo: { type: 'stdio', command: 'echo-server' },
    },
  }), 'utf8')
}

describe('MCP capability runtime workspace', () => {
  it('OAuth 重登和登出会跨 capability/prewarm launch identity 边界', async () => {
    const configRoot = await temporaryConfigRoot()
    const resource = 'https://mcp.example/account'
    const port = createMcpPort({ configRoot })
    await port.add({ name: 'account', scope: 'user', config: { url: resource } })
    await saveIssuerRecord(configRoot, {
      issuer: 'https://as.example',
      clientId: 'client',
      tokenEndpoint: 'https://as.example/token',
      tokens: { accessToken: 'first-token' },
      resources: [resource],
    })

    const first = await resolveMcpCapability()
    const firstServer = first.servers[0]!
    expect(firstServer.oauthCredentialIdentity)
      .toBe(await resolveOAuthCredentialIdentity(configRoot, resource))
    expect((await port.effective()).servers[0]?.oauthCredentialIdentity)
      .toBe(firstServer.oauthCredentialIdentity)

    await saveIssuerRecord(configRoot, {
      issuer: 'https://as.example',
      clientId: 'client',
      tokenEndpoint: 'https://as.example/token',
      tokens: { accessToken: 'second-token' },
      resources: [resource],
    })
    const relogged = await resolveMcpCapability()
    expect(relogged.servers[0]?.oauthCredentialIdentity)
      .not.toBe(firstServer.oauthCredentialIdentity)
    expect(relogged.fingerprint).not.toBe(first.fingerprint)

    expect(await removeResource(configRoot, resource)).toBe(true)
    const loggedOut = await resolveMcpCapability()
    expect(loggedOut.servers[0]?.oauthCredentialIdentity).toBeUndefined()
    expect(loggedOut.fingerprint).not.toBe(relogged.fingerprint)
  })

  it('keeps global-default grouping while probe, budget, and Session share the default launch identity', async () => {
    const configRoot = await temporaryConfigRoot()
    const manager = new McpConnectionManager()
    const defaultWorkspace = path.join(configRoot, 'workspace')
    const fetched: EffectiveMcpServer[] = []
    const fetcher = vi.fn(async (server: EffectiveMcpServer) => {
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
      defaultWorkspaceDir: defaultWorkspace,
      snapshotFetcher: fetcher,
      readCachedCatalog: (server) => manager.cachedCatalog(server),
      onCatalogDiscovered: (server, snapshot) => manager.rememberCatalog(server, snapshot),
    })
    await port.add({ name: 'echo', scope: 'user', config: { command: 'echo-server' } })

    // Flows may pass the shared default directory explicitly; it still is not a Project layer.
    const capability = await resolveMcpCapability({ workspace: defaultWorkspace })
    expect(capability.projectContextId).toBe('global-default')
    expect(capability.workspace).toBeUndefined()
    expect(capability.servers[0]?.workspace).toBe(defaultWorkspace)
    expect(resolveMcpServerCwd(capability.servers[0]!)).toBe(defaultWorkspace)
    expect(resolveMcpServerCwd(capability.servers[0]!)).not.toBe(process.cwd())

    const narrowed = narrowMcpCapability(capability, ['echo'])
    expect(narrowed.workspace).toBeUndefined()
    expect(narrowed.servers[0]?.workspace).toBe(defaultWorkspace)

    await port.probe('echo', { workspace: defaultWorkspace })
    await port.budgetPreview({ workspace: defaultWorkspace })

    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetched[0]?.workspace).toBe(defaultWorkspace)
    expect(launchFingerprint(fetched[0]!)).toBe(launchFingerprint(capability.servers[0]!))
    await manager.dispose()
  })

  it('includes the discovered plugin manifest version in launch identity', async () => {
    const configRoot = await temporaryConfigRoot()
    const port = createMcpPort({ configRoot })
    await port.effective()
    await writeGlobalPlugin(configRoot, '1.0.0')

    const first = await resolveMcpCapability()
    expect(first.servers[0]).toMatchObject({
      name: 'echo',
      plugin: 'echo-kit',
      pluginVersion: '1.0.0',
    })

    await writeGlobalPlugin(configRoot, '2.0.0')
    const second = await resolveMcpCapability()
    expect(second.servers[0]?.pluginVersion).toBe('2.0.0')
    expect(launchFingerprint(second.servers[0]!)).not.toBe(launchFingerprint(first.servers[0]!))
    expect(second.fingerprint).not.toBe(first.fingerprint)
  })
})
