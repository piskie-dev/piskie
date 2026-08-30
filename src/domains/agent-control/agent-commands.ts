import { canPause } from '@shared/types/agent-control';
import type {
  AgentInputEvent,
  AgentModeId,
  ApprovalMode,
  ToolApprovalDecision,
} from '@shared/types';
import type { ReasoningSelection } from '@shared/types/reasoning';
import type {
  AgentClient,
  StartAgentRequest,
} from '@shared/electron-contracts/agents';
import type { AgentRunRepository } from '../agent-runs/agent-run-repository';
import type { AgentControlStore } from './agent-control-store';

export type AgentCommandResult<T = void> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export interface AgentCommands {
  start(request: StartAgentRequest): Promise<AgentCommandResult<string>>;
  interruptAll(): Promise<boolean>;
  interrupt(agentId: string): Promise<AgentCommandResult>;
  interruptSubagent(agentId: string, subagentId: string): Promise<AgentCommandResult>;
  stop(agentId: string): Promise<AgentCommandResult>;
  inject(agentId: string, event: AgentInputEvent): Promise<AgentCommandResult>;
  injectSubagent(
    agentId: string,
    subagentId: string,
    event: AgentInputEvent,
  ): Promise<AgentCommandResult>;
  setModel(agentId: string, model: string): Promise<AgentCommandResult>;
  setSubagentModel(
    agentId: string,
    subagentId: string,
    model: string,
  ): Promise<AgentCommandResult>;
  setReasoning(
    agentId: string,
    selection?: ReasoningSelection,
  ): Promise<AgentCommandResult>;
  setSubagentReasoning(
    agentId: string,
    subagentId: string,
    selection?: ReasoningSelection,
  ): Promise<AgentCommandResult>;
  setApprovalMode(agentId: string, mode: ApprovalMode): Promise<AgentCommandResult>;
  setSubagentApprovalMode(
    agentId: string,
    subagentId: string,
    mode: ApprovalMode,
  ): Promise<AgentCommandResult>;
  respondToApproval(
    agentId: string,
    subagentId: string | undefined,
    decision: ToolApprovalDecision,
  ): Promise<AgentCommandResult>;
  setMode(agentId: string, mode: AgentModeId): Promise<AgentCommandResult>;
  promoteToBackground(callId: string): Promise<AgentCommandResult<boolean>>;
}

export function createAgentCommands(
  agents: AgentClient,
  control: AgentControlStore,
  runs: AgentRunRepository,
): AgentCommands {
  return {
    start(request) {
      return execute(async () => {
        const snapshot = await agents.start(request);
        control.apply({ agentId: snapshot.agentId, state: snapshot });
        runs.clearPreview(snapshot.agentId);
        void runs.refresh();
        return snapshot.agentId;
      });
    },
    async interruptAll() {
      const active = Object.values(control.state.getState().agentsById).filter(canPause);
      const results = await Promise.allSettled(
        active.map((agent) => agents.interrupt(agent.agentId)),
      );
      return results.every((result) => result.status === 'fulfilled');
    },
    interrupt(agentId) {
      return executeVoid(() => agents.interrupt(agentId));
    },
    interruptSubagent(agentId, subagentId) {
      return executeVoid(() => agents.interruptSubagent(agentId, subagentId));
    },
    async stop(agentId) {
      const result = await executeVoid(() => agents.stop(agentId));
      if (result.ok) void runs.refresh();
      return result;
    },
    inject(agentId, event) {
      return executeVoid(() => agents.inject(agentId, event));
    },
    injectSubagent(agentId, subagentId, event) {
      return executeVoid(() => agents.injectSubagent(agentId, subagentId, event));
    },
    setModel(agentId, model) {
      return executeVoid(() => agents.setModel(agentId, model));
    },
    setSubagentModel(agentId, subagentId, model) {
      return executeVoid(() => agents.setSubagentModel(agentId, subagentId, model));
    },
    setReasoning(agentId, selection) {
      return executeVoid(() => agents.setReasoning(agentId, selection ?? null));
    },
    setSubagentReasoning(agentId, subagentId, selection) {
      return executeVoid(() => agents.setSubagentReasoning(agentId, subagentId, selection ?? null));
    },
    setApprovalMode(agentId, mode) {
      return executeVoid(() => agents.approval.setMode(agentId, mode));
    },
    setSubagentApprovalMode(agentId, subagentId, mode) {
      return executeVoid(() => agents.approval.setSubagentMode(agentId, subagentId, mode));
    },
    respondToApproval(agentId, subagentId, decision) {
      return executeVoid(() => agents.approval.respond(agentId, subagentId, decision));
    },
    setMode(agentId, mode) {
      return executeVoid(() => agents.setMode(agentId, mode));
    },
    promoteToBackground(callId) {
      return execute(() => agents.tools.promoteToBackground(callId));
    },
  };
}

async function execute<T>(operation: () => Promise<T>): Promise<AgentCommandResult<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function executeVoid(operation: () => Promise<void>): Promise<AgentCommandResult> {
  return execute(operation);
}
