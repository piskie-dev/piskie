import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { buffer as consumeBuffer } from 'node:stream/consumers'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ZipFile } from 'yazl'

import { setPilotRoot } from '@electron/piskiepilot/paths.js'

import { readRegistry } from '../../skills/store/registry.js'
import { createMcpPort } from '../../mcp/ports.js'
import { installPlugin, removePlugin } from '../install.js'
import { SUPPORTED_PLUGIN_SCHEMAS } from '../manifest.js'
import { AGENT_PLUGINS_MCP_SCHEMA } from '../mcp-members.js'
import { pluginDataDir, readPluginsFile } from '../store.js'

const roots: string[] = []
let configRoot: string

beforeEach(async () => {
  configRoot = await mkdtemp(path.join(os.tmpdir(), 'piskie-plugin-install-'))
  roots.push(configRoot)
  setPilotRoot(path.join(configRoot, 'piskiepilot'))
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makePlugin(name = 'jira-kit', invalidSkill = false): Promise<string> {
  const source = path.join(configRoot, 'sources', name)
  await mkdir(source, { recursive: true })
  await mkdir(path.join(source, 'skills', 'jira-helper'), { recursive: true })
  await mkdir(path.join(source, 'bin'), { recursive: true })
  await writeFile(path.join(source, 'plugin.json'), JSON.stringify({
    $schema: SUPPORTED_PLUGIN_SCHEMAS[0],
    name,
    version: '1.2.0',
    description: 'Jira plugin',
  }), 'utf8')
  await writeFile(path.join(source, 'skills', 'jira-helper', 'SKILL.md'), invalidSkill
    ? 'not-frontmatter'
    : '---\nname: jira-helper\ndescription: Work with Jira\n---\n\n# Jira\n', 'utf8')
  await writeFile(path.join(source, 'mcp.json'), JSON.stringify({
    $schema: AGENT_PLUGINS_MCP_SCHEMA,
    mcpServers: { jira: { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/bin/server.js'] } },
  }), 'utf8')
  await writeFile(path.join(source, 'bin', 'server.js'), '', 'utf8')
  return source
}

describe('plugin install transaction', () => {
  it('installs a local plugin ZIP through the shared archive owner', async () => {
    const archive = path.join(configRoot, 'zipped-kit.zip')
    const zip = new ZipFile()
    zip.addBuffer(Buffer.from(JSON.stringify({
      $schema: SUPPORTED_PLUGIN_SCHEMAS[0],
      name: 'zipped-kit',
      version: '1.0.0',
      description: 'ZIP fixture',
    })), 'zipped-kit/plugin.json')
    zip.addBuffer(
      Buffer.from('---\nname: jira-helper\ndescription: Work with Jira\n---\n'),
      'zipped-kit/skills/jira-helper/SKILL.md',
    )
    const output = consumeBuffer(zip.outputStream as Readable)
    zip.end()
    await writeFile(archive, await output)

    const installed = await installPlugin(configRoot, { source: archive })
    expect(installed).toMatchObject({
      name: 'zipped-kit',
      members: { skills: [{ name: 'jira-helper' }] },
    })
    await expect(access(path.join(installed.path, 'plugin.json'))).resolves.toBeUndefined()
  })

  it('installs members in place, records provenance and cascades removal', async () => {
    const source = await makePlugin()
    const installed = await installPlugin(configRoot, { source })
    expect(installed).toMatchObject({
      name: 'jira-kit',
      scope: 'user',
      members: { skills: [{ name: 'jira-helper' }], mcpServers: [{ name: 'jira' }] },
    })

    const store = await readPluginsFile(configRoot)
    expect(store).toMatchObject({ revision: 1, plugins: [{ name: 'jira-kit' }] })
    const registry = await readRegistry(path.join(configRoot, 'piskiepilot', 'skills'))
    expect(registry.skills['jira-helper']).toMatchObject({
      installedFrom: { plugin: 'jira-kit', version: '1.2.0' },
    })
    expect(registry.skills['jira-helper'].path).toContain(path.join('plugins', 'jira-kit', 'skills', 'jira-helper'))
    await expect(access(path.join(registry.skills['jira-helper'].path, 'SKILL.md'))).resolves.toBeUndefined()
    await expect(readFile(path.join(registry.skills['jira-helper'].path, 'SKILL.md'), 'utf8'))
      .resolves.not.toContain('.skill-meta')

    await writeFile(path.join(pluginDataDir(configRoot, 'jira-kit'), 'keep.txt'), 'data', 'utf8')
    await removePlugin(configRoot, { name: 'jira-kit' })
    expect((await readRegistry(path.join(configRoot, 'piskiepilot', 'skills'))).skills).toEqual({})
    await expect(access(path.join(pluginDataDir(configRoot, 'jira-kit'), 'keep.txt'))).resolves.toBeUndefined()
  })

  it('isolates an invalid Skill and still commits valid members', async () => {
    const source = await makePlugin('broken-kit', true)
    const installed = await installPlugin(configRoot, { source })
    expect(installed.members).toMatchObject({
      skills: [],
      mcpServers: [{ name: 'jira' }],
    })
    expect(installed.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('jira-helper'),
    ]))
    expect((await readPluginsFile(configRoot)).plugins).toEqual([
      expect.objectContaining({ name: 'broken-kit' }),
    ])
    expect((await readRegistry(path.join(configRoot, 'piskiepilot', 'skills'))).skills).toEqual({})
  })

  it('installs project copies independently and rejects executable members', async () => {
    const source = await makePlugin('project-kit')
    const workspaceA = path.join(configRoot, 'workspace-a')
    const workspaceB = path.join(configRoot, 'workspace-b')
    await mkdir(workspaceA)
    await mkdir(workspaceB)
    await installPlugin(configRoot, { source, scope: 'project', workspace: workspaceA })
    await installPlugin(configRoot, { source, scope: 'project', workspace: workspaceB })
    await removePlugin(configRoot, { name: 'project-kit', scope: 'project', workspace: workspaceA })
    await expect(access(path.join(workspaceB, '.piskie', 'plugins', 'project-kit'))).resolves.toBeUndefined()

    await writeFile(path.join(source, 'skills', 'jira-helper', 'skill.ts'), 'export default {}', 'utf8')
    await expect(installPlugin(configRoot, {
      source,
      scope: 'project',
      workspace: workspaceA,
    })).rejects.toMatchObject({ code: 'EXECUTABLE_SCOPE_BLOCKED' })
  })

  it('项目插件首次安装即信任，更新后的 MCP 配置变化必须重新确认', async () => {
    const source = await makePlugin('trust-kit')
    const workspace = path.join(configRoot, 'workspace-trust')
    await mkdir(workspace)
    const mcp = createMcpPort({
      configRoot,
      defaultWorkspaceDir: path.join(configRoot, 'workspace'),
    })
    const hooks = {
      trustProjectServer: async (name: string, target: string, config: import('@shared/types/mcp.js').McpServerConfig) => {
        await mcp.trustConfiguration(name, target, config)
      },
    }

    await installPlugin(configRoot, { source, scope: 'project', workspace }, hooks)
    expect((await mcp.list({ scope: 'project', workspace }))[0]).toMatchObject({ trusted: true })

    await writeFile(path.join(source, 'mcp.json'), JSON.stringify({
      $schema: AGENT_PLUGINS_MCP_SCHEMA,
      mcpServers: {
        jira: { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/bin/server.js', '--v2'] },
      },
    }), 'utf8')
    await installPlugin(configRoot, { source, scope: 'project', workspace, force: true }, hooks)

    expect((await mcp.list({ scope: 'project', workspace }))[0]).toMatchObject({
      trusted: false,
      config: { args: [expect.stringContaining('server.js'), '--v2'] },
    })
  })
})
