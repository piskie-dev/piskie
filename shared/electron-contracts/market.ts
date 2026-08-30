import type {
  AgentMcpView,
  McpAddWithOnboardingResult,
  McpAuthStatus,
  McpBudgetPreview,
  McpRegistrySearchResult,
  McpServerConfig,
  McpServerInfo,
  McpServerSnapshot,
  McpSessionRuntimeSummary,
} from '../types/mcp.js';
import type {
  EffectiveCapabilityPreview,
  MarketCatalogPage,
  MarketChangeEvent,
  MarketEntry,
  MarketInstalledPage,
  MarketInstalledQuery,
  MarketInstallRequest,
  MarketInstallResult,
  MarketListQuery,
  MarketManageRequest,
  MarketManageResult,
  MarketProjectOption,
  MarketSource,
} from '../types/market.js';

export const CAPABILITY_OPERATIONS = Object.freeze({
  listMcp: 'capabilities.mcp.list',
  getMcp: 'capabilities.mcp.get',
  searchMcp: 'capabilities.mcp.search',
  addMcp: 'capabilities.mcp.add',
  removeMcp: 'capabilities.mcp.remove',
  probeMcp: 'capabilities.mcp.probe',
  mcpBudget: 'capabilities.mcp.budget',
  trustMcp: 'capabilities.mcp.trust',
  loginMcp: 'capabilities.mcp.login',
  logoutMcp: 'capabilities.mcp.logout',
  mcpAuth: 'capabilities.mcp.auth',
  prewarmMcp: 'capabilities.mcp.prewarm',
  mcpPrewarmStatus: 'capabilities.mcp.prewarmStatus',
  releaseMcpPrewarm: 'capabilities.mcp.releasePrewarm',
  retryMcp: 'capabilities.mcp.retry',
  mcpSessions: 'capabilities.mcp.sessions',
  listMarket: 'capabilities.market.list',
  installedMarket: 'capabilities.market.installed',
  refreshMarket: 'capabilities.market.refresh',
  marketDetail: 'capabilities.market.detail',
  installMarket: 'capabilities.market.install',
  manageMarket: 'capabilities.market.manage',
  marketSources: 'capabilities.market.sources',
  addMarketSource: 'capabilities.market.addSource',
  removeMarketSource: 'capabilities.market.removeSource',
  marketProjects: 'capabilities.market.projects',
  previewMarket: 'capabilities.market.preview',
} as const);

export const CAPABILITY_TOPICS = Object.freeze({
  marketChanges: 'capabilities.market.changes',
} as const);

interface McpClient {
  list(input?: { scope?: 'user' | 'project' | 'all'; workspace?: string }): Promise<McpServerInfo[]>;
  get(name: string, input?: { workspace?: string }): Promise<McpServerInfo>;
  search(query: string): Promise<McpRegistrySearchResult[]>;
  add(input: {
    name: string;
    scope: 'user' | 'project';
    workspace?: string;
    config: McpServerConfig;
    force?: boolean;
  }): Promise<McpAddWithOnboardingResult>;
  remove(name: string, input: { scope: 'user' | 'project'; workspace?: string }): Promise<void>;
  probe(name: string, input?: { workspace?: string }): Promise<McpServerSnapshot>;
  budget(input?: { workspace?: string; contextWindowTokens?: number }): Promise<McpBudgetPreview>;
  trust(name: string, workspace: string): Promise<{ name: string; workspace: string }>;
  login(name: string, input?: { workspace?: string; scopes?: string[] }): Promise<{
    issuer: string;
    scope?: string;
    expiresAt?: number;
  }>;
  logout(name: string, input?: { workspace?: string }): Promise<{ removed: boolean }>;
  auth(name: string, input?: { workspace?: string }): Promise<McpAuthStatus>;
  prewarm(input: {
    workspace?: string;
    runSelection?: string[];
    specName: string;
  }): Promise<{ token: string; view: AgentMcpView }>;
  prewarmStatus(token: string): Promise<AgentMcpView | null>;
  releasePrewarm(token: string): Promise<void>;
  retry(input: { sessionRuntimeId: string; serverNames?: string[] }): Promise<AgentMcpView>;
  sessions(input?: {
    workspace?: string;
    serverName?: string;
  }): Promise<McpSessionRuntimeSummary[]>;
}

interface MarketClient {
  list(query?: MarketListQuery): Promise<MarketCatalogPage>;
  installed(query?: MarketInstalledQuery): Promise<MarketInstalledPage>;
  refresh(sourceIds?: string[]): Promise<{ sources: MarketSource[]; warnings: string[] }>;
  detail(entryId: string): Promise<MarketEntry>;
  install(input: MarketInstallRequest): Promise<MarketInstallResult>;
  manage(input: MarketManageRequest): Promise<MarketManageResult>;
  sources(): Promise<MarketSource[]>;
  addSource(input: {
    name: string;
    kind: MarketSource['kind'];
    url: string;
    ref?: string;
  }): Promise<MarketSource>;
  removeSource(sourceId: string): Promise<void>;
  projects(): Promise<MarketProjectOption[]>;
  preview(workspace?: string): Promise<EffectiveCapabilityPreview>;
  observeChanges(listener: (event: MarketChangeEvent) => void): () => void;
}

export interface CapabilityMarketClient {
  readonly mcp: McpClient;
  readonly market: MarketClient;
}
