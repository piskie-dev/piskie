import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  addPluginMarketplaceSource,
  ANTHROPIC_MARKETPLACE_SCHEMA,
  readAnthropicPluginMarketplace,
  readOpenAiPluginMarketplace,
} from '../../plugins/marketplace.js'
import { listMarketSources, loadMarketCatalog, refreshMarketSource } from '../catalog.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('plugin marketplace source', () => {
  it('hides NOT_AVAILABLE and preserves default-install policy without automatic installation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'piskie-plugin-market-'))
    const repository = await mkdtemp(path.join(os.tmpdir(), 'piskie-plugin-market-repo-'))
    roots.push(root, repository)
    for (const name of ['available-kit', 'default-kit', 'hidden-kit']) {
      const plugin = path.join(repository, 'plugins', name)
      await mkdir(path.join(plugin, '.codex-plugin'), { recursive: true })
      await mkdir(path.join(plugin, 'skills', `${name}-skill`), { recursive: true })
      await writeFile(path.join(plugin, '.codex-plugin', 'plugin.json'), JSON.stringify({
        name,
        description: `${name} description`,
        skills: './skills/',
        mcpServers: name === 'available-kit' ? './.mcp.json' : undefined,
      }), 'utf8')
      if (name === 'available-kit') {
        await writeFile(path.join(plugin, '.mcp.json'), JSON.stringify({
          mcpServers: {
            remote: {
              type: 'http',
              url: 'https://mcp.example.test',
              headers: { Authorization: 'Bearer ${HOST_API_KEY}' },
            },
          },
        }), 'utf8')
      }
      await writeFile(
        path.join(plugin, 'skills', `${name}-skill`, 'SKILL.md'),
        `---\nname: ${name}-skill\ndescription: ${name} skill\n---\n`,
        'utf8',
      )
    }
    await mkdir(path.join(repository, '.agents', 'plugins'), { recursive: true })
    await writeFile(path.join(repository, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({
      name: 'fixture-market',
      interface: { displayName: 'Fixture Market' },
      plugins: [
        {
          name: 'available-kit',
          source: { source: 'local', path: './plugins/available-kit' },
          policy: { installation: 'AVAILABLE' },
        },
        {
          name: 'default-kit',
          source: { source: 'local', path: './plugins/default-kit' },
          policy: { installation: 'INSTALLED_BY_DEFAULT' },
        },
        {
          name: 'hidden-kit',
          source: { source: 'local', path: './plugins/hidden-kit' },
          policy: { installation: 'NOT_AVAILABLE' },
        },
      ],
    }), 'utf8')

    await addPluginMarketplaceSource(root, 'openai', repository)
    const source = (await listMarketSources(root)).find((item) => item.id.startsWith('plugin-marketplace:openai:'))!
    await refreshMarketSource(root, source)
    const catalog = await loadMarketCatalog(root)
    const entries = catalog.entries
    expect(entries.map((entry) => entry.name)).toEqual(['available-kit', 'default-kit'])
    expect(entries.find((entry) => entry.name === 'default-kit')?.policy?.installation)
      .toBe('INSTALLED_BY_DEFAULT')
    expect(entries.find((entry) => entry.name === 'available-kit')?.warnings)
      .toEqual([expect.stringContaining('header Authorization 使用宿主环境变量')])
    expect(catalog.warnings).toEqual([])
  })

  it('preserves Anthropic source pins and subdirectories as structured install data', async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), 'piskie-anthropic-market-repo-'))
    roots.push(repository)
    await mkdir(path.join(repository, '.claude-plugin'), { recursive: true })
    await mkdir(path.join(repository, 'plugins', 'local'), { recursive: true })
    const sha = 'a'.repeat(40)
    await writeFile(path.join(repository, '.claude-plugin', 'marketplace.json'), JSON.stringify({
      $schema: ANTHROPIC_MARKETPLACE_SCHEMA,
      name: 'claude-fixture',
      plugins: [
        { name: 'local', source: './plugins/local' },
        { name: 'github', source: { source: 'github', repo: 'acme/plugin', ref: 'v1', sha } },
        {
          name: 'subdir',
          source: {
            source: 'git-subdir',
            url: 'http://git.internal.test/acme/mono.git',
            path: 'plugins/tool',
            ref: 'main',
            sha,
          },
        },
        {
          name: 'npm',
          source: {
            source: 'npm',
            package: '@acme/plugin',
            version: '2.0.0',
            registry: 'http://registry.internal.test',
          },
        },
        {
          name: 'archive',
          source: { source: 'archive', url: 'http://market.internal.test/plugin.zip', sha256: 'b'.repeat(64) },
        },
        { name: 'unpinned', source: { source: 'archive', url: 'http://market.internal.test/unpinned.zip' } },
      ],
    }), 'utf8')

    const marketplace = await readAnthropicPluginMarketplace(repository)
    expect(marketplace.format).toBe('anthropic')
    expect(marketplace.entries.map((entry) => entry.source)).toEqual([
      { type: 'directory', path: path.join(repository, 'plugins', 'local') },
      { type: 'git', url: 'https://github.com/acme/plugin.git', ref: 'v1', sha },
      {
        type: 'git',
        url: 'http://git.internal.test/acme/mono.git',
        ref: 'main',
        sha,
        subdirectory: path.join('plugins', 'tool'),
      },
      {
        type: 'npm',
        package: '@acme/plugin',
        version: '2.0.0',
        registry: 'http://registry.internal.test',
      },
      { type: 'archive', url: 'http://market.internal.test/plugin.zip', sha256: 'b'.repeat(64) },
    ])
    expect(marketplace.warnings).toEqual([
      expect.stringContaining('plugins[5].source.sha256'),
    ])
  })

  it('does not fall back from the declared host location to a root marketplace.json', async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), 'piskie-no-market-fallback-'))
    roots.push(repository)
    await writeFile(path.join(repository, 'marketplace.json'), JSON.stringify({
      name: 'obsolete-root',
      plugins: [],
    }), 'utf8')

    await expect(readOpenAiPluginMarketplace(repository)).rejects.toThrow('.agents/plugins/marketplace.json')
    await expect(readAnthropicPluginMarketplace(repository)).rejects.toThrow('.claude-plugin/marketplace.json')
  })
})
