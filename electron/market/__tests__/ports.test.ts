import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { buffer as consumeBuffer } from 'node:stream/consumers'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZipFile } from 'yazl'

import { setPilotRoot } from '@electron/piskiepilot/paths.js'

import { createMcpPort, type McpPort } from '../../mcp/ports.js'
import { configFingerprint } from '../../mcp/bridge/snapshot.js'
import { createPluginsPort } from '../../plugins/ports.js'
import { adaptHostPluginDirectory } from '../../plugins/host-adapter.js'
import { createSkillsPort } from '../../skills/ports.js'
import { addCustomMarketSource, refreshMarketSource } from '../catalog.js'
import { writeMarketCache } from '../cache.js'
import { createMarketPort } from '../ports.js'

const roots: string[] = []
const servers: Server[] = []
let root: string
let repository: string
let workspaceA: string
let workspaceB: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'piskie-market-port-'))
  roots.push(root)
  setPilotRoot(path.join(root, 'piskiepilot'))
  repository = path.join(root, 'source-repo')
  workspaceA = path.join(root, 'project-a')
  workspaceB = path.join(root, 'project-b')
  await mkdir(path.join(repository, 'writer'), { recursive: true })
  await mkdir(workspaceA)
  await mkdir(workspaceB)
  await writeFile(
    path.join(repository, 'writer', 'SKILL.md'),
    '---\nname: writer\ndescription: Write polished copy\n---\n\n# Writer\n',
    'utf8',
  )
})

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function port() {
  const defaultWorkspaceDir = path.join(root, 'workspace')
  const skills = createSkillsPort({ defaultWorkspaceDir, installedBy: 'test' })
  const mcp = createMcpPort({ configRoot: root, defaultWorkspaceDir })
  const plugins = createPluginsPort({
    configRoot: root,
    defaultWorkspaceDir,
    trustProjectServer: async (name, workspace, config) => {
      await mcp.trustConfiguration(name, workspace, config)
    },
  })
  return createMarketPort({
    configRoot: root,
    skills,
    mcp,
    plugins,
    listProjects: () => [
      { workspace: workspaceA, flowNames: ['A'] },
      { workspace: workspaceB, flowNames: ['B'] },
    ],
  })
}

