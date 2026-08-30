import { appLog } from '@electron/observability/logging/app-log.js';
import * as path from 'node:path';
import type { CatalogEntry, CatalogSnapshot } from '../../tools/catalog.js';
import { OutputSpool } from '../../tools/state/output-spool.js';
import { LedgerFileGuard, ReadLedger } from '../../tools/state/read-ledger.js';
import type {
  AssignmentTaskBoardSnapshot,
  AgentInputRequest,
  AgentRunConfig,
  SubagentConfig,
} from '../../../shared/types/index.js';
import type { SkillInventorySnapshot } from '../../../shared/types/skill.js';
import type {
  BackgroundHostFactory,
  DeferredToolsPort,
  EventPort,
  ImageOpsPort,
  ModesPort,
  PlanPort,
  SubagentPort,
  TaskBoardPort,
  TerminalReason,
  ToolContext,
  ToolAgentType,
  ToolResourceIds,
  WorkspaceContext,
} from '../../tools/types.js';
import type { BrowserHostRuntime } from '../../piskiepilot/core/skill/host.js';
import { InvariantViolation } from '../../tools/pipeline/invariant-violation.js';

export type ToolContextFactoryOptions = Readonly<{
  activation: ToolActivationContext;
  signal: () => AbortSignal;
  ledger?: ReadLedger;
  background?: BackgroundHostFactory;
  deferredTools?: (snapshot: CatalogSnapshot) => DeferredToolsPort;
}>;

/** Frozen activation inputs from which per-call ToolContext capabilities are granted. */
export type ToolActivationContext = Readonly<{
  agentType: ToolAgentType;
  agentSpec: string;
  agentId: string;
  mainAgentId: string;
  runConfig: Readonly<AgentRunConfig>;
  subagentConfig?: Readonly<SubagentConfig>;
  resourceIds: ToolResourceIds;
  assignmentSnapshot?: Readonly<AssignmentTaskBoardSnapshot>;
  skillInventory?: Readonly<SkillInventorySnapshot>;
  currentModel(): string;
  workspace: WorkspaceContext;
  modes: ModesPort;
  taskBoard?: TaskBoardPort;
  plan?: PlanPort;
  subagents?: SubagentPort;
  events?: EventPort;
  imageOps?: ImageOpsPort;
  browser?: BrowserHostRuntime;
  post(event: AgentInputRequest): boolean;
}>;

/** Builds a fresh capability-scoped context after the effective entry is known. */
export class ToolCallContextFactory {
  private readonly files: LedgerFileGuard;

  constructor(private readonly options: ToolContextFactoryOptions) {
    this.files = new LedgerFileGuard(options.ledger ?? new ReadLedger());
  }

  create(
    entry: CatalogEntry,
    callId: string,
    declareTerminal: (reason: TerminalReason) => void,
    snapshot?: CatalogSnapshot
  ): ToolContext {
    const activation = this.options.activation;
    const policy = entry.tool.def.policy;
    const domain = entry.identity?.kind === 'skill' ? entry.identity.domain : undefined;
    const needsFiles = Boolean(policy?.mutation || policy?.records);
    const spool = policy?.streamingOutput
      ? new OutputSpool({
          tempDir: activation.workspace.tempDir,
          tempRootDir: path.dirname(activation.workspace.tempDir),
          onWarning: (_message, error) =>
            appLog.warn({
              event: 'tool.output_spool.write.degraded',
              message: 'Tool output spooling degraded',
              context: {
                scope: 'tool.output_spool',
                agentId: activation.agentId,
                callId,
                toolName: entry.modelName,
              },
              error,
            }),
        })
      : undefined;

    if (domain === 'browser' && (!activation.resourceIds.browserId || !activation.browser)) {
      throw new InvariantViolation(`${entry.modelName} requires a complete browser runtime`);
    }
    return Object.freeze({
      agentId: activation.agentId,
      callId,
      workspace: activation.workspace,
      signal: this.options.signal(),
      spool,
      files: needsFiles ? this.files : undefined,
      declareTerminal,
      post: activation.post,
      background: policy?.backgroundable
        ? this.options.background?.forCall(callId, activation.post)
        : undefined,
      agentType: activation.agentType,
      agentSpec: activation.agentSpec,
      mainAgentId: activation.mainAgentId,
      runConfig: activation.runConfig,
      subagentConfig: activation.subagentConfig,
      resourceIds: activation.resourceIds,
      assignmentSnapshot: activation.assignmentSnapshot,
      skillInventory: entry.modelName === 'tool_search' ? activation.skillInventory : undefined,
      deferredTools:
        entry.modelName === 'tool_search' && snapshot
          ? this.options.deferredTools?.(snapshot)
          : undefined,
      currentModel: activation.currentModel(),
      modes: activation.modes,
      taskBoard: ['task', 'task_read'].includes(entry.modelName) ? activation.taskBoard : undefined,
      plan: entry.modelName === 'plan' ? activation.plan : undefined,
      subagents: entry.tool.def.scope === 'main' ? activation.subagents : undefined,
      events: entry.modelName === 'send_event' ? activation.events : undefined,
      imageOps: entry.modelName === 'generate_image' ? activation.imageOps : undefined,
      browser: domain === 'browser' ? activation.browser : undefined,
    });
  }
}
