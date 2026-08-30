import path from 'node:path';
import type { ChangeSink, ChangeSource } from '../../core/change-channel.js';
import { getAppSkillsPort } from '../../core/pilot/pilot-manager.js';
import type { DesktopPresentationPort } from '../../desktop/desktop-presentation-port.js';
import { createMarketPort, type MarketPort } from '../../market/ports.js';
import { intersectMcpSelections } from '../../mcp/bridge/injection.js';
import { normalizeWorkspace } from '../../mcp/config/trust.js';
import { createMcpPort, type McpPort } from '../../mcp/ports.js';
import {
  projectContextId,
  type McpConnectionManager,
} from '../../mcp/runtime/index.js';
import { createPluginsPort, type PluginsPort } from '../../plugins/ports.js';
import { createProjectInventory } from '../../projects/inventory.js';
import type { AgentService } from '../../services/agent.service.js';
import { specRegistry } from '../../agent/specs/index.js';
import type {
  MarketChangeEvent,
  MarketInstalledQuery,
  MarketInstallRequest,
  MarketListQuery,
  MarketManageRequest,
} from '../../../shared/types/market.js';
import type { McpServerConfig } from '../../../shared/types/mcp.js';
import { resolvePublishedProxyFetch } from '../../core/proxy/proxy-fetch.js';
import { PublicOperationError } from '../public-errors.js';

export class CapabilityMarketApplication {
  readonly changes: ChangeSource<MarketChangeEvent>;
  private readonly mcp: McpPort;
  private readonly plugins: PluginsPort;
  private readonly market: MarketPort;

  constructor(private readonly dependencies: {
    userDataDirectory: string;
    agent: AgentService;
    manager: McpConnectionManager;
    presentation: DesktopPresentationPort;
    changes: { source: ChangeSource<MarketChangeEvent>; sink: ChangeSink<MarketChangeEvent> };
  }) {
    this.changes = dependencies.changes.source;
    const defaultWorkspaceDir = path.join(dependencies.userDataDirectory, 'workspace');
    const openAuthorizationUrl = (url: string, onClosed?: () => void) => (
      dependencies.presentation.openAuthorization(url, onClosed)
    );
    this.mcp = createMcpPort({
      configRoot: dependencies.userDataDirectory,
      defaultWorkspaceDir,
      readCachedCatalog: (server) => dependencies.manager.cachedCatalog(server),
      onCatalogDiscovered: (server, snapshot) => {
        dependencies.manager.rememberCatalog(server, snapshot);
      },
      onChanged: (event) => {
        dependencies.manager.invalidateCatalogCache();
        dependencies.changes.sink.publish({ kind: 'mcp', ...event });
      },
      openAuthorizationUrl,
      resolveFetch: resolvePublishedProxyFetch,
    });
    this.plugins = createPluginsPort({
      configRoot: dependencies.userDataDirectory,
      defaultWorkspaceDir,
      installedBy: 'piskie-app',
      trustProjectServer: (name, workspace, config) => (
        this.mcp.trustConfiguration(name, workspace, config).then(() => undefined)
      ),
      onboardMcpServer: (name, workspace, options) => this.mcp.onboard(name, {
        workspace,
        login: options?.login === true,
        openAuthorizationUrl,
      }),
      onChanged: () => {
        dependencies.manager.invalidateCatalogCache();
        dependencies.changes.sink.publish({ kind: 'plugin', type: 'changed' });
      },
    });
    const inventory = createProjectInventory({
      defaultWorkspaceDir,
      scanHeaders: () => dependencies.agent.getConversationStore().scanHeaders(),
      getActiveStates: () => Object.values(dependencies.agent.getLoadedControlStates()),
    });
    this.market = createMarketPort({
      configRoot: dependencies.userDataDirectory,
      skills: getAppSkillsPort(),
      mcp: this.mcp,
      plugins: this.plugins,
      listProjects: () => inventory.list(),
    });
  }

  listMcp(input?: { scope?: 'user' | 'project' | 'all'; workspace?: string }) {
    return this.withMcpErrors(() => this.mcp.list(input));
  }

  getMcp(name: string, input?: { workspace?: string }) {
    return this.withMcpErrors(() => this.mcp.get(name, input));
  }

  searchMcp(query: string) {
    return this.withMcpErrors(() => this.mcp.search(query));
  }

  addMcp(input: {
    name: string;
    scope: 'user' | 'project';
    workspace?: string;
    config: McpServerConfig;
    force?: boolean;
  }) {
    return this.withMcpErrors(async () => {
      const added = await this.mcp.add(input);
      const onboarding = await this.mcp.onboard(input.name, {
        workspace: input.workspace,
        login: true,
        openAuthorizationUrl: (url, onClosed) => (
          this.dependencies.presentation.openAuthorization(url, onClosed)
        ),
      });
      return { ...added, onboarding };
    });
  }

