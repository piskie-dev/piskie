import { describe, expect, it, vi } from 'vitest'

import type { MarketSource } from '@shared/types/market.js'

import { fetchMcpRegistrySource } from '../sources/mcp-registry.js'

const source: MarketSource = {
  id: 'registry',
  name: 'Registry',
  kind: 'mcp-registry',
  url: 'https://registry.example.test',
  builtin: false,
  enabled: true,
}

describe('MCP Registry source', () => {
  it('projects HTTP and npm packages and follows cursors', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/v0.1/servers')
      expect(url.searchParams.get('limit')).toBe('100')
      expect(url.searchParams.get('version')).toBe('latest')
      const second = url.searchParams.has('cursor')
      if (second) expect(url.searchParams.get('cursor')).toBe('page-2')
      return new Response(JSON.stringify(second ? {
        servers: [{ server: {
          name: 'npm-server',
          description: 'npm transport',
          version: '1.0.0',
          packages: [{ registryType: 'npm', identifier: '@acme/mcp', version: '1.0.0' }],
        } }],
      } : {
        servers: [{ server: {
          name: 'http-server',
          description: 'http transport',
          remotes: [{ type: 'streamable-http', url: 'https://mcp.example.test/api' }],
        } }],
        metadata: { nextCursor: 'page-2' },
      }), { status: 200, headers: { etag: 'v1', 'content-type': 'application/json' } })
    }) as typeof fetch

    const result = await fetchMcpRegistrySource(source, { fetcher })
    expect(result.entries).toMatchObject([
      { name: 'http-server', mcpConfig: { url: 'https://mcp.example.test/api' } },
      { name: 'npm-server', mcpConfig: { command: 'npx', args: ['-y', '@acme/mcp@1.0.0'] } },
    ])
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(result.etag).toBe('v1')
  })

  it('stops a registry that repeats its pagination cursor', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      servers: [{ server: {
        name: 'looping-server',
        version: '1.0.0',
        packages: [{ registryType: 'npm', identifier: '@acme/looping' }],
      } }],
      metadata: { nextCursor: 'same-page' },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch

    const result = await fetchMcpRegistrySource(source, { fetcher })

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(result.entries).toHaveLength(1)
    expect(result.warnings).toEqual([
      'MCP Registry 返回重复游标 same-page，已停止分页以避免循环',
    ])
  })

  it('uses incremental timestamps, removes deleted names, and aggregates skipped rows', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      expect(url.searchParams.get('updated_since')).toBe('2026-08-08T08:00:00.000Z')
      return new Response(JSON.stringify({
        servers: [
          {
            server: { name: 'deleted-server', version: '1.0.0' },
            _meta: {
              'io.modelcontextprotocol.registry/official': { status: 'deleted' },
            },
          },
          { server: { name: 'unsupported-server', version: '2.0.0', packages: [] } },
          { server: { version: '1.0.0' } },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const result = await fetchMcpRegistrySource(source, {
      fetcher,
      updatedSince: '2026-08-08T08:00:00.000Z',
    })

    expect(result.entries).toEqual([])
    expect(result.removedNames).toEqual(['deleted-server', 'unsupported-server'])
    expect(result.warnings).toEqual([
      'MCP Registry 有 2 条 server 缺少受支持的传输配置，已忽略',
    ])
  })
})
