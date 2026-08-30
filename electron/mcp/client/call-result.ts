import { sanitizeMcpErrorText } from '../security/sanitize.js'

/** A lost transport never replays the in-flight tool call; callers may start a new request. */
export class McpConnectionLostError extends Error {
  readonly code = 'MCP_CONNECTION_LOST'
  readonly retryable = true

  constructor(server: string, tool: string, cause: unknown, safeDetail?: string) {
    const detail = safeDetail ?? sanitizeMcpErrorText(cause)
    super(
      `MCP server "${server}" 在调用工具 "${tool}" 时断开连接：${detail}。`
      + '本次调用未自动重放；可重试，新调用会建立新连接并使用新请求 ID。',
      { cause: new Error(detail) },
    )
    this.name = 'McpConnectionLostError'
  }
}
