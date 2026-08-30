import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { once } from 'node:events'
import { pathToFileURL } from 'node:url'

import express from 'express'
import { describe, expect, it } from 'vitest'
import { Server as LegacyMcpServer } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import type { EffectiveMcpServer } from '@shared/types/mcp.js'

import { fetchServerSnapshot } from '../client/connection.js'
import { McpConnectionManager } from '../runtime/manager.js'

const live = process.env.PISKIE_LIVE_MCP === '1'

describe.skipIf(!live)('live MCP protocol compatibility', () => {
  it('negotiates legacy 2025-06-18 with the official everything server', async () => {
    const serverRoot = process.env.PISKIE_MCP_LEGACY_SERVER_ROOT
    if (!serverRoot) throw new Error('PISKIE_MCP_LEGACY_SERVER_ROOT must point to a temporary legacy npm install')
    const server: EffectiveMcpServer = {
      name: 'official-everything',
      origin: 'global-explicit',
      transport: 'stdio',
      config: {
        command: path.join(serverRoot, 'node_modules', '.bin', 'mcp-server-everything'),
        startup_timeout_sec: 90,
      },
    }

    const snapshot = await fetchServerSnapshot(server)

    expect(snapshot.protocolVersion).toBe('2025-06-18')
    expect(snapshot.tools.length).toBeGreaterThan(0)
    expect(snapshot.tools.some((tool) => tool.name === 'echo')).toBe(true)
  }, 120_000)

  it('connects, discovers, calls, and reconnects an isolated local stdio session', async () => {
    const source = `
      import { Server } from '@modelcontextprotocol/sdk/server/index.js';
      import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
      import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
      const server = new Server(
        { name: 'piskie-local-echo', version: '1.0.0' },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
        name: 'echo',
        description: 'Echo a message',
        inputSchema: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
        },
      }] }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => ({
        content: [{
          type: 'text',
          text: String(process.pid) + ':' + String(request.params.arguments?.message ?? ''),
        }],
      }));
      await server.connect(new StdioServerTransport());
    `
    const server: EffectiveMcpServer = {
      name: 'local-stdio-echo',
      origin: 'global-explicit',
      transport: 'stdio',
      config: {
        command: process.execPath,
        args: ['--input-type=module', '--eval', source],
        startup_timeout_sec: 15,
        tool_timeout_sec: 15,
      },
    }
    const manager = new McpConnectionManager()
    try {
      const first = await manager.createSession({ ownerId: 'live-local-stdio-a', servers: [server] })
      const second = await manager.createSession({ ownerId: 'live-local-stdio-b', servers: [server] })
      const call = async (runtime: typeof first, message: string): Promise<string> => {
        const result = await runtime.call(server.name, 'echo', { message })
        return String(result.content[0]?.text ?? '')
      }

      const firstTurn = await call(first, 'first-turn')
      const firstNextTurn = await call(first, 'next-turn')
      const secondTurn = await call(second, 'second-session')
      const firstPid = firstTurn.split(':')[0]
      const secondPid = secondTurn.split(':')[0]

      expect(firstTurn).toBe(`${firstPid}:first-turn`)
      expect(firstNextTurn).toBe(`${firstPid}:next-turn`)
      expect(secondTurn).toBe(`${secondPid}:second-session`)
      expect(secondPid).not.toBe(firstPid)
      expect(first.catalogs()[0]?.snapshot.tools.map((tool) => tool.name)).toContain('echo')

      await first.retry([server.name])
      const reconnected = await call(first, 'reconnected')
      expect(reconnected.split(':')[0]).not.toBe(firstPid)
      expect(await call(second, 'still-alive')).toBe(`${secondPid}:still-alive`)

      await first.release()
      expect(await call(second, 'after-peer-release')).toBe(`${secondPid}:after-peer-release`)
    } finally {
      await manager.dispose()
    }
  }, 60_000)

  it('negotiates 2026-07-28 and calls a tool through the official v2 server SDK', async () => {
    const serverRoot = process.env.PISKIE_MCP_V2_SERVER_ROOT
    if (!serverRoot) throw new Error('PISKIE_MCP_V2_SERVER_ROOT must point to a temporary v2 npm install')
    const moduleUrl = (relative: string) => pathToFileURL(path.join(serverRoot, 'node_modules', relative)).href
    const serverModule = moduleUrl('@modelcontextprotocol/server/dist/index.mjs')
    const stdioModule = moduleUrl('@modelcontextprotocol/server/dist/stdio.mjs')
    const zodModule = moduleUrl('zod/index.js')
    const source = `
      import { McpServer } from ${JSON.stringify(serverModule)};
      import { serveStdio } from ${JSON.stringify(stdioModule)};
      import { z } from ${JSON.stringify(zodModule)};
      serveStdio(() => {
        const server = new McpServer({ name: 'piskie-v2-echo', version: '1.0.0' });
        server.registerTool('echo', {
          description: 'Echo a message',
          inputSchema: z.object({ message: z.string() }),
        }, async ({ message }) => ({ content: [{ type: 'text', text: message }] }));
        return server;
      }, { legacy: 'reject' });
    `
    const server: EffectiveMcpServer = {
      name: 'official-v2-echo',
      origin: 'global-explicit',
      transport: 'stdio',
      config: {
        command: process.execPath,
        args: ['--input-type=module', '--eval', source],
        enable_2026_protocol: true,
        startup_timeout_sec: 30,
        tool_timeout_sec: 30,
      },
    }
    const manager = new McpConnectionManager()
    try {
      const runtime = await manager.createSession({ ownerId: 'live-v2', servers: [server] })
      await expect(runtime.call(server.name, 'echo', { message: 'v2-ok' })).resolves.toMatchObject({
        content: [expect.objectContaining({ type: 'text', text: 'v2-ok' })],
      })
      expect(runtime.catalogs()[0]?.snapshot.protocolVersion).toBe('2026-07-28')
      expect(runtime.catalogs()[0]?.snapshot.tools.map((tool) => tool.name)).toContain('echo')
    } finally {
      await manager.dispose()
    }
  }, 60_000)

  it('auto-negotiates Streamable HTTP and falls back to a 2025 server', async () => {
    const app = express()
    app.use(express.json())
    app.post('/mcp', async (request, response) => {
      const server = new LegacyMcpServer(
        { name: 'legacy-http-echo', version: '1.0.0' },
        { capabilities: { tools: {} } },
      )
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
        name: 'echo',
        description: 'Echo a message over Streamable HTTP',
        inputSchema: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
        },
      }] }))
      server.setRequestHandler(CallToolRequestSchema, async (toolRequest) => ({
        content: [{
          type: 'text',
          text: String(toolRequest.params.arguments?.message ?? ''),
        }],
      }))
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      response.on('close', () => {
        void transport.close()
        void server.close()
      })
      try {
        await server.connect(transport)
        await transport.handleRequest(request, response, request.body)
      } catch (error) {
        if (!response.headersSent) response.status(500).json({ error: String(error) })
      }
    })
    app.get('/mcp', (_request, response) => response.status(405).end())
    app.delete('/mcp', (_request, response) => response.status(405).end())
    const httpServer = app.listen(0, '127.0.0.1')
    await once(httpServer, 'listening')
    const address = httpServer.address() as AddressInfo
    const server: EffectiveMcpServer = {
      name: 'legacy-http-echo',
      origin: 'global-explicit',
      transport: 'streamable_http',
      config: {
        url: `http://127.0.0.1:${address.port}/mcp`,
        startup_timeout_sec: 15,
      },
    }

    const manager = new McpConnectionManager()
    try {
      const runtime = await manager.createSession({ ownerId: 'live-http', servers: [server] })
      await expect(runtime.call(server.name, 'echo', { message: 'http-ok' })).resolves.toMatchObject({
        content: [expect.objectContaining({ type: 'text', text: 'http-ok' })],
      })
      expect(runtime.catalogs()[0]?.snapshot.protocolVersion).toBe('2025-06-18')
      expect(runtime.catalogs()[0]?.snapshot.tools.map((tool) => tool.name)).toContain('echo')

      await runtime.retry([server.name])
      await expect(runtime.call(server.name, 'echo', { message: 'http-reconnected' }))
        .resolves.toMatchObject({
          content: [expect.objectContaining({ type: 'text', text: 'http-reconnected' })],
        })
    } finally {
      await manager.dispose()
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => error ? reject(error) : resolve())
      })
    }
  }, 30_000)
})
