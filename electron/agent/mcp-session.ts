import { appLog } from '@electron/observability/logging/app-log.js';
import type { AgentMcpView } from '../../shared/types/mcp.js';
import { buildMcpCatalogEntries } from '../mcp/bridge/catalog.js';
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_MCP_BUDGET_RATIO,
  planMcpBudget,
} from '../mcp/bridge/budget.js';
import { renderMcpPromptBlock, type McpPromptMaterial } from '../mcp/bridge/injection.js';
import type { McpCatalogCandidate } from '../mcp/runtime/server-runtime.js';
import type { McpSessionRuntimeHandle } from '../mcp/runtime/session-runtime.js';
import type { CatalogEntry } from '../tools/catalog.js';
export const MCP_STARTUP_GRACE_MS = 1_000;
const MCP_INSTRUCTIONS_MAX_CHARS = 2 * 1_024;

function truncateInstructions(value: string): string {
  return value.length <= MCP_INSTRUCTIONS_MAX_CHARS
    ? value
    : `${value.slice(0, MCP_INSTRUCTIONS_MAX_CHARS - 1)}…`;
}

export interface AgentMcpProjectionSnapshot {
  readonly revision: number;
  readonly entries: readonly CatalogEntry[];
  readonly promptBlock?: string;
  readonly publishedServers: readonly string[];
  readonly settledServers: readonly string[];
  readonly warnings: readonly string[];
}

function emptyProjection(): AgentMcpProjectionSnapshot {
  return Object.freeze({
    revision: 0,
    entries: Object.freeze([]),
    publishedServers: Object.freeze([]),
    settledServers: Object.freeze([]),
    warnings: Object.freeze([]),
  });
}

/**
 * Per-Agent MCP model projection. Connection state stays in the session handle; this object only
 * owns the append-only prompt/catalog view needed to keep model requests protocol-consistent.
 */
export class AgentMcpSession {
  private boundary = emptyProjection();
  private readonly modelNames = new Set<string>();
  private readonly settledCatalogFingerprints = new Map<string, string>();
  private readonly directPublishedServers = new Set<string>();
  private readonly settledLiveInstructions = new Set<string>();
  private readonly prompt: McpPromptMaterial = { deferredLines: [], serverInstructions: [] };
  private usedTokens = 0;
  private initialGracePending = true;

  constructor(
    readonly runtime: McpSessionRuntimeHandle,
    private readonly contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS,
    private readonly budgetRatio = DEFAULT_MCP_BUDGET_RATIO
  ) {}

  get capability(): McpSessionRuntimeHandle['capability'] {
    return this.runtime.capability;
  }

  startAll(): void {
    this.runtime.startAll();
  }

  snapshot(): AgentMcpProjectionSnapshot {
    return this.boundary;
  }

  view(): AgentMcpView {
    return this.runtime.view({
      revision: this.boundary.revision,
      publishedServers: this.boundary.publishedServers,
      settledServers: this.boundary.settledServers,
    });
  }

  onChange(listener: () => void): () => void {
    return this.runtime.onChange(listener);
  }

  /** First call shares one grace across all pending servers; every call admits only settled data. */
  async advanceBoundary(signal: AbortSignal): Promise<AgentMcpProjectionSnapshot> {
    if (this.initialGracePending) {
      this.initialGracePending = false;
      await this.runtime.waitForInitialGrace(MCP_STARTUP_GRACE_MS, signal);
    }
    signal.throwIfAborted();
    this.admit(this.runtime.catalogs());
    return this.boundary;
  }

  release(): Promise<void> {
    return this.runtime.release();
  }

