import { afterEach, describe, expect, it } from 'vitest'

import type { EffectiveMcpServer } from '@shared/types/mcp.js'
import {
  isMcpAbortError,
  mcpLogFinishSummary,
  mcpLogParamShape,
  sanitizeMcpErrorText,
  sanitizeMcpText,
} from '../security/sanitize.js'

const ENV_HEADER = 'PISKIE_TEST_MCP_HEADER_SECRET'
const ENV_BEARER = 'PISKIE_TEST_MCP_BEARER_SECRET'

afterEach(() => {
  delete process.env[ENV_HEADER]
  delete process.env[ENV_BEARER]
})

function configuredServer(): EffectiveMcpServer {
  process.env[ENV_HEADER] = 'dynamic-header-secret-value'
  process.env[ENV_BEARER] = 'bearer-env-secret-value'
  return {
    name: 'secure',
    origin: 'global-explicit',
    transport: 'streamable_http',
    config: {
      url: 'https://user:url-password-secret@example.test/mcp?tenant=tenant-query-secret',
      http_headers: { 'X-Custom-Credential': 'static-header-secret-value' },
      env_http_headers: { 'X-Dynamic-Credential': ENV_HEADER },
      bearer_token_env_var: ENV_BEARER,
      env: { CUSTOM_MCP_CREDENTIAL: 'configured-env-secret-value' },
      args: ['--password', 'argument-secret-value'],
    },
  }
}

describe('MCP secret sanitizer', () => {
  it('redacts quoted JSON keys, auth schemes, cookies, and URL query values', () => {
    const input = [
      '{"Authorization":"Bearer json-bearer", "api-key": "json-api-key",',
      "'password':'json-password', 'cookie':'sid=json-cookie'}",
      'Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1l',
      'Cookie: session=cookie-value; csrf=csrf-value',
      'GET https://example.test/path?access_token=query-token&project=visible-project#part',
    ].join(' ')
    const output = sanitizeMcpText(input)

    for (const secret of [
      'json-bearer',
      'json-api-key',
      'json-password',
      'json-cookie',
      'YWxhZGRpbjpvcGVuc2VzYW1l',
      'cookie-value',
      'csrf-value',
      'query-token',
      'visible-project',
    ]) {
      expect(output).not.toContain(secret)
    }
    expect(output).toContain('[redacted]')
  })

  it('redacts exact secret values resolved from headers, env references, bearer env, args, and URL', () => {
    const server = configuredServer()
    const input = [
      'upstream echoed static-header-secret-value',
      'dynamic-header-secret-value bearer-env-secret-value',
      'configured-env-secret-value argument-secret-value',
      'url-password-secret tenant-query-secret',
    ].join(' | ')
    const output = sanitizeMcpErrorText(new Error(input), { server })

    for (const secret of [
      'static-header-secret-value',
      'dynamic-header-secret-value',
      'bearer-env-secret-value',
      'configured-env-secret-value',
      'argument-secret-value',
      'url-password-secret',
      'tenant-query-secret',
    ]) {
      expect(output).not.toContain(secret)
    }
  })

  it('caps Renderer summaries at 512 characters after redaction', () => {
    const output = sanitizeMcpErrorText(
      new Error(`token=never-render-this ${'x'.repeat(2_000)}`),
      { maxLength: 512 },
    )
    expect(output).not.toContain('never-render-this')
    expect(output.length).toBeLessThanOrEqual(512)
  })

  it('reduces MCP log params to field shapes without retaining values', () => {
    const shape = mcpLogParamShape({
      query: 'raw-query-secret',
      count: 3,
      flags: ['private-flag'],
      nested: { token: 'nested-secret' },
      empty: null,
    })

    expect(shape).toEqual({
      query: { type: 'string', length: 16 },
      count: { type: 'number' },
      flags: { type: 'array', length: 1 },
      nested: { type: 'object', propertyCount: 1 },
      empty: { type: 'null' },
    })
    expect(JSON.stringify(shape)).not.toContain('raw-query-secret')
    expect(JSON.stringify(shape)).not.toContain('private-flag')
    expect(JSON.stringify(shape)).not.toContain('nested-secret')
  })

  it.each([true, false])('reduces MCP finish payloads to safe sizes and shapes (ok=%s)', (ok) => {
    const summary = mcpLogFinishSummary({
      result: {
        ok,
        text: 'result-text-secret',
        images: [{ base64: 'image-payload-secret' }],
        persisted: { bytes: 321 },
      },
      data: { access_token: 'structured-data-secret' },
      error: new Error('error-message-secret'),
    })

    expect(summary).toEqual({
      ok,
      textLength: 18,
      imageCount: 1,
      persistedBytes: 321,
      dataShape: { type: 'object', propertyCount: 1 },
      errorShape: { type: 'object', propertyCount: 0 },
    })
    const serialized = JSON.stringify(summary)
    expect(serialized).not.toContain('result-text-secret')
    expect(serialized).not.toContain('image-payload-secret')
    expect(serialized).not.toContain('structured-data-secret')
    expect(serialized).not.toContain('error-message-secret')
  })

  it('classifies Abort as control flow without rewriting its reason', () => {
    const abort = new DOMException('stop now', 'AbortError')
    expect(isMcpAbortError(abort)).toBe(true)

    const controller = new AbortController()
    const reason = new Error('caller cancelled')
    controller.abort(reason)
    expect(isMcpAbortError(new Error('unrelated'), controller.signal)).toBe(true)
    expect(controller.signal.reason).toBe(reason)
  })
})
