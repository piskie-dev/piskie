import type { EffectiveMcpServer, McpServerConfig } from '@shared/types/mcp.js'

export const MCP_REDACTED = '[redacted]'

export interface McpSanitizeOptions {
  server?: EffectiveMcpServer
  servers?: readonly EffectiveMcpServer[]
  additionalSecrets?: readonly (string | undefined)[]
  maxLength?: number
}

const SENSITIVE_KEY = [
  'proxy[-_]?authorization',
  'authorization',
  'x[-_]?api[-_]?key',
  'api[-_]?key',
  'apikey',
  'access[-_]?token',
  'refresh[-_]?token',
  'id[-_]?token',
  'client[-_]?secret',
  'password',
  'passwd',
  'set[-_]?cookie',
  'cookie',
  'token',
  'secret',
].join('|')

const DOUBLE_QUOTED_SECRET = new RegExp(
  `("(?:${SENSITIVE_KEY})"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`,
  'gi',
)
const SINGLE_QUOTED_SECRET = new RegExp(
  `('(?:${SENSITIVE_KEY})'\\s*:\\s*)'(?:\\\\.|[^'\\\\])*'`,
  'gi',
)
const ASSIGNED_SECRET = new RegExp(
  `((?:["'])?(?:${SENSITIVE_KEY})(?:["'])?\\s*[:=]\\s*)`
  + `("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,;}]+)`,
  'gi',
)

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function addSecret(target: Set<string>, value: unknown): void {
  if (typeof value !== 'string' || value.length < 3 || value === MCP_REDACTED) return
  target.add(value)
  try {
    const encoded = encodeURIComponent(value)
    if (encoded !== value && encoded.length >= 3) target.add(encoded)
  } catch {
    // Invalid surrogate input is still covered by its exact unencoded value.
  }
}

function addHeaderSecret(target: Set<string>, value: unknown): void {
  addSecret(target, value)
  if (typeof value !== 'string') return
  const credential = value.match(/^\s*(?:Bearer|Basic)\s+(.+?)\s*$/i)?.[1]
  addSecret(target, credential)
}

function collectConfigSecrets(target: Set<string>, config: McpServerConfig): void {
  for (const value of Object.values(config.http_headers ?? {})) addHeaderSecret(target, value)
  for (const value of Object.values(config.env ?? {})) addSecret(target, value)
  for (const envName of Object.values(config.env_http_headers ?? {})) {
    addHeaderSecret(target, process.env[envName])
  }
  if (config.bearer_token_env_var) addSecret(target, process.env[config.bearer_token_env_var])

  for (let index = 0; index < (config.args?.length ?? 0); index += 1) {
    const argument = config.args?.[index]
    if (!argument) continue
    const assignment = argument.match(
      /^(?:--?)?(?:api[-_]?key|access[-_]?token|token|secret|password|cookie)=(.+)$/i,
    )
    if (assignment?.[1]) addSecret(target, assignment[1])
    if (/^(?:--?)?(?:api[-_]?key|access[-_]?token|token|secret|password|cookie)$/i.test(argument)) {
      addSecret(target, config.args?.[index + 1])
    }
  }

  if (config.url) {
    try {
      const url = new URL(config.url)
      addSecret(target, url.password)
      for (const value of url.searchParams.values()) addSecret(target, value)
    } catch {
      // Shape validation reports malformed URLs; regex redaction still handles readable query text.
    }
  }
}

export function collectMcpSecretValues(options: McpSanitizeOptions = {}): readonly string[] {
  const secrets = new Set<string>()
  if (options.server) collectConfigSecrets(secrets, options.server.config)
  for (const server of options.servers ?? []) collectConfigSecrets(secrets, server.config)
  for (const value of options.additionalSecrets ?? []) addSecret(secrets, value)
  return [...secrets].sort((left, right) => right.length - left.length)
}

function redactUrlCredentialsAndQueries(text: string): string {
  const withoutUserInfo = text.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s/@]+@/gi,
    `$1${MCP_REDACTED}@`,
  )
  return withoutUserInfo.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/[^\s"'<>?#]+)\?([^\s"'<>#]*)/gi,
    (_match, base: string, query: string) => {
      const redacted = query.split('&').map((part) => {
        const separator = part.indexOf('=')
        const key = separator >= 0 ? part.slice(0, separator) : part
        return `${key}=${MCP_REDACTED}`
      }).join('&')
      return `${base}?${redacted}`
    },
  )
}

/** Redacts protocol-shaped credentials plus exact values captured by the effective server config. */
export function sanitizeMcpText(value: unknown, options: McpSanitizeOptions = {}): string {
  let text = errorText(value)
  for (const secret of collectMcpSecretValues(options)) {
    text = text.split(secret).join(MCP_REDACTED)
  }

  text = redactUrlCredentialsAndQueries(text)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${MCP_REDACTED}`)
    .replace(/\b((?:set-)?cookie\s*:\s*)[^\r\n,}]+/gi, `$1${MCP_REDACTED}`)
    .replace(DOUBLE_QUOTED_SECRET, `$1"${MCP_REDACTED}"`)
    .replace(SINGLE_QUOTED_SECRET, `$1'${MCP_REDACTED}'`)
    .replace(ASSIGNED_SECRET, `$1${MCP_REDACTED}`)

  return options.maxLength === undefined ? text : text.slice(0, Math.max(0, options.maxLength))
}

export function sanitizeMcpErrorText(
  error: unknown,
  options: McpSanitizeOptions = {},
): string {
  return sanitizeMcpText(errorText(error), options)
}

export type McpLogValueShape = Readonly<{
  type: 'array' | 'bigint' | 'boolean' | 'function' | 'null' | 'number' | 'object' | 'string' | 'symbol' | 'undefined'
  length?: number
  propertyCount?: number
}>

function logValueShape(value: unknown): McpLogValueShape {
  if (value === null) return { type: 'null' }
  if (Array.isArray(value)) return { type: 'array', length: value.length }
  if (typeof value === 'string') return { type: 'string', length: value.length }
  if (typeof value === 'object') {
    return { type: 'object', propertyCount: Object.keys(value).length }
  }
  return { type: typeof value }
}

/** MCP argument logs retain only top-level field names and value shapes, never field values. */
export function mcpLogParamShape(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return logValueShape(value)
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, logValueShape(item)]),
  )
}

export interface McpLogFinishSummary {
  ok?: boolean
  textLength?: number
  imageCount?: number
  persistedBytes?: number
  dataShape?: McpLogValueShape
  errorShape?: McpLogValueShape
}

/** MCP finish logs retain result sizes and value shapes, never result/error payloads. */
export function mcpLogFinishSummary(input: Readonly<{
  result?: Readonly<{
    ok: boolean
    text: string
    images?: readonly unknown[]
    persisted?: Readonly<{ bytes: number }>
  }>
  data?: unknown
  error?: unknown
}>): McpLogFinishSummary {
  const { result } = input
  return {
    ok: result?.ok,
    textLength: result?.text.length,
    imageCount: result?.images?.length,
    persistedBytes: result?.persisted?.bytes,
    dataShape: input.data === undefined ? undefined : logValueShape(input.data),
    errorShape: input.error === undefined ? undefined : logValueShape(input.error),
  }
}

/** Abort remains control flow and must never be converted into an ordinary MCP ToolOutput error. */
export function isMcpAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  if (error instanceof DOMException && error.name === 'AbortError') return true
  if (error instanceof Error && error.name === 'AbortError') return true
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code
    return code === 'ABORT_ERR' || code === 'ERR_ABORTED'
  }
  return false
}
