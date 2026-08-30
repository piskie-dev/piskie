/**
 * 会话列表 VM——左栏消费的数据。
 *
 * 两个模式共用这一层，各自渲染（dock 平铺卡片 / thread 工作区分组 + AgentRun 行）。
 * **纯部分在 `sessionRow.ts`**（类型 / 排序 / 文案派生），这里只有 store 订阅。
 *
 * `groupKey` 预留但恒为 undefined：dock 不分组；thread 的分组走 `workspaceGroups`。
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import {
  useAgentControl,
  useAgentRunList,
} from '../../../renderer-runtime/hooks';
import {
  projectActiveAgentRun,
  projectPersistedAgentRun,
} from './agentRunViewModel';
import {
  sortSessionRows,
  type HistoryRow,
  type SessionRow,
} from './sessionRow';

export type { HistoryRow, SessionRow };

export function useSessionRows(): readonly SessionRow[] {
  const { t } = useTranslation();
  const controlStates = useAgentControl((state) => state.agentsById);

  return useMemo(() => {
    const unnamedTask = t('sessionWorkbenchUi.shell.unnamedTask');
    const rows = Object.values(controlStates).map<SessionRow>((state) => (
      projectActiveAgentRun(state, unnamedTask)
    ));

    return sortSessionRows(rows);
  }, [controlStates, t]);
}

export function useHistoryRows(): readonly HistoryRow[] {
  const agentRuns = useAgentRunList((state) => state.runs);
  const controlStates = useAgentControl((state) => state.agentsById);

  return useMemo(
    () =>
      agentRuns.map<HistoryRow>((snapshot) => (
        projectPersistedAgentRun(snapshot, controlStates[snapshot.agentId])
      )),
    [agentRuns, controlStates],
  );
}
