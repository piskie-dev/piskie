/**
 * ThreadSidebar —— 左栏整体（收起态 + 顶栏 + 会话树），**两个模式共用**。
 *
 * 形态：搜索 + 新会话/启动任务 + 在跑/历史合并的工作区树。两个模式的左栏完全一致，
 * 因此只有这一份实现。
 *
 * 职责边界：
 * - **列宽与容器归模式管**（dock 的固定 240 列 / thread 的可拖 Divider），本组件不写宽度
 * - 行点击的两种语义（在跑选中 / 历史恢复）与 `···` 菜单分发在这里收口 ——
 *   它们与呈现形态强耦合（合并树的 `row.live` 分流），不该让两个模式各抄一遍
 * - 搜索是本地过滤（无后端查询接口，AgentRun 历史一次读取后在本地筛选）
 */

import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronsLeft, ChevronsRight, Play, Search, SquarePen } from 'lucide-react';

import { useUIStore } from '../../../store/uiStore';
import { OrbIndicator } from './OrbIndicator';
import { hasUnreadMessages } from '@shared/agent-run-messages';
import { Tooltip } from '../chrome/Tooltip';
import { useConsoleActions } from '../data/actions';
import { useHistoryRowsReady } from '../data/session';
import type { HistoryRow, SessionRow } from '../data/sessionRow';
import type { SessionMenuSource } from '../data/sessionMenu';
import { buildThreadRows, type ThreadRow } from '../data/threadRows';
import {
  filterWorkspaceGroups,
  groupByWorkspace,
  moveWorkspaceGroup,
  orderWorkspaceGroups,
  reconcileWorkspaceOrder,
  type WorkspaceDropEdge,
} from '../data/workspaceGroups';
import { WorkspaceTree, type ThreadMenuKey } from './WorkspaceTree';
import styles from './threads.module.css';

export interface ThreadSidebarProps {
  readonly sessions: readonly SessionRow[];
  readonly history: readonly HistoryRow[];
  readonly selectedAgentId?: string | null;
  readonly collapsed: boolean;
  readonly onToggleCollapsed: () => void;
  readonly onSelectSession: (agentId: string) => void;
  readonly onSelectHistory: (row: HistoryRow) => void;
  /** 谓词输入按 agentId 取（菜单可见性由 shared 谓词算） */
  readonly menuSourceOf: (agentId: string) => SessionMenuSource;
  readonly onNewSession?: () => void;
  readonly renderTaskLauncher?: (trigger: ReactNode) => ReactNode;
  /** 组头「在此工作区新建会话」:回空态并预选该组目录 */
  readonly onNewSessionIn?: (workspace?: string) => void;
}

