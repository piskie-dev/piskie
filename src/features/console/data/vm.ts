/**
 * ViewModel 层——**唯一的 store 接触面**。
 *
 * 面板组件只消费这里的 VM，不直接订阅领域 Store。两条纪律：
 * 1. **窄订阅**：只订阅自己那一小片（`controlStates[agentId]` 或其 children 里的一个），
 *    别的 agent 变化不会唤醒本面板。
 * 2. **稳定引用**：VM 由 `useMemo` 从选中的 store 切片派生，切片未变即返回同一对象——
 *    这样下游 `memo` 才真的生效。
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  AgentControlState,
  AgentPhase,
  AgentRunMetrics,
  ChildControlState,
  PendingAgentEventView,
} from '../../../../shared/types/agent-control';
import { canPause, canStop, isInterrupted } from '../../../../shared/types/agent-control';
import type {
  AgentIncident,
  AIQuestionItem,
  AIRequestState,
  ApprovalMode,
  PendingToolCall,
  AgentModeId,
  SubagentMode,
  TaskItem,
} from '../../../../shared/types';
import type { ContextUsage } from '../../../../shared/types/token';
import type { AgentMcpView } from '../../../../shared/types/mcp';
import { useDisplayAgentState } from '../../../renderer-runtime/hooks';
import { useIncidentStore } from '../../../store/incidentStore';
import { selectLatestTargetIncident } from '../../incidents';
import { resolveStatus, type StatusKey } from './status';

export type { StatusKey } from './status';

// ==================== 状态语义 ====================

/** AI 请求瞬时态（权威真相源；不从 AgentIncident 推断） */
export interface RequestVM {
  readonly retrying: boolean;
  readonly failed: boolean;
  readonly backoff: boolean;
  readonly activity?: 'compacting' | 'resending';
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly retryAt?: number;
  readonly attemptStartedAt?: number;
  readonly errorMessage?: string;
  readonly errorCode?: string;
}

export function resolveRequest(state?: AIRequestState): RequestVM | undefined {
  if (!state) return undefined;
  const backoff = state.phase === 'backoff';
  const retryRequesting = state.phase === 'requesting' && (state.attempt ?? 0) > 0;
  const failed = state.phase === 'finished' && state.outcome === 'failed';
  const activity = state.phase === 'compacting' || state.phase === 'resending'
    ? state.phase
    : undefined;
  if (!backoff && !retryRequesting && !failed && !activity) return undefined;

  return {
    retrying: backoff || retryRequesting,
    failed,
    backoff,
    ...(activity && { activity }),
    attempt: state.attempt,
    maxAttempts: state.maxAttempts,
    retryAt: backoff ? state.retryAt : undefined,
    attemptStartedAt: retryRequesting ? state.attemptStartedAt : undefined,
    errorMessage: state.errorMessage,
    errorCode: state.errorCode,
  };
}

export function resolveConversationRequest(
  state?: AIRequestState,
  incident?: AgentIncident,
): RequestVM | undefined {
  return resolveRequest(state) ?? (incident
    ? {
        retrying: false,
        failed: true,
        backoff: false,
        attempt: 0,
        maxAttempts: 0,
        errorMessage: incident.message,
        errorCode: incident.details?.code,
      }
    : undefined);
}

// ==================== 主 Agent ====================

export interface AgentVM {
  readonly agentId: string;
  readonly title: string;
  readonly description?: string;
  readonly phase: AgentPhase;
  readonly status: StatusKey;
  readonly interrupted: boolean;
  readonly canPause: boolean;
  readonly canStop: boolean;
  readonly model: string;
  readonly approvalMode: ApprovalMode;
  readonly modeId: AgentModeId;
  readonly agentSpec?: string;
  readonly workspace?: string;
  readonly createdAt: string;
  readonly conversationLength: number;
  readonly contextUsage?: ContextUsage;
  readonly activeStartedAt?: number;
  readonly activeLlmStartedAt?: number;
  readonly activeToolPhaseStartedAt?: number;
  readonly runMetrics: AgentRunMetrics;
  readonly request?: RequestVM;
  readonly pendingToolCall?: PendingToolCall;
  readonly pendingEvents: readonly PendingAgentEventView[];
  /**
   * 待作答的 ask_user 快照（从尾部未配对 tool_use 纯派生）。
   * 只有主 Agent 有——`WorkerVM` 结构上不带这个字段，提问门因此进不了 worker 面板。
   */
  readonly askUser?: AskUserVM;
  readonly taskBoard?: { readonly taskSummary: string; readonly items: readonly TaskItem[] };
  readonly workers: readonly WorkerRef[];
  readonly imageNodeIds: readonly string[];
  readonly mcp?: AgentMcpView;
}

export interface AskUserVM {
  /** = 发起提问的 ask_user tool_use ID（问题身份唯一来源） */
  readonly id: string;
  readonly items: readonly AIQuestionItem[];
}

/**
 * worker 摘要（两种模式的 AgentTabs 消费）。
 *
 * 只投影 worker 导航实际消费的信息。
 */
export interface WorkerRef {
  readonly id: string;
  readonly subject: string;
  readonly mode: SubagentMode;
  readonly status: StatusKey;
}

