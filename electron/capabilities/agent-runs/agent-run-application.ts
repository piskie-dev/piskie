import type { AgentService } from '../../services/agent.service.js';
import type { CompactionArchive } from '../../agent-runs/compaction-archive.js';
import type { PlanRepository } from '../../agent-runs/plan-repository.js';
import type { IMGateway } from '../../im-gateway/index.js';
import type { ConversationEntry } from '../../../shared/types/index.js';
import type { ContextSummary } from '../../../shared/types/context.js';
import type {
  AgentControlSnapshot,
  AgentRunSnapshot,
} from '../../../shared/electron-contracts/agent-runs.js';
import { PublicOperationError } from '../public-errors.js';
import { agentControlSnapshot, agentRunSnapshot } from './public-agent-run-view.js';

export class AgentRunApplication {
  constructor(
    private readonly dependencies: {
      agent: AgentService;
      plans: PlanRepository;
      compactions: CompactionArchive;
      messaging: Pick<IMGateway, 'removeAgentBindings'>;
    },
  ) {}

  list(): AgentRunSnapshot[] {
    return this.dependencies.agent
      .getConversationStore()
      .scanHeaders()
      .sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt))
      .map(agentRunSnapshot);
  }

  state(agentId: string): AgentControlSnapshot | null {
    const state = this.dependencies.agent.getControlState(agentId)
      ?? this.dependencies.agent.buildHistoryPreview(agentId);
    return state ? agentControlSnapshot(state) : null;
  }

  async delete(agentId: string): Promise<void> {
    await this.dependencies.agent.deleteAgentRun(agentId);
    await this.dependencies.messaging.removeAgentBindings(agentId);
  }

  async readPlan(agentId: string) {
    this.requireAgentRun(agentId);
    const document = await this.dependencies.plans.readCurrentPlanDocument(agentId);
    if (!document) throw new PublicOperationError('not-found', 'No current plan exists');
    return { ...document.meta, content: document.content };
  }

  async listCompactions(agentId: string) {
    const entries = this.readConversation(agentId);
    const summaries = entries.flatMap((entry) => (entry.t === 'summary' ? [entry.summary] : []));
    return this.dependencies.compactions.buildHistoryView(agentId, summaries);
  }

  async originalMessages(input: {
    agentId: string;
    summaryId: string;
    offset?: number;
    limit?: number;
  }) {
    const entries = this.readConversation(input.agentId);
    const summary = findSummary(entries, input.summaryId);
    if (!summary) {
      throw new PublicOperationError('not-found', 'Summary does not belong to this AgentRun');
    }
    return this.dependencies.compactions.readOriginalMessagePage(
      input.agentId,
      summary,
      input.offset,
      input.limit,
    );
  }

  private requireAgentRun(agentId: string): void {
    if (!this.dependencies.agent.getConversationStore().readHeader(agentId)) {
      throw new PublicOperationError('not-found', 'AgentRun was not found');
    }
  }

  private readConversation(agentId: string): ConversationEntry[] {
    this.requireAgentRun(agentId);
    return this.dependencies.agent.getConversationStore().read(agentId, agentId);
  }
}

function findSummary(
  entries: readonly ConversationEntry[],
  summaryId: string,
): ContextSummary | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.t === 'summary' && entry.summary.id === summaryId) return entry.summary;
  }
  return undefined;
}