  private admit(candidates: readonly McpCatalogCandidate[]): void {
    const entries = [...this.boundary.entries];
    const publishedServers = new Set(this.boundary.publishedServers);
    const settledServers = new Set(this.boundary.settledServers);
    const warnings = [...this.boundary.warnings];
    const previousWarningCount = warnings.length;
    let changed = false;
    const publishBoundary = (): void => {
      const revision = changed ? this.boundary.revision + 1 : this.boundary.revision;
      this.boundary = Object.freeze({
        revision,
        entries: Object.freeze(entries),
        promptBlock: renderMcpPromptBlock(this.prompt),
        publishedServers: Object.freeze([...publishedServers]),
        settledServers: Object.freeze([...settledServers]),
        warnings: Object.freeze(warnings),
      });
      const addedWarningCount = warnings.length - previousWarningCount;
      if (addedWarningCount > 0) {
        appLog.warn({
          event: 'agent.mcp_projection.publish.degraded',
          message: 'Agent MCP projection published with warnings',
          context: {
            scope: 'agent.mcp_projection',
            revision,
            warningCount: addedWarningCount,
          },
        });
      }
    };

    // Shared cache intentionally excludes server instructions. Once the same direct server is
    // live, append only its bounded instructions; published schemas remain byte-for-byte stable.
    for (const candidate of candidates) {
      const serverName = candidate.server.name;
      const rawInstructions = candidate.snapshot.instructions;
      if (
        candidate.source !== 'live' ||
        !rawInstructions ||
        !publishedServers.has(serverName) ||
        !this.directPublishedServers.has(serverName) ||
        this.settledLiveInstructions.has(serverName)
      )
        continue;
      this.settledLiveInstructions.add(serverName);
      const instructions = truncateInstructions(rawInstructions);
      const instructionTokens = Math.ceil(instructions.length / 4);
      const budgetTokens = Math.floor(this.contextWindowTokens * this.budgetRatio);
      if (this.usedTokens + instructionTokens > budgetTokens) {
        warnings.push(
          `MCP 预算不足（${budgetTokens} token）：server "${serverName}" 的 live instructions 未注入`
        );
        continue;
      }
      this.usedTokens += instructionTokens;
      this.prompt.serverInstructions.push({ server: serverName, text: instructions });
      changed = true;
    }

    const pending = candidates.filter((candidate) => {
      const serverName = candidate.server.name;
      if (!settledServers.has(serverName)) return true;
      // A stale cached catalog that published nothing may be reconsidered once live discovery
      // proves it changed. Published schemas remain immutable even when their live catalog drifts.
      return (
        candidate.source === 'live' &&
        !publishedServers.has(serverName) &&
        this.settledCatalogFingerprints.get(serverName) !== candidate.catalogFingerprint
      );
    });
    if (pending.length === 0) {
      if (changed || warnings.length > previousWarningCount) publishBoundary();
      return;
    }
    for (const candidate of pending) {
      settledServers.add(candidate.server.name);
      this.settledCatalogFingerprints.set(candidate.server.name, candidate.catalogFingerprint);
    }

    const remainingTokens = Math.max(
      0,
      Math.floor(this.contextWindowTokens * this.budgetRatio) - this.usedTokens
    );
    const plan = planMcpBudget({
      servers: pending.map((candidate) => ({
        server: candidate.server,
        snapshot: candidate.snapshot,
      })),
      contextWindowTokens: remainingTokens,
      budgetRatio: 1,
    });
    warnings.push(...plan.warnings);

    const entriesByServer = new Map<string, CatalogEntry[]>();
    for (const entry of buildMcpCatalogEntries(plan, this.runtime)) {
      if (entry.identity?.kind !== 'mcp') continue;
      const serverEntries = entriesByServer.get(entry.identity.server) ?? [];
      serverEntries.push(entry);
      entriesByServer.set(entry.identity.server, serverEntries);
    }

    // Reserve names across the whole boundary so same-batch collisions cannot both be published.
    const occupiedModelNames = new Set(this.modelNames);
    for (const serverPlan of plan.servers) {
      if (serverPlan.exposure === 'hidden') continue;
      const serverName = serverPlan.server.name;
      const nextEntries: CatalogEntry[] = [];
      for (const entry of entriesByServer.get(serverName) ?? []) {
        if (occupiedModelNames.has(entry.modelName)) {
          warnings.push(
            `MCP server "${serverName}" 工具 "${entry.identity?.kind === 'mcp' ? entry.identity.tool : entry.modelName}"` +
              ` 可见名与已发布工具冲突，本运行时已跳过`
          );
          continue;
        }
        occupiedModelNames.add(entry.modelName);
        nextEntries.push(entry);
      }
      if (nextEntries.length === 0) continue;

      const toolsByModelName = new Map(
        serverPlan.tools.map((tool) => [tool.visibleName, tool] as const)
      );
      const admittedTools = nextEntries
        .map((entry) => toolsByModelName.get(entry.modelName))
        .filter((tool): tool is NonNullable<typeof tool> => tool !== undefined);
      for (const entry of nextEntries) {
        this.modelNames.add(entry.modelName);
        entries.push(entry);
      }
      publishedServers.add(serverName);
      if (serverPlan.exposure === 'deferred') {
        this.prompt.deferredLines.push(...admittedTools.map((tool) => tool.nameLine));
        this.usedTokens += admittedTools.reduce((sum, tool) => sum + tool.nameLineTokens, 0);
      } else {
        this.directPublishedServers.add(serverName);
        this.usedTokens += admittedTools.reduce((sum, tool) => sum + tool.directTokens, 0);
        if (serverPlan.instructions) {
          if (
            pending.find((candidate) => candidate.server.name === serverName)?.source === 'live'
          ) {
            this.settledLiveInstructions.add(serverName);
          }
          this.usedTokens += Math.ceil(serverPlan.instructions.length / 4);
          this.prompt.serverInstructions.push({
            server: serverName,
            text: serverPlan.instructions,
          });
        }
      }
      changed = true;
    }

    publishBoundary();
  }
}
