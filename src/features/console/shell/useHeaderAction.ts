/**
 * 顶栏徽标跳转。
 *
 * 跳转目标表达成**目标 agent**，不是画布节点 id：选中它就是 reveal。
 * dock 模式下主 agent 不在画布上，按节点 id 定位会永远找不到、退避几轮后放弃——
 * 徽标点了没反应。
 *
 * 跨页协议（route state 里的 `consoleAction`）直接携带 typed AgentTarget；消费时只验证
 * 目标是否仍在当前 control-state snapshot 中，不解析 Canvas node id。
 *
 * ## worker 级 reveal
 *
 * 待确认项**多数落在 worker 上**（子流程的工具审批），只选中会话仍要用户自己去
 * 顶部标签里找是哪个 worker。所以解析结果带上 `workerId`（有就给），
 * 由模式各自把它落到自己的选中态（dock 的 `focusWorkerId` / thread 的 `tabWorkerId`）。
 *
 * **不把 worker 选中态提到壳里**：那是模式的呈现状态（dock 是固定列、thread 是 tab），
 * 提上来等于让两个模式共享一个语义不同的值。这里只发"一次性跳转请求"。
 */

import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { useRendererRuntime } from '../../../renderer-runtime/hooks';
import {
  firstAwaiting,
  isCurrentTarget,
} from './revealTarget';
import type { AgentTarget } from '../../../../shared/types/agent-control';
import type { ConsoleHeaderAction } from './headerAction';

interface ConsoleRouteState {
  consoleAction?: ConsoleHeaderAction;
}

export interface HeaderActionHandlers {
  readonly onReveal: (target: AgentTarget) => void;
  readonly onNewChat: () => void;
}

export function useHeaderAction({ onReveal, onNewChat }: HeaderActionHandlers): void {
  const location = useLocation();
  const navigate = useNavigate();
  const runtime = useRendererRuntime();
  const handledRef = useRef<number | null>(null);

  useEffect(() => {
    const action = (location.state as ConsoleRouteState | null)?.consoleAction;
    if (!action || handledRef.current === action.requestId) return;
    handledRef.current = action.requestId;

    const states = runtime.agentControl.state.getState().agentsById;
    const target =
      action.kind === 'approval'
        ? firstAwaiting(states)
        : action.kind === 'error'
          ? (isCurrentTarget(action.target, states) ? action.target : null)
          : null;

    if (action.kind === 'newChat') onNewChat();
    else if (target) onReveal(target);

    // 消费掉 route state，避免返回时重放
    navigate(location.pathname, { replace: true, state: null });
  }, [location.pathname, location.state, navigate, onNewChat, onReveal, runtime]);
}