async function pluginMarketplaceFixture(): Promise<string> {
  const marketplace = path.join(root, 'plugin-marketplace')
  const plugins = path.join(marketplace, 'plugins')
  for (const [name, server] of [
    ['auth-on-install', 'install-auth-server'],
    ['auth-on-use', 'use-auth-server'],
  ] as const) {
    const plugin = path.join(plugins, name)
    await mkdir(path.join(plugin, '.codex-plugin'), { recursive: true })
    await writeFile(path.join(plugin, '.codex-plugin', 'plugin.json'), JSON.stringify({
      name,
      version: '1.0.0',
      description: `${name} fixture`,
      mcpServers: './.mcp.json',
    }), 'utf8')
    await writeFile(path.join(plugin, '.mcp.json'), JSON.stringify({
      mcpServers: { [server]: { type: 'http', url: `https://${server}.example.com/mcp` } },
    }), 'utf8')
  }
  await mkdir(path.join(marketplace, '.agents', 'plugins'), { recursive: true })
  await writeFile(path.join(marketplace, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({
    name: 'auth-fixtures',
    interface: { displayName: 'Auth Fixtures' },
    plugins: [
      {
        name: 'auth-on-install',
        source: { source: 'local', path: './plugins/auth-on-install' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      },
      {
        name: 'auth-on-use',
        source: { source: 'local', path: './plugins/auth-on-use' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_USE' },
      },
    ],
  }), 'utf8')
  return marketplace
}

async function writeSkillSource(directory: string, version: string): Promise<string> {
  await mkdir(directory, { recursive: true })
  await writeFile(
    path.join(directory, 'SKILL.md'),
    `---\nname: writer\ndescription: Write polished copy\nversion: ${version}\n---\n\n# Writer\n`,
    'utf8',
  )
  return directory
}

async function zip(entries: Array<{ name: string; contents: string }>): Promise<Buffer> {
  const archive = new ZipFile()
  for (const entry of entries) archive.addBuffer(Buffer.from(entry.contents), entry.name)
  const output = consumeBuffer(archive.outputStream as Readable)
  archive.end()
  return output
}

async function serveArchive(contents: Buffer): Promise<string> {
  const server = createServer((_request, response) => {
    response.write(contents.subarray(0, 7))
    response.end(contents.subarray(7))
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/plugin.zip`
}

describe('MarketPort', () => {
  it('installs a digest-pinned archive from an internal HTTP marketplace end to end', async () => {
    const archive = await zip([
      {
        name: 'internal-archive/.claude-plugin/plugin.json',
        contents: JSON.stringify({
          name: 'internal-archive',
          version: '1.0.0',
          description: 'Internal archive plugin',
        }),
      },
      {
        name: 'internal-archive/skills/http-helper/SKILL.md',
        contents: '---\nname: http-helper\ndescription: Internal HTTP helper\n---\n\n# Helper\n',
      },
    ])
    const archiveUrl = await serveArchive(archive)
    const marketplace = path.join(root, 'internal-http-marketplace')
    await mkdir(path.join(marketplace, '.claude-plugin'), { recursive: true })
    await writeFile(path.join(marketplace, '.claude-plugin', 'marketplace.json'), JSON.stringify({
      $schema: 'https://anthropic.com/claude-code/marketplace.schema.json',
      name: 'internal-http-fixture',
      plugins: [{
        name: 'internal-archive',
        version: '1.0.0',
        description: 'Internal archive plugin',
        source: {
          source: 'archive',
          url: archiveUrl,
          sha256: createHash('sha256').update(archive).digest('hex'),
        },
      }],
    }), 'utf8')

    const market = port()
    const source = await market.addSource({
      name: 'Internal HTTP Fixture',
      kind: 'anthropic-plugin-marketplace',
      url: marketplace,
    })
    await market.refresh([source.id])
    const entry = (await market.list({ kinds: ['plugin'], sourceIds: [source.id] })).entries[0]
    expect(entry).toMatchObject({ name: 'internal-archive', installable: true })

    await expect(market.install({ entryId: entry.id, scope: 'user' })).resolves.toMatchObject({
      targets: [{ scope: 'user', workspace: undefined, ok: true }],
    })
    expect((await market.installed({ kinds: ['plugin'] })).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'internal-archive', scope: 'user' }),
    ]))
    expect((await market.installed({ kinds: ['skill'] })).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'http-helper', plugin: 'internal-archive' }),
    ]))
  })

  it('browses and installs independent project copies, then previews shadowing with shared evaluators', async () => {
    const source = await addCustomMarketSource(root, {
      name: 'Fixture Skills',
      kind: 'git-skills',
      url: repository,
    })
    await refreshMarketSource(root, source)
    const market = port()
    const page = await market.list({ query: 'polished copy' })
    expect(page.entries).toHaveLength(1)

    await market.install({ entryId: page.entries[0].id, scope: 'user' })
    const installed = await market.install({
      entryId: page.entries[0].id,
      scope: 'project',
      workspaces: [workspaceA, workspaceB],
    })
    expect(installed.targets).toEqual([
      { scope: 'project', workspace: workspaceA, ok: true },
      { scope: 'project', workspace: workspaceB, ok: true },
    ])
    await expect(access(path.join(workspaceA, '.piskie', 'skills', 'writer', 'SKILL.md'))).resolves.toBeUndefined()
    await expect(access(path.join(workspaceB, '.piskie', 'skills', 'writer', 'SKILL.md'))).resolves.toBeUndefined()

    const preview = await market.preview(workspaceA)
    const rows = preview.items.filter((item) => item.kind === 'skill' && item.name === 'writer')
    expect(rows).toHaveLength(2)
    expect(rows.find((item) => item.scope === 'project')?.effective).toBe(true)
    expect(rows.find((item) => item.scope === 'user')?.shadowedBy).toContain('project')
  })

  it('does not scan or install into a historical Project whose directory is unavailable', async () => {
    const source = await addCustomMarketSource(root, {
      name: 'Fixture Skills',
      kind: 'git-skills',
      url: repository,
    })
    await refreshMarketSource(root, source)
    const defaultWorkspaceDir = path.join(root, 'workspace')
    const skills = createSkillsPort({ defaultWorkspaceDir, installedBy: 'test' })
    await skills.install({
      source: path.join(repository, 'writer'),
      scope: 'project',
      workspace: workspaceA,
    })
    const mcp = createMcpPort({ configRoot: root, defaultWorkspaceDir })
    const plugins = createPluginsPort({ configRoot: root, defaultWorkspaceDir })
    const market = createMarketPort({
      configRoot: root,
      skills,
      mcp,
      plugins,
      listProjects: () => [{
        workspace: workspaceA,
        name: 'project-a',
        flowNames: ['A'],
        lastActiveAt: '2026-08-01T00:00:00.000Z',
        threadCount: 1,
        available: false,
      }],
    })

    const page = await market.list({ query: 'polished copy' })
    expect(page.entries).toHaveLength(1)
    expect(page.entries[0]?.installed).toBe(false)
    await expect(market.install({
      entryId: page.entries[0]!.id,
      scope: 'project',
      workspaces: [workspaceA],
    })).rejects.toThrow(`Project 不存在或目录不可用：${workspaceA}`)
  })

  it('对某个 Project 禁用全局 MCP 时，其他 Project 照常生效', async () => {
    const defaultWorkspaceDir = path.join(root, 'workspace')
    const skills = createSkillsPort({ defaultWorkspaceDir, installedBy: 'test' })
    const mcp = createMcpPort({ configRoot: root, defaultWorkspaceDir })
    const plugins = createPluginsPort({ configRoot: root, defaultWorkspaceDir })
    await mcp.add({
      name: 'shared-docs',
      scope: 'user',
      config: { command: 'shared-docs-server' },
    })
    const market = createMarketPort({
      configRoot: root,
      skills,
      mcp,
      plugins,
      listProjects: () => [
        { workspace: workspaceA, flowNames: ['A'] },
        { workspace: workspaceB, flowNames: ['B'] },
      ],
    })

    const initial = await market.installed({ kinds: ['mcp'] })
    expect(initial.items).toHaveLength(1)
    expect(initial.items[0]).toMatchObject({
      name: 'shared-docs',
      scope: 'user',
      canToggle: true,
      canRemove: true,
    })

    await market.manage({
      itemId: initial.items[0]!.id,
      action: 'disable',
      workspace: workspaceA,
    })
    const disabled = await market.installed({ kinds: ['mcp'] })
    const override = disabled.items.find((item) => item.scope === 'project')!
    expect(override).toMatchObject({
      enabled: false,
      canToggle: true,
      canRemove: true,
      workspace: workspaceA,
    })
    expect((await mcp.effective(workspaceA)).servers).toEqual([])
    expect((await mcp.effective(workspaceB)).servers).toEqual([
      expect.objectContaining({ name: 'shared-docs', origin: 'global-explicit' }),
    ])

    await market.manage({ itemId: override.id, action: 'enable', workspace: workspaceA })
    expect((await mcp.list({ scope: 'project', workspace: workspaceA }))).toEqual([])
    expect((await mcp.effective(workspaceA)).servers).toEqual([
      expect.objectContaining({ name: 'shared-docs', origin: 'global-explicit' }),
    ])
    expect((await market.installed({ kinds: ['mcp'] })).items).toHaveLength(1)
  })

  it('MCP registry 条目浏览后可多项目安装、onboard，并立即进入各自生效集', async () => {
    const source = await addCustomMarketSource(root, {
      name: 'Fixture Registry',
      kind: 'mcp-registry',
      url: 'https://registry.fixture.test',
    })
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      servers: [{
        server: {
          name: 'io.fixture/echo',
          version: '1.0.0',
          description: 'Fixture echo server',
          packages: [{ registryType: 'npm', identifier: '@fixture/echo' }],
        },
      }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json', etag: 'fixture-v1' },
    })) as typeof fetch
    await refreshMarketSource(root, source, { fetcher })

    const defaultWorkspaceDir = path.join(root, 'workspace')
    const skills = createSkillsPort({ defaultWorkspaceDir, installedBy: 'test' })
    const snapshotFetcher = vi.fn(async (server: import('@shared/types/mcp.js').EffectiveMcpServer) => ({
      server: server.name,
      protocolVersion: '2025-06-18',
      tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }],
      fetchedAt: new Date().toISOString(),
      configFingerprint: configFingerprint(server.config),
    }))
    const mcp = createMcpPort({ configRoot: root, defaultWorkspaceDir, snapshotFetcher })
    const plugins = createPluginsPort({ configRoot: root, defaultWorkspaceDir })
    const market = createMarketPort({
      configRoot: root,
      skills,
      mcp,
      plugins,
      listProjects: () => [
        { workspace: workspaceA, flowNames: ['A'] },
        { workspace: workspaceB, flowNames: ['B'] },
      ],
    })
    const page = await market.list({ sourceIds: [source.id], kinds: ['mcp'] })
    expect(page.entries).toHaveLength(1)

    const installed = await market.install({
      entryId: page.entries[0]!.id,
      scope: 'project',
      workspaces: [workspaceA, workspaceB],
    })

    expect(installed.targets).toEqual([
      { scope: 'project', workspace: workspaceA, ok: true, warning: undefined },
      { scope: 'project', workspace: workspaceB, ok: true, warning: undefined },
    ])
    expect(snapshotFetcher).toHaveBeenCalled()
    await expect(mcp.effective(workspaceA)).resolves.toMatchObject({
      servers: [expect.objectContaining({ name: 'io.fixture/echo', origin: 'project-explicit' })],
    })
    await expect(mcp.effective(workspaceB)).resolves.toMatchObject({
      servers: [expect.objectContaining({ name: 'io.fixture/echo', origin: 'project-explicit' })],
    })
  })

  it('MCP 市场安装的逐目标错误不会回传条目配置中的 secret', async () => {
    const source = await addCustomMarketSource(root, {
      name: 'Safe Registry Fixture',
      kind: 'mcp-registry',
      url: 'https://registry.safe.fixture.test',
    })
    const headerSecret = 'market-header-secret'
    const querySecret = 'market-query-secret'
    await writeMarketCache(root, source.id, {
      entries: [{
        id: `${source.id}:mcp:safe-server`,
        kind: 'mcp',
        name: 'safe-server',
        description: 'Safe error boundary fixture',
        sourceId: source.id,
        sourceName: source.name,
        sourceUrl: source.url,
        installSource: source.url,
        mcpConfig: {
          url: `https://remote.example.com/mcp?tenant=${querySecret}`,
          http_headers: { Authorization: `Bearer ${headerSecret}` },
        },
      }],
      warnings: [],
      revision: 'safe-v1',
    })
    const defaultWorkspaceDir = path.join(root, 'workspace')
    const skills = createSkillsPort({ defaultWorkspaceDir, installedBy: 'test' })
    const realMcp = createMcpPort({ configRoot: root, defaultWorkspaceDir })
    const mcp: McpPort = {
      ...realMcp,
      add: async () => { throw new Error(`upstream echoed ${headerSecret} ${querySecret}`) },
    }
    const plugins = createPluginsPort({ configRoot: root, defaultWorkspaceDir })
    const market = createMarketPort({ configRoot: root, skills, mcp, plugins })

    const result = await market.install({
      entryId: `${source.id}:mcp:safe-server`,
      scope: 'user',
    })
    const serialized = JSON.stringify(result)
    expect(serialized).toContain('[redacted]')
    expect(serialized).not.toContain(headerSecret)
    expect(serialized).not.toContain(querySecret)
  })

  it('千条目录由端口硬上限与 offset 分页材化', async () => {
    const source = await addCustomMarketSource(root, {
      name: 'Large Fixture',
      kind: 'git-skills',
      url: repository,
    })
    await writeMarketCache(root, source.id, {
      entries: Array.from({ length: 1_005 }, (_, index) => ({
        id: `${source.id}:skill:item-${index.toString().padStart(4, '0')}`,
        kind: 'skill' as const,
        name: `item-${index.toString().padStart(4, '0')}`,
        description: 'Paged fixture',
        sourceId: source.id,
        sourceName: source.name,
        sourceUrl: source.url,
        installSource: repository,
      })),
      warnings: [],
      revision: 'large-v1',
    })
    const market = port()

    const first = await market.list({ sourceIds: [source.id], limit: 999 })
    const second = await market.list({ sourceIds: [source.id], offset: first.entries.length, limit: 60 })

    expect(first).toMatchObject({ catalogCount: 1_005, total: 1_005, offset: 0, limit: 200 })
    expect(first.entries).toHaveLength(200)
    expect(second).toMatchObject({ total: 1_005, offset: 200, limit: 60 })
    expect(second.entries).toHaveLength(60)
    expect(new Set([...first.entries, ...second.entries].map((entry) => entry.id)).size).toBe(260)
  })

  it('统一分页枚举并管理已安装 Skill、MCP 与 Plugin', async () => {
    await writeSkillSource(path.join(repository, 'writer'), '2.0.0')
    const source = await addCustomMarketSource(root, {
      name: 'Managed Skills',
      kind: 'git-skills',
      url: repository,
    })
    await refreshMarketSource(root, source)

    const defaultWorkspaceDir = path.join(root, 'workspace')
    const skills = createSkillsPort({ defaultWorkspaceDir, installedBy: 'test' })
    const snapshotFetcher = vi.fn(async (server: import('@shared/types/mcp.js').EffectiveMcpServer) => ({
      server: server.name,
      protocolVersion: '2025-11-25',
      tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }],
      fetchedAt: new Date().toISOString(),
      configFingerprint: configFingerprint(server.config),
    }))
    const mcp = createMcpPort({ configRoot: root, defaultWorkspaceDir, snapshotFetcher })
    const plugins = createPluginsPort({ configRoot: root, defaultWorkspaceDir })
    await skills.install({
      source: await writeSkillSource(path.join(root, 'installed-v1', 'writer'), '1.0.0'),
      scope: 'user',
    })
    await mcp.add({ name: 'echo', scope: 'user', config: { command: 'echo-server' } })
    const pluginMarketplace = await pluginMarketplaceFixture()
    const adapted = await adaptHostPluginDirectory({
      format: 'openai',
      directory: path.join(pluginMarketplace, 'plugins', 'auth-on-use'),
      marketplaceEntry: { name: 'auth-on-use' },
    })
    try {
      await plugins.install({ source: adapted.directory, scope: 'user' })
    } finally {
      await adapted.cleanup()
    }
    const market = createMarketPort({
      configRoot: root,
      skills,
      mcp,
      plugins,
      listProjects: () => [],
    })

    const first = await market.installed({ limit: 2 })
    const second = await market.installed({ offset: 2, limit: 2 })
    expect(first).toMatchObject({ installedCount: 4, total: 4, offset: 0, limit: 2, updateCount: 1 })
    expect(first.items).toHaveLength(2)
    expect(second.items).toHaveLength(2)
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(4)

    const all = await market.installed({ limit: 20 })
    const skill = all.items.find((item) => item.kind === 'skill' && item.name === 'writer')!
    const explicitMcp = all.items.find((item) => item.kind === 'mcp' && item.name === 'echo')!
    const plugin = all.items.find((item) => item.kind === 'plugin' && item.name === 'auth-on-use')!
    const pluginMcp = all.items.find((item) => item.kind === 'mcp' && item.plugin === 'auth-on-use')!
    expect(skill).toMatchObject({ updateAvailable: true, availableVersion: '2.0.0', canToggle: true })
    expect(explicitMcp).toMatchObject({ canRemove: true, canToggle: true })
    expect(plugin).toMatchObject({ canRemove: true, members: { mcpServers: [{ name: 'use-auth-server' }] } })
    expect(pluginMcp).toMatchObject({ canRemove: false, canToggle: false, origin: 'plugin' })

    await market.manage({ itemId: skill.id, action: 'disable' })
    expect((await skills.list({ scope: 'user' }))[0]?.enabled).toBe(false)

    await expect(market.manage({ itemId: explicitMcp.id, action: 'probe' })).resolves.toMatchObject({
      protocolVersion: '2025-11-25',
      toolCount: 1,
    })
    expect(snapshotFetcher).toHaveBeenCalledOnce()

    await expect(market.manage({ itemId: pluginMcp.id, action: 'remove' }))
      .rejects.toThrow('由 插件 auth-on-use 管理')
    await market.manage({ itemId: plugin.id, action: 'remove' })
    expect(await plugins.list({ scope: 'user' })).toEqual([])
  })

  it('MCP 本地别名与 Registry 规范名通过相同包标识关联', async () => {
    const source = await addCustomMarketSource(root, {
      name: 'Alias Registry Fixture',
      kind: 'mcp-registry',
      url: 'https://registry.alias.fixture.test',
    })
    await writeMarketCache(root, source.id, {
      entries: [{
        id: `${source.id}:mcp:io.github.upstash/context7`,
        kind: 'mcp',
        name: 'io.github.upstash/context7',
        description: 'Up-to-date documentation for LLMs and AI code editors',
        version: '1.0.32',
        sourceId: source.id,
        sourceName: source.name,
        sourceUrl: source.url,
        installSource: source.url,
        mcpConfig: {
          command: 'npx',
          args: ['-y', '@upstash/context7-mcp@1.0.32'],
        },
      }],
      warnings: [],
      revision: 'context7-v1',
    })

    const defaultWorkspaceDir = path.join(root, 'workspace')
    const skills = createSkillsPort({ defaultWorkspaceDir, installedBy: 'test' })
    const mcp = createMcpPort({
      configRoot: root,
      defaultWorkspaceDir,
      snapshotFetcher: async (server) => ({
        server: server.name,
        protocolVersion: '2025-11-25',
        tools: [],
        fetchedAt: new Date().toISOString(),
        configFingerprint: configFingerprint(server.config),
      }),
    })
    const plugins = createPluginsPort({ configRoot: root, defaultWorkspaceDir })
    await mcp.add({
      name: 'context7',
      scope: 'user',
      config: {
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp@1.0.31'],
      },
    })
    const market = createMarketPort({ configRoot: root, skills, mcp, plugins })

    const catalogEntry = (await market.list({ kinds: ['mcp'] })).entries[0]
    expect(catalogEntry).toMatchObject({
      name: 'io.github.upstash/context7',
      installed: true,
      updateAvailable: true,
    })

    const installed = await market.installed({ kinds: ['mcp'] })
    expect(installed.items).toEqual([
      expect.objectContaining({
        name: 'context7',
        description: 'Up-to-date documentation for LLMs and AI code editors',
        version: '1.0.31',
        availableVersion: '1.0.32',
        marketEntryId: catalogEntry?.id,
        updateAvailable: true,
      }),
    ])

    await expect(market.install({
      entryId: catalogEntry!.id,
      scope: 'user',
      force: true,
    })).resolves.toMatchObject({
      targets: [{ scope: 'user', ok: true }],
    })
    const updatedServers = await mcp.list({ scope: 'user' })
    expect(updatedServers).toHaveLength(1)
    expect(updatedServers[0]).toMatchObject({
      name: 'context7',
      args: ['-y', '@upstash/context7-mcp@1.0.32'],
    })
  })

  it('ON_INSTALL 逐项目执行 OAuth，失败只产生 warning；ON_USE 不提前登录', async () => {
    const defaultWorkspaceDir = path.join(root, 'workspace')
    const skills = createSkillsPort({ defaultWorkspaceDir, installedBy: 'test' })
    const realMcp = createMcpPort({
      configRoot: root,
      defaultWorkspaceDir,
      oauthProber: async () => ({
        supported: true,
        metadata: {
          issuer: 'https://issuer.example.com',
          authorization_endpoint: 'https://issuer.example.com/authorize',
          token_endpoint: 'https://issuer.example.com/token',
        },
      }),
      snapshotFetcher: async (server) => ({
        server: server.name,
        tools: [],
        fetchedAt: new Date().toISOString(),
        configFingerprint: 'test',
      }),
    })
    const authStatus = vi.fn(async (name: string) => ({
      name,
      method: 'oauth' as const,
      authenticated: false,
    }))
    const login = vi.fn(async (_name: string, options?: { workspace?: string }) => {
      if (options?.workspace === workspaceA) throw new Error('user closed authorization window')
      return { issuer: 'https://issuer.example.com' }
    })
    const mcp: McpPort = { ...realMcp, authStatus, login }
    const plugins = createPluginsPort({
      configRoot: root,
      defaultWorkspaceDir,
      trustProjectServer: async (name, workspace, config) => {
        await realMcp.trustConfiguration(name, workspace, config)
      },
      onboardMcpServer: (name, workspace, onboarding) => mcp.onboard(name, {
        workspace,
        login: onboarding?.login === true,
      }),
    })
    const market = createMarketPort({
      configRoot: root,
      skills,
      mcp,
      plugins,
      listProjects: () => [
        { workspace: workspaceA, flowNames: ['A'] },
        { workspace: workspaceB, flowNames: ['B'] },
      ],
    })
    const source = await market.addSource({
      name: 'Auth Fixtures',
      kind: 'openai-plugin-marketplace',
      url: await pluginMarketplaceFixture(),
    })
    const refreshed = await market.refresh([source.id])
    expect(refreshed.warnings).toEqual([])
    const page = await market.list({ kinds: ['plugin'], sourceIds: [source.id] })
    const onInstall = page.entries.find((entry) => entry.name === 'auth-on-install')!
    const onUse = page.entries.find((entry) => entry.name === 'auth-on-use')!

    const installed = await market.install({
      entryId: onInstall.id,
      scope: 'project',
      workspaces: [workspaceA, workspaceB],
    })
    expect(installed.targets).toEqual([
      expect.objectContaining({ scope: 'project', workspace: workspaceA, ok: true }),
      { scope: 'project', workspace: workspaceB, ok: true },
    ])
    expect(installed.targets[0]?.warning).toContain('user closed authorization window')
    expect(authStatus).toHaveBeenCalledTimes(2)
    expect(login).toHaveBeenCalledTimes(2)
    await expect(access(path.join(workspaceA, '.piskie', 'plugins', 'auth-on-install'))).resolves.toBeUndefined()
    await expect(access(path.join(workspaceB, '.piskie', 'plugins', 'auth-on-install'))).resolves.toBeUndefined()

    const statusCalls = authStatus.mock.calls.length
    const loginCalls = login.mock.calls.length
    const deferred = await market.install({ entryId: onUse.id, scope: 'user' })
    expect(deferred.targets).toEqual([
      expect.objectContaining({ scope: 'user', workspace: undefined, ok: true }),
    ])
    expect(deferred.targets[0]?.warning).toContain('piskie mcp login use-auth-server')
    expect(authStatus).toHaveBeenCalledTimes(statusCalls + 1)
    expect(login).toHaveBeenCalledTimes(loginCalls)
  })

  it('内置技能与市场条目同名互不认领：市场不标已安装，内置项不挂市场条目', async () => {
    const source = await addCustomMarketSource(root, {
      name: 'Collision Fixture',
      kind: 'git-skills',
      url: repository,
    })
    await refreshMarketSource(root, source)
    const defaultWorkspaceDir = path.join(root, 'workspace')
    const skills = createSkillsPort({
      defaultWorkspaceDir,
      installedBy: 'test',
      runtime: {
        listBuiltin: () => [{
          name: 'writer',
          description: 'Builtin writer helper',
          path: path.join(root, 'builtin', 'writer'),
        }],
      },
    })
    const mcp = createMcpPort({ configRoot: root, defaultWorkspaceDir })
    const plugins = createPluginsPort({ configRoot: root, defaultWorkspaceDir })
    const market = createMarketPort({ configRoot: root, skills, mcp, plugins, listProjects: () => [] })

    expect((await market.list({ sourceIds: [source.id] })).entries[0]).toMatchObject({
      name: 'writer',
      installed: false,
    })
    const builtinItem = (await market.installed({ kinds: ['skill'] })).items
      .find((item) => item.scope === 'builtin')!
    expect(builtinItem.description).toBe('Builtin writer helper')
    expect(builtinItem.marketEntryId).toBeUndefined()
    expect(builtinItem.availableVersion).toBeUndefined()

    await skills.install({
      source: await writeSkillSource(path.join(root, 'installed-user', 'writer'), '1.0.0'),
      scope: 'user',
    })
    expect((await market.list({ sourceIds: [source.id] })).entries[0]).toMatchObject({ installed: true })
  })

  it('任一项目副本落后即标记可更新；移除旧副本后同版本全局副本不误报', async () => {
    await writeSkillSource(path.join(repository, 'writer'), '2.0.0')
    const source = await addCustomMarketSource(root, {
      name: 'Versioned Skills',
      kind: 'git-skills',
      url: repository,
    })
    await refreshMarketSource(root, source)
    const defaultWorkspaceDir = path.join(root, 'workspace')
    const skills = createSkillsPort({ defaultWorkspaceDir, installedBy: 'test' })
    await skills.install({
      source: await writeSkillSource(path.join(root, 'installed-global', 'writer'), '2.0.0'),
      scope: 'user',
    })
    await skills.install({
      source: await writeSkillSource(path.join(root, 'installed-project', 'writer'), '1.4.0'),
      scope: 'project',
      workspace: workspaceA,
    })
    const market = port()

    expect((await market.list({ sourceIds: [source.id] })).entries[0]).toMatchObject({
      installed: true,
      updateAvailable: true,
    })

    await skills.remove('writer', { scope: 'project', workspace: workspaceA })
    expect((await market.list({ sourceIds: [source.id] })).entries[0]).toMatchObject({
      installed: true,
      updateAvailable: false,
    })
  })

  it('市场版本投影遵循 semver 预发布顺序', async () => {
    await writeSkillSource(path.join(repository, 'writer'), '2.0.0-rc.1')
    const source = await addCustomMarketSource(root, {
      name: 'Prerelease Skills',
      kind: 'git-skills',
      url: repository,
    })
    await refreshMarketSource(root, source)
    const skills = createSkillsPort({
      defaultWorkspaceDir: path.join(root, 'workspace'),
      installedBy: 'test',
    })
    await skills.install({
      source: await writeSkillSource(path.join(root, 'installed-release', 'writer'), '2.0.0'),
      scope: 'user',
    })
    const market = port()
    expect((await market.list({ sourceIds: [source.id] })).entries[0]?.updateAvailable).toBe(false)

    await skills.install({
      source: await writeSkillSource(path.join(root, 'installed-older', 'writer'), '1.9.0'),
      scope: 'user',
      force: true,
    })
    expect((await market.list({ sourceIds: [source.id] })).entries[0]?.updateAvailable).toBe(true)
  })
})
