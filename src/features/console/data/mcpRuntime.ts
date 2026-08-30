import type {
  AgentMcpServerView,
  AgentMcpView,
  McpRuntimeState,
  McpSessionRuntimeSummary,
} from '../../../../shared/types/mcp';

export interface McpPrewarmRequest {
  workspace?: string;
  runSelection?: readonly string[];
  specName: string;
}

export interface McpPrewarmLease {
  token: string;
  view: AgentMcpView;
}

export function hasMcpPrewarmApi(): boolean {
  return true;
}

export async function prewarmMcp(request: McpPrewarmRequest): Promise<McpPrewarmLease | null> {
  return window.piskie.capabilities.mcp.prewarm({
    ...request,
    runSelection: request.runSelection ? [...request.runSelection] : undefined,
  });
}

export async function readMcpPrewarm(token: string): Promise<AgentMcpView | null> {
  return window.piskie.capabilities.mcp.prewarmStatus(token);
}

export async function releaseMcpPrewarm(token: string): Promise<void> {
  await window.piskie.capabilities.mcp.releasePrewarm(token);
}

export function canRetryMcpRuntime(): boolean {
  return true;
}

export async function retryMcpRuntime(
  sessionRuntimeId: string,
  serverNames?: readonly string[],
): Promise<void> {
  await window.piskie.capabilities.mcp.retry({
    sessionRuntimeId,
    serverNames: serverNames ? [...serverNames] : undefined,
  });
}

export async function queryActiveMcpSessions(request?: {
  workspace?: string;
  serverName?: string;
}): Promise<McpSessionRuntimeSummary[] | null> {
  return window.piskie.capabilities.mcp.sessions(request);
}

export interface McpRuntimeStateLabels extends Record<McpRuntimeState, string> {
  cachedStarting: string;
  cachedDormant: string;
}

export function mcpServerStateLabel(
  server: AgentMcpServerView,
  labels: McpRuntimeStateLabels,
): string {
  if (server.state === 'starting' && server.catalogSource === 'cache') return labels.cachedStarting;
  if (server.state === 'dormant' && server.catalogSource === 'cache') return labels.cachedDormant;
  return labels[server.state];
}

export function failedMcpServerNames(view: AgentMcpView): string[] {
  return view.servers
    .filter((server) => server.state === 'failed' && server.retryable !== false)
    .map((server) => server.name);
}

export function mcpConfigPath(serverName?: string, workspace?: string): string {
  const query = new URLSearchParams({ view: 'installed', kind: 'mcp' });
  if (serverName) query.set('query', serverName);
  if (workspace) query.set('workspace', workspace);
  return `/market?${query.toString()}`;
}