export const ThreadSidebar = memo<ThreadSidebarProps>(
  ({
    sessions,
    history,
    selectedAgentId,
    collapsed,
    onToggleCollapsed,
    onSelectSession,
    onSelectHistory,
    menuSourceOf,
    onNewSession,
    renderTaskLauncher,
    onNewSessionIn,
  }) => {
    const { t } = useTranslation();
    const actions = useConsoleActions();
    const [query, setQuery] = useState('');
    const selection = useUIStore((state) => state.consoleSelection);
    useEffect(() => setQuery(''), [selection]);
    const historyReady = useHistoryRowsReady();
    const savedOrder = useUIStore((state) => state.workspaceGroupOrder);
    const setOrder = useUIStore((state) => state.setWorkspaceGroupOrder);
    const searching = query.trim().length > 0;

    const allGroups = useMemo(() => groupByWorkspace(
      buildThreadRows({ sessions, history }),
      t('sessionWorkbenchUi.shell.defaultWorkspace'),
    ), [history, sessions, t]);
    const order = useMemo(() => reconcileWorkspaceOrder(savedOrder, allGroups), [savedOrder, allGroups]);
    useEffect(() => {
      if (historyReady && order !== savedOrder) setOrder([...order]);
    }, [historyReady, order, savedOrder, setOrder]);
    const orderedGroups = useMemo(() => orderWorkspaceGroups(allGroups, order), [allGroups, order]);
    const groups = useMemo(() => filterWorkspaceGroups(orderedGroups, query), [orderedGroups, query]);
    const moveGroup = useCallback((source: string, target: string, edge: WorkspaceDropEdge) => {
      if (!allGroups.some((group) => group.key === source)) return;
      setOrder([...moveWorkspaceGroup(order, source, target, edge)]);
    }, [allGroups, order, setOrder]);

    /**
     * 行点击：在跑的选中会话，历史的恢复记录（后端懒恢复）。
     * 合并成一张表后这里是唯一的分流点——两种语义的差别只在这一个 `row.live` 判断上。
     */
    const onSelectRow = useCallback(
      (row: ThreadRow) => {
        if (row.live) onSelectSession(row.agentId);
        else if (row.history) onSelectHistory(row.history);
      },
      [onSelectHistory, onSelectSession],
    );

    const onRowMenu = useCallback(
      (key: ThreadMenuKey, row: ThreadRow) => {
        if (key === 'markRead' && row.messages?.latestMessage) {
          void actions.markRead(row.agentId, row.messages.latestMessage.index);
          return;
        }
        if (row.live) {
          if (key === 'workspace') void actions.openWorkspace(row.workspace);
          else if (key === 'trace') void actions.openTrace(row.agentId);
          else if (key === 'pause') void actions.pause({ agentId: row.agentId });
          else if (key === 'stop') void actions.stop(row.agentId);
          return;
        }

        const record = row.history;
        if (!record) return;
        if (key === 'open') onSelectHistory(record);
        else if (key === 'trace') void actions.openTrace(record.agentId);
        else if (key === 'delete') void actions.deleteHistory(record.agentId);
      },
      [actions, onSelectHistory],
    );

    const taskTrigger = (
      <button
        type="button"
        className={collapsed ? styles.iconButton : styles.actionButton}
        aria-label={t('sessionWorkbenchUi.sidebar.startTask')}
        aria-haspopup="dialog"
      >
        <Play size={14} />
        {!collapsed && t('sessionWorkbenchUi.sidebar.startTask')}
      </button>
    );
    const taskLauncher = renderTaskLauncher?.(collapsed
      ? <Tooltip title={t('sessionWorkbenchUi.sidebar.startTask')}>{taskTrigger}</Tooltip>
      : taskTrigger);

    if (collapsed) {
      return (
        /* 收起态：展开按钮 + 两个独立入口 + 状态点竖列 */
        <div className={styles.collapsed}>
          <Tooltip title={t('sessionWorkbenchUi.sidebar.expand')}>
            <button
              type="button"
              className={styles.iconButton}
              onClick={onToggleCollapsed}
              aria-label={t('sessionWorkbenchUi.sidebar.expand')}
            >
              <ChevronsRight size={12} />
            </button>
          </Tooltip>

          <Tooltip title={t('sessionWorkbenchUi.sidebar.blankSession')}>
            <button
              type="button"
              className={styles.iconButton}
              onClick={onNewSession}
              aria-label={t('sessionWorkbenchUi.sidebar.blankSession')}
            >
              <SquarePen size={14} />
            </button>
          </Tooltip>
          {taskLauncher}
          <span className={styles.rule} />

          <div className={styles.collapsedList}>
            {/* 收起态只列在跑的：52px 里放不下历史 */}
            {orderedGroups.flatMap((group) =>
              group.rows
                .filter((row) => !!row.live)
                .map((row) => (
                  <Tooltip key={row.key} title={`${group.label} · ${row.label}`}>
                    <button
                      type="button"
                      className={styles.iconButton}
                      data-selected={row.agentId === selectedAgentId ? 'true' : undefined}
                      onClick={() => onSelectSession(row.agentId)}
                      aria-label={row.label}
                    >
                      {row.live!.working
                        ? <OrbIndicator size={14} variant="expanding" />
                        : <span className={styles.dotSlot} data-unread={hasUnreadMessages(row.messages) || undefined} />}
                    </button>
                  </Tooltip>
                )),
            )}
          </div>
        </div>
      );
    }

    return (
      <div className={styles.threads}>
        <div className={styles.top}>
          <span className={styles.search}>
            <Search size={11} />
            <input
              className={styles.searchInput}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('sessionWorkbenchUi.sidebar.search')}
              aria-label={t('sessionWorkbenchUi.sidebar.search')}
            />
          </span>

          <Tooltip title={t('sessionWorkbenchUi.sidebar.collapse')}>
            <button
              type="button"
              className={styles.collapseButton}
              onClick={onToggleCollapsed}
              aria-label={t('sessionWorkbenchUi.sidebar.collapse')}
            >
              <ChevronsLeft size={12} />
            </button>
          </Tooltip>
        </div>

        <div className={styles.actions}>
          <button type="button" className={styles.actionButton} onClick={onNewSession}>
            <SquarePen size={14} />
            {t('sessionWorkbenchUi.sidebar.blankSession')}
          </button>
          {taskLauncher}
        </div>

        <div className={styles.scroll}>
          <WorkspaceTree
            groups={groups}
            searching={searching}
            onMoveGroup={historyReady && !searching ? moveGroup : undefined}
            selectedAgentId={selectedAgentId}
            onSelect={onSelectRow}
            menuSourceOf={menuSourceOf}
            onMenuAction={onRowMenu}
            onNewSessionIn={onNewSessionIn}
          />
        </div>
      </div>
    );
  },
);

ThreadSidebar.displayName = 'ThreadSidebar';
