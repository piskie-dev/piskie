import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import type { MarketSource } from '@shared/types/market.js'

import { setPilotRoot } from '../../piskiepilot/paths.js'
import { resolvePluginPackageSource } from '../../plugins/adapter-source.js'
import { adaptHostPluginDirectory } from '../../plugins/host-adapter.js'
import { installPlugin } from '../../plugins/install.js'
import { refreshGitCheckout } from '../cache.js'
import { scanPluginMarketplaceSource } from '../sources/plugin-marketplace.js'

const enabled = process.env.PISKIE_LIVE_PLUGIN_MARKETS === '1'
const suite = enabled ? describe : describe.skip
const temporaryRoots: string[] = []

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })))
})

async function checkout(source: MarketSource, override?: string): Promise<string> {
  if (override) return path.resolve(override)
  const root = await mkdtemp(path.join(os.tmpdir(), 'piskie-plugin-market-live-'))
  temporaryRoots.push(root)
  return (await refreshGitCheckout(root, source)).checkout
}

suite('official plugin marketplaces', () => {
  it('scans the OpenAI marketplace with explicit compatibility projections', async () => {
    const source: MarketSource = {
      id: 'openai-plugins',
      name: 'OpenAI Plugins',
      kind: 'openai-plugin-marketplace',
      url: 'https://github.com/openai/plugins.git',
      builtin: true,
      enabled: true,
    }
    const directory = await checkout(source, process.env.PISKIE_OPENAI_PLUGINS_CHECKOUT)
    const result = await scanPluginMarketplaceSource(source, directory, path.dirname(directory))
    expect(result.entries.length).toBeGreaterThanOrEqual(150)
    expect(result.entries.some((entry) => entry.compatibility?.status === 'partial')).toBe(true)
    expect(result.entries.some((entry) => entry.compatibility?.status === 'unsupported')).toBe(true)
    expect(result.entries.every((entry) => entry.pluginAdapter?.format === 'openai')).toBe(true)
  }, 180_000)

  it('scans the Anthropic marketplace and preserves external source pins', async () => {
    const source: MarketSource = {
      id: 'anthropic-plugins',
      name: 'Anthropic Plugins',
      kind: 'anthropic-plugin-marketplace',
      url: 'https://github.com/anthropics/claude-plugins-official.git',
      builtin: true,
      enabled: true,
    }
    const directory = await checkout(source, process.env.PISKIE_ANTHROPIC_PLUGINS_CHECKOUT)
    const result = await scanPluginMarketplaceSource(source, directory, path.dirname(directory))
    expect(result.entries.length).toBeGreaterThanOrEqual(250)
    expect(result.entries.some((entry) => (
      entry.pluginAdapter?.source.type === 'git'
      && entry.pluginAdapter.source.sha !== undefined
      && entry.pluginAdapter.source.subdirectory !== undefined
    ))).toBe(true)
    expect(result.entries.every((entry) => entry.pluginAdapter?.format === 'anthropic')).toBe(true)
  }, 180_000)

  it('adapts and installs one real package from each official checkout', async () => {
    const configRoot = await mkdtemp(path.join(os.tmpdir(), 'piskie-plugin-market-install-live-'))
    temporaryRoots.push(configRoot)
    setPilotRoot(path.join(configRoot, 'piskiepilot'))
    const fixtures = [
      {
        source: {
          id: 'openai-plugins',
          name: 'OpenAI Plugins',
          kind: 'openai-plugin-marketplace',
          url: 'https://github.com/openai/plugins.git',
          builtin: true,
          enabled: true,
        } satisfies MarketSource,
        checkout: process.env.PISKIE_OPENAI_PLUGINS_CHECKOUT,
        name: 'wix',
      },
      {
        source: {
          id: 'anthropic-plugins',
          name: 'Anthropic Plugins',
          kind: 'anthropic-plugin-marketplace',
          url: 'https://github.com/anthropics/claude-plugins-official.git',
          builtin: true,
          enabled: true,
        } satisfies MarketSource,
        checkout: process.env.PISKIE_ANTHROPIC_PLUGINS_CHECKOUT,
        name: 'skill-creator',
      },
    ]

    for (const fixture of fixtures) {
      const directory = await checkout(fixture.source, fixture.checkout)
      const scanned = await scanPluginMarketplaceSource(fixture.source, directory, configRoot)
      const entry = scanned.entries.find((candidate) => candidate.name === fixture.name)
      expect(entry?.pluginAdapter).toBeDefined()
      const resolved = await resolvePluginPackageSource(entry!.pluginAdapter!.source)
      const adapted = await adaptHostPluginDirectory({
        format: entry!.pluginAdapter!.format as 'openai' | 'anthropic',
        directory: resolved.directory,
        marketplaceEntry: entry!.pluginAdapter!.marketplaceEntry,
      })
      try {
        const installed = await installPlugin(configRoot, {
          source: adapted.directory,
          sourceLabel: entry!.installSource,
          sourceIsRemote: true,
        })
        expect(installed.name).toBe(fixture.name)
        expect(installed.members.skills.length + installed.members.mcpServers.length).toBeGreaterThan(0)
      } finally {
        await adapted.cleanup()
        await resolved.cleanup()
      }
    }
  }, 180_000)
})
