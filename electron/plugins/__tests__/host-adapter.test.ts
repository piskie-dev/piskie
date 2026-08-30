import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { adaptHostPluginDirectory, inspectHostPluginDirectory } from '../host-adapter.js'
import { readPluginManifestFromDir, SUPPORTED_PLUGIN_SCHEMAS } from '../manifest.js'
import { AGENT_PLUGINS_MCP_SCHEMA, parsePluginMcpFile } from '../mcp-members.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporary(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  roots.push(root)
  return root
}

async function writeSkill(root: string, relative: string, name: string): Promise<void> {
  const directory = path.join(root, relative)
  await mkdir(directory, { recursive: true })
  await writeFile(
    path.join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} fixture\n---\n\n# ${name}\n`,
    'utf8',
  )
}

describe('host plugin adapters', () => {
  it('projects OpenAI Skills/MCP into a canonical package and reports host-only capabilities', async () => {
    const root = await temporary('piskie-openai-adapter-')
    await mkdir(path.join(root, '.codex-plugin'), { recursive: true })
    await writeSkill(root, 'skills/research', 'research')
    await writeFile(path.join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({
      name: 'research-suite',
      version: '1.2.0',
      description: 'Research suite',
      skills: './skills/',
      mcpServers: './.mcp.json',
      apps: './.app.json',
      interface: { displayName: 'Research Suite' },
    }), 'utf8')
    await writeFile(path.join(root, '.mcp.json'), JSON.stringify({
      mcpServers: {
        remote: {
          type: 'http',
          url: 'https://mcp.example.test/mcp',
          oauth_resource: 'https://mcp.example.test',
        },
        local: {
          command: 'node',
          args: ['${CODEX_PLUGIN_ROOT}/server.mjs'],
        },
      },
    }), 'utf8')

    const inspected = await inspectHostPluginDirectory({
      format: 'openai',
      directory: root,
      marketplaceEntry: { name: 'research-suite' },
    })
    expect(inspected).toMatchObject({
      installable: true,
      compatibility: {
        status: 'partial',
        supported: ['skills', 'mcp'],
      },
      skills: [{ name: 'research' }],
    })
    expect(inspected.compatibility.unsupported).toEqual(expect.arrayContaining([
      'apps',
      'interface',
      'mcp-auth',
    ]))

    const adapted = await adaptHostPluginDirectory({
      format: 'openai',
      directory: root,
      marketplaceEntry: { name: 'research-suite' },
    })
    try {
      await expect(access(path.join(adapted.directory, '.codex-plugin'))).rejects.toThrow()
      await expect(access(path.join(adapted.directory, 'skills', 'research', 'SKILL.md'))).resolves.toBeUndefined()
      const manifest = await readPluginManifestFromDir(adapted.directory)
      expect(manifest.ok).toBe(true)
      if (manifest.ok) expect(manifest.manifest.$schema).toBe(SUPPORTED_PLUGIN_SCHEMAS[0])
      const rawMcp = JSON.parse(await readFile(path.join(adapted.directory, 'mcp.json'), 'utf8'))
      expect(rawMcp.$schema).toBe(AGENT_PLUGINS_MCP_SCHEMA)
      const mcp = await parsePluginMcpFile({
        pluginDir: adapted.directory,
        pluginName: 'research-suite',
        dataDir: path.join(root, 'data'),
      })
      expect(mcp.ok).toBe(true)
      expect(Object.keys(mcp.servers)).toEqual(['remote', 'local'])
      expect(mcp.servers.local.args).toEqual([path.join(adapted.directory, 'server.mjs')])
    } finally {
      await adapted.cleanup()
    }
  })

  it('keeps an OpenAI Apps-only package visible but non-installable', async () => {
    const root = await temporary('piskie-openai-app-only-')
    await mkdir(path.join(root, '.codex-plugin'), { recursive: true })
    await writeFile(path.join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({
      name: 'app-only',
      apps: './.app.json',
      interface: { displayName: 'App only' },
    }), 'utf8')
    const inspected = await inspectHostPluginDirectory({ format: 'openai', directory: root })
    expect(inspected).toMatchObject({
      installable: false,
      compatibility: { status: 'unsupported', supported: [] },
    })
    await expect(adaptHostPluginDirectory({ format: 'openai', directory: root }))
      .rejects.toThrow('没有可投影')
  })

  it('uses an Anthropic strict:false marketplace entry as component authority', async () => {
    const root = await temporary('piskie-anthropic-adapter-')
    await writeSkill(root, 'portable', 'portable')
    await mkdir(path.join(root, 'agents'), { recursive: true })
    await writeFile(path.join(root, 'agents', 'reviewer.md'), 'review', 'utf8')
    const marketplaceEntry = {
      name: 'portable-kit',
      version: '2.0.0',
      description: 'Portable kit',
      strict: false,
      skills: ['./portable'],
      mcpServers: {
        helper: {
          command: 'node',
          args: ['${CLAUDE_PLUGIN_ROOT}/server.mjs'],
        },
      },
      agents: ['./agents/reviewer.md'],
    }
    const adapted = await adaptHostPluginDirectory({
      format: 'anthropic',
      directory: root,
      marketplaceEntry,
    })
    try {
      expect(adapted).toMatchObject({
        installable: true,
        compatibility: { status: 'partial', supported: ['skills', 'mcp'] },
      })
      expect(adapted.compatibility.unsupported).toContain('agents')
      const mcp = await parsePluginMcpFile({
        pluginDir: adapted.directory,
        pluginName: 'portable-kit',
        dataDir: path.join(root, 'data'),
      })
      expect(mcp.servers.helper.args).toEqual([path.join(adapted.directory, 'server.mjs')])
    } finally {
      await adapted.cleanup()
    }
  })

  it('rejects Anthropic strict:false component conflicts instead of merging heuristically', async () => {
    const root = await temporary('piskie-anthropic-conflict-')
    await mkdir(path.join(root, '.claude-plugin'), { recursive: true })
    await writeFile(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'conflict-kit',
      skills: './skills/',
    }), 'utf8')
    await expect(inspectHostPluginDirectory({
      format: 'anthropic',
      directory: root,
      marketplaceEntry: { name: 'conflict-kit', strict: false, skills: ['./portable'] },
    })).rejects.toThrow('strict:false')
  })
})
