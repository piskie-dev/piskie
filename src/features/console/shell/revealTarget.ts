/**
 * 顶栏徽标 reveal 的**目标验证** —— 纯函数，只吃一份 `controlStates` 快照。
 *
 * 与 `useHeaderAction`（route state 消费 + 副作用）分开，让目标判定保持为不依赖
 * React、Renderer Runtime 或 DOM 的纯函数，node 测试无需 jsdom。
 *
 * ## worker 级 reveal 的优先序
 *
 * **主 agent 自己的待确认 / 待回答优先于任何 worker** —— 主 agent 的 `pendingQuestion`
 * 阻塞整条会话，比某个 worker 的工具审批更急。只有主 agent 没事时才往子流程里找。
 */

import type {
  AgentControlState,
  AgentTarget,
} from '../../../../shared/types/agent-control';

export function isCurrentTarget(
  target: AgentTarget,
  states: Record<string, AgentControlState>,
): boolean {
  const state = states[target.agentId];
  if (!state) return false;
  return target.workerId === undefined
    || state.children.some((child) => child.id === target.workerId);
}

/** 有待确认的第一个目标（主 agent 优先，其次它的 worker） */
export function firstAwaiting(states: Record<string, AgentControlState>): AgentTarget | null {
  for (const state of Object.values(states)) {
    if (state.pendingToolCall || state.pendingQuestion) return { agentId: state.agentId };
    const child = state.children.find((candidate) => candidate.pendingToolCall);
    if (child) return { agentId: state.agentId, workerId: child.id };
  }
  return null;
}