function projectAgent(
  state: AgentControlState,
  unnamedTask: string,
  incident?: AgentIncident,
): AgentVM {
  return {
    agentId: state.agentId,
    title: state.runConfig.name || unnamedTask,
    description: state.runConfig.description || undefined,
    phase: state.phase,
    status: resolveStatus(state),
    interrupted: isInterrupted(state),
    canPause: canPause(state),
    canStop: canStop(state),
    model: state.currentModel,
    approvalMode: state.approvalMode,
    modeId: state.modeId,
    agentSpec: state.agentSpec,
    workspace: state.runConfig.workspace,
    createdAt: state.createdAt,
    conversationLength: state.conversationLength,
    contextUsage: state.contextUsage,
    activeStartedAt: state.activeStartedAt,
    activeLlmStartedAt: state.activeLlmStartedAt,
    activeToolPhaseStartedAt: state.activeToolPhaseStartedAt,
    runMetrics: state.runMetrics,
    request: resolveConversationRequest(state.aiRequestState, incident),
    pendingToolCall: state.pendingToolCall,
    pendingEvents: state.pendingEvents,
    askUser: state.pendingQuestion
      ? { id: state.pendingQuestion.id, items: state.pendingQuestion.questions }
      : undefined,
    taskBoard: state.taskBoard,
    mcp: state.mcp,
    workers: state.children.map((child) => ({
      id: child.id,
      subject: child.subject,
      mode: child.mode,
      status: resolveStatus(child),
    })),
    imageNodeIds: (state.imageNodes ?? []).map((node) => node.id),
  };
}

/**
 * 显示态：在跑的实时态优先，否则点开的磁盘历史预览态
 * （`useDisplayAgentState` 是唯一查询入口）。
 */
export function useAgentVM(agentId: string | null | undefined): AgentVM | null {
  const { t } = useTranslation();
  const state = useDisplayAgentState(agentId);
  const incident = useTargetIncident(agentId, undefined);
  return useMemo(
    () => (state ? projectAgent(state, t('sessionWorkbenchUi.shell.unnamedTask'), incident) : null),
    [incident, state, t],
  );
}

// ==================== Worker ====================

export interface WorkerVM {
  readonly id: string;
  readonly mainAgentId: string;
  readonly subject: string;
  readonly mode: SubagentMode;
  readonly phase: AgentPhase;
  readonly status: StatusKey;
  readonly interrupted: boolean;
  readonly canPause: boolean;
  readonly model: string;
  readonly approvalMode: ApprovalMode;
  readonly conversationLength: number;
  readonly contextUsage?: ContextUsage;
  readonly activeStartedAt?: number;
  readonly activeLlmStartedAt?: number;
  readonly activeToolPhaseStartedAt?: number;
  readonly runMetrics: AgentRunMetrics;
  readonly request?: RequestVM;
  readonly pendingToolCall?: PendingToolCall;
  readonly pendingEvents: readonly PendingAgentEventView[];
  readonly taskIds: readonly string[];
  /** 能力位：决定辅助面板出哪些槽（屏幕） */
  readonly browserId?: string;
  readonly browserReady: boolean;
  readonly imageNodeIds: readonly string[];
  readonly mcp?: AgentMcpView;
}

function projectWorker(
  mainAgentId: string,
  child: ChildControlState,
  incident?: AgentIncident,
): WorkerVM {
  return {
    id: child.id,
    mainAgentId,
    subject: child.subject,
    mode: child.mode,
    phase: child.phase,
    status: resolveStatus(child),
    interrupted: isInterrupted(child),
    canPause: canPause(child),
    model: child.currentModel,
    approvalMode: child.approvalMode,
    conversationLength: child.conversationLength,
    contextUsage: child.contextUsage,
    activeStartedAt: child.activeStartedAt,
    activeLlmStartedAt: child.activeLlmStartedAt,
    activeToolPhaseStartedAt: child.activeToolPhaseStartedAt,
    runMetrics: child.runMetrics,
    request: resolveConversationRequest(child.aiRequestState, incident),
    pendingToolCall: child.pendingToolCall,
    pendingEvents: child.pendingEvents,
    taskIds: child.taskIds,
    browserId: child.browserId,
    browserReady: child.browserReady,
    imageNodeIds: (child.imageNodes ?? []).map((node) => node.id),
    mcp: child.mcp,
  };
}

export function useWorkerVM(
  mainAgentId: string | null | undefined,
  workerId: string | null | undefined,
): WorkerVM | null {
  const mainAgent = useDisplayAgentState(mainAgentId);
  const child = workerId
    ? mainAgent?.children.find((candidate) => candidate.id === workerId)
    : undefined;
  const incident = useTargetIncident(mainAgentId, workerId);

  return useMemo(
    () => (child && mainAgentId ? projectWorker(mainAgentId, child, incident) : null),
    [child, incident, mainAgentId],
  );
}

function useTargetIncident(
  agentId: string | null | undefined,
  workerId: string | null | undefined,
): AgentIncident | undefined {
  return useIncidentStore((state) => (
    agentId
      ? selectLatestTargetIncident(state.incidents, {
          agentId,
          ...(workerId ? { workerId } : {}),
        })
      : undefined
  ));
}

/** A requested Worker never falls back to the main Agent while its state is unavailable. */
export function resolveConversationTarget(
  agent: AgentVM | null,
  worker: WorkerVM | null,
  workerId: string | undefined,
): AgentVM | WorkerVM | null {
  return workerId ? worker : agent;
}

/** Worker 任务投影：始终从 Parent 权威看板派生，不从 worker 自身取 */
export function projectWorkerTasks(
  taskBoard: AgentVM['taskBoard'],
  taskIds: readonly string[],
): readonly TaskItem[] {
  if (!taskBoard || taskIds.length === 0) return [];
  const wanted = new Set(taskIds);
  return taskBoard.items.filter((item) => wanted.has(item.id));
}
