import type { CallToolResult } from '@modelcontextprotocol/client';
import { connectHttpMcpClient, type McpClientConnection } from '../mcp/client/connection.js';
import { SearchError, type SearchBackendDependencies } from './contracts.js';
import { normalizeSearchError, searchError } from './errors.js';
import { SEARCH_TIMEOUTS } from './timeouts.js';

interface SearchMcpEndpoint {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly tool: string;
}

async function withSearchClient<T>(
  endpoint: SearchMcpEndpoint,
  dependencies: SearchBackendDependencies,
  signal: AbortSignal,
  action: (connection: McpClientConnection) => Promise<T>,
): Promise<T> {
  let connection: McpClientConnection | undefined;
  let retryAfterMs: number | undefined;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const response = await dependencies.fetch(input, init);
    if (response.status === 429) {
      const header = response.headers.get('retry-after');
      if (header !== null) {
        const seconds = Number(header);
        const duration = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
        if (Number.isFinite(duration) && duration >= 0) retryAfterMs = duration;
      }
    }
    return response;
  };
  try {
    signal.throwIfAborted();
    connection = await connectHttpMcpClient({
      url: endpoint.url, headers: endpoint.headers, fetch,
      signal, timeoutMs: SEARCH_TIMEOUTS.requestMs,
    });
    const result = await action(connection);
    signal.throwIfAborted();
    return result;
  } catch (error) {
    const secrets = [...Object.values(endpoint.headers),
      ...(dependencies.auth.kind === 'api_key' ? [dependencies.auth.key] : []),
      ...(dependencies.auth.kind === 'oauth' ? [dependencies.auth.accessToken] : []),
    ];
    const failure = normalizeSearchError(error, signal, secrets);
    if (failure.failure.code === 'rate_limited' && retryAfterMs !== undefined) {
      throw new SearchError({ ...failure.failure, retryAfterMs,
        message: `${failure.message} ${Math.ceil(retryAfterMs / 1000)} 秒后可重试。` });
    }
    throw failure;
  } finally {
    await connection?.close();
  }
}

export function callSearchMcp(
  endpoint: SearchMcpEndpoint,
  dependencies: SearchBackendDependencies,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<CallToolResult> {
  return withSearchClient(endpoint, dependencies, signal, async ({ client }) => {
    const result = await client.callTool({ name: endpoint.tool, arguments: args }, {
      signal, timeout: SEARCH_TIMEOUTS.requestMs,
    });
    if (result.isError) {
      throw new Error(result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n'));
    }
    return result;
  });
}

export function checkSearchMcp(
  endpoint: SearchMcpEndpoint,
  dependencies: SearchBackendDependencies,
  signal: AbortSignal,
): Promise<void> {
  return withSearchClient(endpoint, dependencies, signal, async ({ client }) => {
    let cursor: string | undefined;
    do {
      const result = await client.listTools(cursor ? { cursor } : undefined, { signal, timeout: SEARCH_TIMEOUTS.requestMs });
      if (result.tools.some((tool) => tool.name === endpoint.tool)) return;
      cursor = result.nextCursor;
    } while (cursor);
    throw searchError('invalid_response');
  });
}
