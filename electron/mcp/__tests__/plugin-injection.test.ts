import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { setPilotRoot } from '@electron/piskiepilot/paths.js'

import { SUPPORTED_PLUGIN_SCHEMAS } from '../../plugins/manifest.js'
import { AGENT_PLUGINS_MCP_SCHEMA, parsePluginMcpFile } from '../../plugins/mcp-members.js'
import { createMcpPort } from '../ports.js'
import { publishGlobalMcpSnapshot, resolveMcpCapability } from '../runtime/capability.js'

const roots: string[] = []
let configRoot: string

beforeEach(async () => {
  // realpath：见 inventory.test.ts 同款注释（macOS /var → /private/var）
  configRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'piskie-mcp-plugin-')))
  roots.push(configRoot)
  setPilotRoot(path.join(configRoot, 'piskiepilot'))
  publishGlobalMcpSnapshot({ revision: 0, mcpServers: {}, trustedProjectServers: {} })
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function writePlugin(root: string, name: string): Promise<string> {
  const dir = path.join(root, name)
  await mkdir(dir, { recursive: true })
  await mkdir(path.join(dir, 'bin'), { recursive: true })
  await writeFile(path.join(dir, 'plugin.json'), JSON.stringify({
    $schema: SUPPORTED_PLUGIN_SCHEMAS[0],
    name,
  }), 'utf8')
  await writeFile(path.join(dir, 'mcp.json'), JSON.stringify({
    $schema: AGENT_PLUGINS_MCP_SCHEMA,
    mcpServers: { echo: { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/bin/server.js'] } },
  }), 'utf8')
  return dir
}

describe('MCP plugin contribution integration', () => {
  it('resolves global plugin servers without materializing mcp.json into the config domain', async () => {
    const pluginDir = await writePlugin(path.join(configRoot, 'plugins'), 'echo-kit')
    const capability = await resolveMcpCapability()
    expect(capability.servers).toHaveLength(1)
    expect(capability.servers[0]).toMatchObject({
      name: 'echo',
      origin: 'global-plugin',
      plugin: 'echo-kit',
    })
    expect(capability.servers[0].config.args?.[0]).toBe(path.join(pluginDir, 'bin/server.js'))
  })

  it('keeps an untrusted project plugin blocked and resolves it after trust', async () => {
    const workspace = path.join(configRoot, 'project')
    const pluginDir = await writePlugin(path.join(workspace, '.piskie', 'plugins'), 'project-echo')
    const skipped = await resolveMcpCapability({ workspace })
    expect(skipped.servers).toEqual([])
    expect(skipped.warnings.join(' ')).toContain('未过信任门')

    const parsed = await parsePluginMcpFile({
      pluginDir,
      pluginName: 'project-echo',
      dataDir: path.join(configRoot, 'plugin-data', 'project-echo'),
    })
    const port = createMcpPort({ configRoot, defaultWorkspaceDir: path.join(configRoot, 'workspace') })
    await port.trustConfiguration('echo', workspace, parsed.servers.echo)
    const included = await resolveMcpCapability({ workspace })
    expect(included.servers[0]).toMatchObject({
      name: 'echo',
      origin: 'project-plugin',
      plugin: 'project-echo',
    })
  })
})
