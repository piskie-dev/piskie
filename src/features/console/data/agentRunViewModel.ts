import type {
  AgentControlSnapshot,
  AgentRunSnapshot,
} from '../../../../shared/electron-contracts/agent-runs';
import { isInterrupted } from '../../../../shared/types/agent-control';
import { resolveActivitySummary } from './useActivitySummary';
import {
  resolveTaskDescription,
  type HistoryRow,
  type SessionRow,
} from './sessionRow';
import { resolveStatus } from './status';
import { messageText, rawText } from './presentationText';

/** Pure Renderer projections. Disk and live snapshots remain the only business sources. */
export function projectActiveAgentRun(
  state: AgentControlSnapshot,
  unnamedTask: string,
): SessionRow {
  const interrupted = isInterrupted(state);
  return {
    agentId: state.agentId,
    title: state.runConfig.name || unnamedTask,
    description: state.runConfig.description || undefined,
    workspace: state.runConfig.workspace || undefined,
    phase: state.phase,
    status: resolveStatus(state),
    createdAt: state.createdAt,
    workerCount: state.children.length,
    model: state.currentModel,
    interrupted,
    activity: resolveActivitySummary({
      phase: state.phase,
      interrupted,
      askUser: state.pendingQuestion ? { items: state.pendingQuestion.questions } : undefined,
      pendingToolName: state.pendingToolCall?.toolName,
      taskBoard: state.taskBoard,
      fallback: state.runConfig.description
        ? rawText(state.runConfig.description)
        : messageText('transcript.activity.idle'),
    }),
  };
}

export function projectPersistedAgentRun(
  snapshot: AgentRunSnapshot,
  active?: AgentControlSnapshot,
): HistoryRow {
  return {
    agentId: snapshot.agentId,
    title: snapshot.runConfig.name || snapshot.agentId,
    description: snapshot.runConfig.description || undefined,
    agentSpec: snapshot.agentSpec,
    taskDescription: resolveTaskDescription(snapshot),
    workspace: snapshot.runConfig.workspace || undefined,
    lastActiveAt: snapshot.lastActiveAt,
    running: active?.agentId === snapshot.agentId,
  };
}