  removeMcp(name: string, input: { scope: 'user' | 'project'; workspace?: string }) {
    return this.withMcpErrors(async () => {
      await this.mcp.remove(name, input);
    });
  }

  probeMcp(name: string, input?: { workspace?: string }) {
    return this.withMcpErrors(() => this.mcp.probe(name, input));
  }

  mcpBudget(input?: { workspace?: string; contextWindowTokens?: number }) {
    return this.withMcpErrors(() => this.mcp.budgetPreview(input));
  }

  trustMcp(name: string, workspace: string) {
    return this.withMcpErrors(() => this.mcp.trust(name, workspace));
  }

  loginMcp(name: string, input?: { workspace?: string; scopes?: string[] }) {
    return this.withMcpErrors(() => this.mcp.login(name, {
      ...input,
      openAuthorizationUrl: (url, onClosed) => (
        this.dependencies.presentation.openAuthorization(url, onClosed)
      ),
    }));
  }

  logoutMcp(name: string, input?: { workspace?: string }) {
    return this.withMcpErrors(() => this.mcp.logout(name, input));
  }

  authMcp(name: string, input?: { workspace?: string }) {
    return this.withMcpErrors(() => this.mcp.authStatus(name, input));
  }

  prewarmMcp(input: { workspace?: string; runSelection?: string[]; specName: string }) {
    return this.withMcpErrors(async () => {
      const spec = specRegistry.get(input.specName);
      if (!spec) throw new Error('Agent specification was not found');
      const lease = await this.dependencies.manager.prewarm({
        workspace: input.workspace,
        selection: intersectMcpSelections(input.runSelection, spec.mcpServers),
        ownerLabel: spec.name,
      });
      return { token: lease.token, view: lease.view };
    });
  }

  prewarmStatus(token: string) {
    return this.dependencies.manager.statusByPrewarmToken(token) ?? null;
  }

  releasePrewarm(token: string): Promise<void> {
    return this.withMcpErrors(() => this.dependencies.manager.releasePrewarm(token));
  }

  retryMcp(input: { sessionRuntimeId: string; serverNames?: string[] }, signal: AbortSignal) {
    return this.withMcpErrors(async () => {
      await this.dependencies.manager.retry(input.sessionRuntimeId, input.serverNames, signal);
      const view = this.dependencies.manager.status(input.sessionRuntimeId);
      if (!view) throw new Error('MCP session is no longer active');
      return view;
    });
  }

  activeMcpSessions(input?: { workspace?: string; serverName?: string }) {
    return this.withMcpErrors(async () => {
      const workspace = input?.workspace
        ? await normalizeWorkspace(input.workspace)
        : undefined;
      const defaultWorkspace = await normalizeWorkspace(
        path.join(this.dependencies.userDataDirectory, 'workspace'),
      );
      const contextId = workspace && workspace !== defaultWorkspace
        ? projectContextId(workspace)
        : projectContextId();
      return this.dependencies.manager.sessions({
        projectContextId: contextId,
        serverName: input?.serverName,
      }).filter((session) => session.ownerKind !== 'composer');
    });
  }

  listMarket(query?: MarketListQuery) {
    return this.market.list(query);
  }

  installedMarket(query?: MarketInstalledQuery) {
    return this.market.installed(query);
  }

  async refreshMarket(sourceIds?: string[]) {
    const result = await this.market.refresh(sourceIds, (sync) => {
      this.dependencies.changes.sink.publish({ kind: 'catalog', type: 'sync-progress', sync });
    });
    this.dependencies.changes.sink.publish({ kind: 'catalog', type: 'refreshed' });
    return result;
  }

  marketDetail(entryId: string) {
    return this.market.detail(entryId);
  }

  installMarket(input: MarketInstallRequest) {
    return this.withMcpErrors(() => this.market.install(input));
  }

  manageMarket(input: MarketManageRequest) {
    return this.withMcpErrors(() => this.market.manage(input));
  }

  marketSources() {
    return this.market.sources();
  }

  async addMarketSource(input: Parameters<MarketPort['addSource']>[0]) {
    const source = await this.market.addSource(input);
    this.dependencies.changes.sink.publish({
      kind: 'catalog',
      type: 'source-added',
      name: source.name,
    });
    return source;
  }

  async removeMarketSource(sourceId: string): Promise<void> {
    await this.market.removeSource(sourceId);
    this.dependencies.changes.sink.publish({
      kind: 'catalog',
      type: 'source-removed',
      name: sourceId,
    });
  }

  marketProjects() {
    return this.market.projects();
  }

  previewMarket(workspace?: string) {
    return this.market.preview(workspace);
  }

  private async withMcpErrors<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw new PublicOperationError(
        'conflict',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
