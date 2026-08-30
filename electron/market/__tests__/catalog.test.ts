import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { MarketSource } from '@shared/types/market.js'

import {
  addCustomMarketSource,
  listMarketSources,
  loadMarketCatalog,
  refreshMarketCatalog,
  refreshMarketSource,
} from '../catalog.js'
import { readMarketCache, writeMarketCache } from '../cache.js'
import { scanGitSkillsSource } from '../sources/git-skills.js'
import { MCP_REGISTRY_CACHE_REVISION } from '../sources/mcp-registry.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('market catalog cache', () => {
  it('silently ignores known source scaffolding without hiding other invalid skills', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'piskie-market-scaffolding-'))
    roots.push(root)
    await mkdir(path.join(root, 'template'), { recursive: true })
    await mkdir(path.join(root, 'broken'), { recursive: true })
    await writeFile(
      path.join(root, 'template', 'SKILL.md'),
      '---\nname: template-skill\ndescription: Copy this directory to start a new skill\n---\n',
      'utf8',
    )
    await writeFile(
      path.join(root, 'broken', 'SKILL.md'),
      '---\nname: another-name\ndescription: This should still fail validation\n---\n',
      'utf8',
    )

    const scanned = await scanGitSkillsSource({
      id: 'anthropics-skills',
      name: 'Anthropic Skills',
      kind: 'git-skills',
      url: 'https://github.com/anthropics/skills.git',
      builtin: true,
      enabled: true,
    }, root)

    expect(scanned.entries).toEqual([])
    expect(scanned.warnings).toHaveLength(1)
    expect(scanned.warnings[0]).toContain('broken/SKILL.md')
    expect(scanned.warnings[0]).not.toContain('template/SKILL.md')
  })

  it('filters a previously cached Anthropic template warning', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'piskie-market-old-warning-'))
    roots.push(root)
    await writeMarketCache(root, 'anthropics-skills', {
      entries: [],
      warnings: [
        'template/SKILL.md 校验失败，已跳过：name（template-skill）须与技能目录名（template）一致',
        'broken/SKILL.md 校验失败，已跳过：name 不合法',
      ],
    })

    const loaded = await loadMarketCatalog(root)

    expect(loaded.warnings).toEqual([
      'Anthropic Skills: broken/SKILL.md 校验失败，已跳过：name 不合法',
    ])
  })

  it('keeps OpenAI portable skills but excludes Codex-host system skills', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'piskie-market-openai-skills-'))
    roots.push(root)
    await mkdir(path.join(root, 'skills', '.system', 'skill-installer'), { recursive: true })
    await mkdir(path.join(root, 'skills', '.curated', 'pdf-reader'), { recursive: true })
    await writeFile(
      path.join(root, 'skills', '.system', 'skill-installer', 'SKILL.md'),
      '---\nname: skill-installer\ndescription: Install Codex skills into CODEX_HOME\n---\n',
      'utf8',
    )
    await writeFile(
      path.join(root, 'skills', '.curated', 'pdf-reader', 'SKILL.md'),
      '---\nname: pdf-reader\ndescription: Read and summarize PDF files\n---\n',
      'utf8',
    )

    const scanned = await scanGitSkillsSource({
      id: 'openai-skills',
      name: 'OpenAI Skills',
      kind: 'git-skills',
      url: 'https://github.com/openai/skills.git',
      builtin: true,
      enabled: true,
    }, root)

    expect(scanned.entries.map((entry) => entry.name)).toEqual(['pdf-reader'])
    expect(scanned.entries[0]?.id).toContain('skills/.curated/pdf-reader')
    expect(scanned.entries.some((entry) => entry.id.includes('skills/.system/'))).toBe(false)
  })

  it('filters obsolete OpenAI .system entries already present in cache', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'piskie-market-openai-cache-'))
    roots.push(root)
    await writeMarketCache(root, 'openai-skills', {
      entries: [
        {
          id: 'openai-skills:skill:skills/.system/skill-installer',
          kind: 'skill',
          name: 'skill-installer',
          description: 'Install Codex skills into CODEX_HOME',
          sourceId: 'openai-skills',
          sourceName: 'OpenAI Skills',
          sourceUrl: 'https://github.com/openai/skills.git',
          installSource: '/cache/openai-skills/skills/.system/skill-installer',
          executable: false,
          maturity: 'community',
        },
        {
          id: 'openai-skills:skill:skills/.curated/pdf-reader',
          kind: 'skill',
          name: 'pdf-reader',
          description: 'Read PDF files',
          sourceId: 'openai-skills',
          sourceName: 'OpenAI Skills',
          sourceUrl: 'https://github.com/openai/skills.git',
          installSource: '/cache/openai-skills/skills/.curated/pdf-reader',
          executable: false,
          maturity: 'curated',
        },
      ],
      warnings: ['skills/.system/skill-installer/SKILL.md 校验失败，已跳过：host specific'],
    })

    const loaded = await loadMarketCatalog(root)

    expect(loaded.entries.map((entry) => entry.name)).toContain('pdf-reader')
    expect(loaded.entries.map((entry) => entry.name)).not.toContain('skill-installer')
    expect(loaded.warnings).not.toContain(expect.stringContaining('skills/.system/'))
  })

  it('keeps unsupported Registry inventory out of the user warning banner', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'piskie-market-registry-notice-'))
    roots.push(root)
    await writeMarketCache(root, 'mcp-registry', {
      entries: [],
      warnings: [
        'MCP Registry 有 1201 条 server 缺少受支持的传输配置，已忽略',
        'MCP Registry 返回重复游标 same-page，已停止分页以避免循环',
      ],
    })

    const loaded = await loadMarketCatalog(root)

    expect(loaded.warnings).toEqual([
      'MCP Registry 返回重复游标 same-page，已停止分页以避免循环',
    ])
  })

  it('refreshes a local git-skills source into the unified projection', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'piskie-market-catalog-'))
    roots.push(root)
    const repository = path.join(root, 'repo')
    await mkdir(path.join(repository, '.curated', 'pdf-reader'), { recursive: true })
    await writeFile(
      path.join(repository, '.curated', 'pdf-reader', 'SKILL.md'),
      '---\nname: pdf-reader\ndescription: Read and summarize PDF files\nlicense: MIT\n---\n\n# PDF\n',
      'utf8',
    )
    const source = await addCustomMarketSource(root, {
      name: 'Local Skills',
      kind: 'git-skills',
      url: repository,
    })
    await refreshMarketSource(root, source)
    const loaded = await loadMarketCatalog(root)
    expect(loaded.entries).toMatchObject([{
      kind: 'skill',
      name: 'pdf-reader',
      maturity: 'curated',
      license: 'MIT',
    }])
    expect((await listMarketSources(root)).some((item) => item.id === source.id)).toBe(true)
  })

  it('incrementally merges a latest-only MCP Registry cache', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'piskie-market-registry-increment-'))
    roots.push(root)
    const source: MarketSource = {
      id: 'mcp-registry',
      name: 'MCP Registry',
      kind: 'mcp-registry',
      url: 'https://registry.example.test',
      builtin: true,
      enabled: true,
    }
    const refreshedAt = '2026-08-08T08:00:00.000Z'
    const cachedEntry = (name: string, version: string) => ({
      id: `${source.id}:mcp:${name}@${version}`,
      kind: 'mcp' as const,
      name,
      description: `${name} ${version}`,
      sourceId: source.id,
      sourceName: source.name,
      sourceUrl: source.url,
      installSource: `registry:${name}@${version}`,
      version,
      mcpConfig: { command: 'npx', args: [name] },
    })
    await writeMarketCache(root, source.id, {
      refreshedAt,
      revision: MCP_REGISTRY_CACHE_REVISION,
      entries: [cachedEntry('keep-me', '1.0.0'), cachedEntry('remove-me', '1.0.0')],
      warnings: [
        'MCP Registry 返回一条无法投影的 server，已忽略',
        'MCP Registry 返回一条无法投影的 server，已忽略',
      ],
    })
    const fetcher = (async (input: string | URL | Request) => {
      const url = new URL(String(input))
      expect(url.searchParams.get('updated_since')).toBe(refreshedAt)
      return new Response(JSON.stringify({
        servers: [
          { server: {
            name: 'keep-me',
            version: '2.0.0',
            packages: [{ registryType: 'npm', identifier: 'keep-me', version: '2.0.0' }],
          } },
          {
            server: { name: 'remove-me', version: '1.0.0' },
            _meta: { 'io.modelcontextprotocol.registry/official': { status: 'deleted' } },
          },
          { server: { name: 'still-unsupported', version: '1.0.0' } },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const refreshed = await refreshMarketSource(root, source, { fetcher })
    const cache = await readMarketCache(root, source.id)

    expect(refreshed.entries).toMatchObject([{ name: 'keep-me', version: '2.0.0' }])
    expect(cache?.revision).toBe(MCP_REGISTRY_CACHE_REVISION)
    expect(cache?.warnings).toEqual([
      'MCP Registry 有 2 条 server 缺少受支持的传输配置，已忽略',
    ])
  })

  it('reports source-level progress and preserves a refresh failure for the renderer', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'piskie-market-progress-'))
    roots.push(root)
    const progress: import('@shared/types/market.js').MarketCatalogSyncProgress[] = []

    const result = await refreshMarketCatalog(root, ['mcp-registry'], {
      onProgress: (event) => progress.push(event),
      refreshSource: async () => {
        throw new Error('registry offline')
      },
    })

    expect(progress.map((event) => event.phase)).toEqual([
      'started',
      'source-started',
      'source-failed',
      'completed',
    ])
    expect(progress[2]).toMatchObject({ completed: 1, total: 1, error: 'registry offline' })
    expect(result.warnings).toEqual(['MCP Registry: registry offline'])
    expect(result.sources.find((source) => source.id === 'mcp-registry')?.error).toBe('registry offline')
  })
})
