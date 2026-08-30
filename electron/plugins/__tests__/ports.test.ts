import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createPluginsPort } from '../ports.js'
import { SUPPORTED_PLUGIN_SCHEMAS } from '../manifest.js'
import { AGENT_PLUGINS_MCP_SCHEMA } from '../mcp-members.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ configRoot: string; source: string }> {
  const configRoot = await mkdtemp(path.join(os.tmpdir(), 'piskie-plugin-port-'))
  roots.push(configRoot)
  const source = path.join(configRoot, 'source')
  await mkdir(source, { recursive: true })
  await writeFile(path.join(source, 'plugin.json'), JSON.stringify({
    $schema: SUPPORTED_PLUGIN_SCHEMAS[0],
    name: 'echo-kit',
    version: '1.0.0',
  }), 'utf8')
  await writeFile(path.join(source, 'mcp.json'), JSON.stringify({
    $schema: AGENT_PLUGINS_MCP_SCHEMA,
    mcpServers: { echo: { type: 'stdio', command: 'echo-server' } },
  }), 'utf8')
  return { configRoot, source }
}

describe('PluginsPort MCP onboarding', () => {
  it('keeps a committed plugin installed when post-install onboarding fails', async () => {
    const { configRoot, source } = await fixture()
    const onboardMcpServer = vi.fn(async () => {
      throw new Error('server unavailable')
    })
    const port = createPluginsPort({ configRoot, onboardMcpServer })

    const installed = await port.install({ source })

    expect(installed.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('echo: MCP onboarding 失败：server unavailable'),
    ]))
    await expect(access(path.join(configRoot, 'plugins', 'echo-kit', 'mcp.json'))).resolves.toBeUndefined()
    await expect(port.show('echo-kit')).resolves.toMatchObject({
      name: 'echo-kit',
      members: { mcpServers: [{ name: 'echo' }] },
    })
  })

  it('passes the market authentication policy into the shared onboarding hook', async () => {
    const { configRoot, source } = await fixture()
    const onboardMcpServer = vi.fn(async () => ({
      name: 'echo',
      oauth: { supported: false },
      probe: { toolCount: 1 },
      warnings: [],
    }))
    const port = createPluginsPort({ configRoot, onboardMcpServer })

    await port.install({ source }, { loginMcp: true })

    expect(onboardMcpServer).toHaveBeenCalledWith('echo', undefined, { login: true })
  })
})
