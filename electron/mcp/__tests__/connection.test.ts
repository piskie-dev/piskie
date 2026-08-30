import { describe, expect, it } from 'vitest'

import type { EffectiveMcpServer } from '@shared/types/mcp.js'
import { buildMcpEnvironment, protocolNegotiationMode } from '../client/connection.js'

function server(
  transport: EffectiveMcpServer['transport'],
  enable2026?: boolean,
): EffectiveMcpServer {
  return {
    name: 'protocol-test',
    origin: 'global-explicit',
    transport,
    config: transport === 'stdio'
      ? { command: 'server', enable_2026_protocol: enable2026 }
      : { url: 'https://example.com/mcp' },
  }
}

describe('MCP protocol negotiation', () => {
  it('stdio 默认 legacy，显式 opt-in 后自动协商 2026', () => {
    expect(protocolNegotiationMode(server('stdio'))).toBe('legacy')
    expect(protocolNegotiationMode(server('stdio', true))).toBe('auto')
  })

  it('Streamable HTTP 始终自动探测并回退', () => {
    expect(protocolNegotiationMode(server('streamable_http'))).toBe('auto')
  })
})

describe('MCP stdio environment', () => {
  it('inherits the complete host environment even when server env is empty', () => {
    expect(buildMcpEnvironment({ command: 'server' }, {
      PATH: '/host/bin',
      DISPLAY: ':0',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      CUSTOM_API_KEY: 'secret-value',
    })).toEqual({
      PATH: '/host/bin',
      DISPLAY: ':0',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      CUSTOM_API_KEY: 'secret-value',
    })
  })

  it('applies explicit server env after the inherited host environment', () => {
    expect(buildMcpEnvironment({
      command: 'server',
      env: { PATH: '/server/bin', SERVER_ONLY: 'enabled' },
    }, {
      PATH: '/host/bin',
      DISPLAY: ':0',
    })).toEqual({
      PATH: '/server/bin',
      DISPLAY: ':0',
      SERVER_ONLY: 'enabled',
    })
  })
})
