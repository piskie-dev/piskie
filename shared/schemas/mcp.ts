import { z } from 'zod'

/** 全局配置、项目 overlay 与插件 mcp.json 共用的严格 server 契约。 */
export const mcpServerConfigSchema = z.strictObject({
  command: z.string().min(1).optional()
    .describe('stdio transport: executable to launch. Mutually exclusive with url.'),
  args: z.array(z.string().describe('One stdio command argument.'))
    .optional().describe('stdio transport: command arguments.'),
  env: z.record(z.string(), z.string().describe('Environment variable value passed to the stdio server.'))
    .optional().describe('stdio transport: overrides applied after inheriting the Piskie host environment.'),
  cwd: z.string().optional().describe('stdio transport: working directory for the server process.'),
  enable_2026_protocol: z.boolean().optional()
    .describe('stdio transport: opt in to automatic 2026-07-28 protocol negotiation.'),
  url: z.string().url().optional()
    .describe('streamable_http transport: server endpoint URL. Mutually exclusive with command.'),
  http_headers: z.record(z.string(), z.string().describe('Static HTTP header value.')).optional()
    .describe('streamable_http: static request headers.'),
  env_http_headers: z.record(z.string(), z.string().describe('Environment variable name supplying this HTTP header.')).optional()
    .describe('streamable_http: headers filled from the named environment variables.'),
  bearer_token_env_var: z.string()
    .describe('Environment variable containing the bearer token for streamable HTTP.')
    .optional(),
  oauth: z.strictObject({
    client_id: z.string().describe('Optional pre-registered OAuth client ID.').optional(),
  }).describe('OAuth client configuration for streamable HTTP.').optional(),
  oauth_resource: z.string().describe('OAuth protected-resource identifier.').optional(),
  scopes: z.array(z.string().describe('One OAuth scope requested from the authorization server.'))
    .describe('OAuth scopes requested for this server.').optional(),
  proxyId: z.string().trim().min(1)
    .describe('Global proxy ID used by this streamable HTTP server.')
    .meta({
      'x-piskie': {
        reference: { domain: 'proxies', collection: 'proxies', onDelete: 'reject' },
        applyMode: 'next-injection',
      },
    })
    .optional(),
  enabled: z.boolean().describe('Whether this server participates in the effective set.').optional(),
  startup_timeout_sec: z.number().positive()
    .describe('Maximum seconds allowed for startup and protocol negotiation.')
    .optional(),
  tool_timeout_sec: z.number().positive()
    .describe('Maximum seconds allowed for one tool call.')
    .optional(),
  enabled_tools: z.array(z.string().describe('Tool name explicitly allowed for this server.'))
    .describe('Optional allowlist applied to tools/list.').optional(),
  disabled_tools: z.array(z.string().describe('Tool name explicitly disabled for this server.'))
    .describe('Optional denylist applied after enabled_tools.').optional(),
  supports_parallel_tool_calls: z.boolean()
    .describe('Whether independent calls to this server may execute concurrently.')
    .optional(),
}).superRefine((server, ctx) => {
  if (server.command && server.url) {
    ctx.addIssue({ code: 'custom', path: ['command'], message: 'command and url are mutually exclusive; a server is either stdio or streamable_http.' })
    ctx.addIssue({ code: 'custom', path: ['url'], message: 'command and url are mutually exclusive; a server is either stdio or streamable_http.' })
  }
  if (!server.command && !server.url) {
    ctx.addIssue({ code: 'custom', path: ['command'], message: 'one of command (stdio) or url (streamable_http) is required.' })
  }
  if (!server.command) {
    for (const field of ['args', 'env', 'cwd', 'enable_2026_protocol'] as const) {
      if (server[field] !== undefined) {
        ctx.addIssue({ code: 'custom', path: [field], message: `${field} applies to stdio servers only (requires command).` })
      }
    }
  }
  if (!server.url) {
    for (const field of [
      'http_headers',
      'env_http_headers',
      'bearer_token_env_var',
      'oauth',
      'oauth_resource',
      'scopes',
      'proxyId',
    ] as const) {
      if (server[field] !== undefined) {
        ctx.addIssue({ code: 'custom', path: [field], message: `${field} applies to streamable_http servers only (requires url).` })
      }
    }
  }
})
