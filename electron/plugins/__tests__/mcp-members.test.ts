import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { AGENT_PLUGINS_MCP_SCHEMA, parsePluginMcpFile } from '../mcp-members.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(document: unknown) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'piskie-plugin-mcp-'))
  roots.push(root)
  await mkdir(path.join(root, 'bin'))
  await writeFile(path.join(root, 'mcp.json'), JSON.stringify(document), 'utf8')
  return root
}

describe('plugin mcp.json', () => {
  it('expands roots/data and contains relative host paths in the plugin root', async () => {
    const root = await fixture({
      $schema: AGENT_PLUGINS_MCP_SCHEMA,
      mcpServers: {
        jira: {
          type: 'stdio',
          command: './bin/server.js',
          args: ['--data', '${PLUGIN_DATA}/db.sqlite', './bin/config.json'],
          cwd: './',
        },
      },
    })
    const data = path.join(path.dirname(root), 'data')
    const parsed = await parsePluginMcpFile({ pluginDir: root, pluginName: 'jira-kit', dataDir: data })
    expect(parsed.ok).toBe(true)
    expect(parsed.servers.jira.command).toBe(path.join(root, 'bin/server.js'))
    expect(parsed.servers.jira.args).toContain(path.join(data, 'db.sqlite'))
    expect(parsed.servers.jira.args).toContain('./bin/config.json')
    expect(parsed.servers.jira.cwd).toBe(root)
    expect(parsed.servers.jira.env).toMatchObject({ PLUGIN_ROOT: root, PLUGIN_DATA: data })
  })

  it('isolates unsupported legacy SSE and relative path escape per server', async () => {
    const root = await fixture({
      $schema: AGENT_PLUGINS_MCP_SCHEMA,
      mcpServers: {
        valid: { type: 'stdio', command: 'node' },
        legacy: { url: 'https://example.test/sse', type: 'sse' },
        escape: { type: 'stdio', command: '../outside.js' },
      },
    })
    const parsed = await parsePluginMcpFile({ pluginDir: root, pluginName: 'bad', dataDir: `${root}-data` })
    expect(parsed.ok).toBe(true)
    expect(Object.keys(parsed.servers)).toEqual(['valid'])
    expect(parsed.issues.map((issue) => issue.code)).toEqual([
      'TRANSPORT_UNSUPPORTED',
      'MCP_SERVER_INVALID',
    ])
  })

  it('requires the canonical document schema and does not accept native compact shapes', async () => {
    const root = await fixture({
      mcpServers: {
        modern: { type: 'stdio', command: 'node' },
      },
    })
    const parsed = await parsePluginMcpFile({ pluginDir: root, pluginName: 'modern', dataDir: `${root}-data` })

    expect(parsed.ok).toBe(false)
    expect(parsed.servers).toEqual({})
    expect(parsed.issues[0].message).toContain(AGENT_PLUGINS_MCP_SCHEMA)
  })

  it('rejects bad field types and unknown fields instead of coercing or leaking them', async () => {
    const root = await fixture({
      $schema: AGENT_PLUGINS_MCP_SCHEMA,
      mcpServers: {
        badArgs: { type: 'stdio', command: 'node', args: [42] },
        unknown: { type: 'stdio', command: 'node', surprise: true },
      },
    })
    const parsed = await parsePluginMcpFile({ pluginDir: root, pluginName: 'strict', dataDir: `${root}-data` })

    expect(parsed.ok).toBe(true)
    expect(parsed.servers).toEqual({})
    expect(parsed.issues).toHaveLength(2)
    expect(parsed.issues.every((issue) => issue.code === 'MCP_SERVER_INVALID')).toBe(true)
    expect(parsed.issues.map((issue) => issue.server)).toEqual(['badArgs', 'unknown'])
  })

  it('validates streamable HTTP URL and literal header rules without expanding placeholders', async () => {
    const root = await fixture({
      $schema: AGENT_PLUGINS_MCP_SCHEMA,
      mcpServers: {
        remote: {
          type: 'streamable-http',
          url: 'https://example.test/mcp',
          headers: { 'X-Literal': '${TOKEN}' },
        },
        insecure: { type: 'streamable-http', url: 'http://example.test/mcp' },
        loopback: { type: 'streamable-http', url: 'http://127.0.0.1:7331/mcp' },
      },
    })
    const parsed = await parsePluginMcpFile({ pluginDir: root, pluginName: 'http', dataDir: `${root}-data` })

    expect(parsed.ok).toBe(true)
    expect(parsed.servers.remote.http_headers).toEqual({ 'X-Literal': '${TOKEN}' })
    expect(parsed.servers.loopback.url).toBe('http://127.0.0.1:7331/mcp')
    expect(parsed.servers.insecure).toBeUndefined()
    expect(parsed.issues).toHaveLength(1)
  })
})
