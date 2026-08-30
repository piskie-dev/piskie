/**
 * ThreadSidebar —— 左栏整体（收起态 + 顶栏 + 会话树），**两个模式共用**。
 *
 * 形态：搜索 + `+` 菜单 + 在跑/历史合并的工作区树。两个模式的左栏完全一致，
 * 因此只有这一份实现。
 *
 * 职责边界：
 * - **列宽与容器归模式管**（dock 的固定 240 列 / thread 的可拖 Divider），本组件不写宽度
 * - 行点击的两种语义（在跑选中 / 历史恢复）与 `···` 菜单分发在这里收口 ——
 *   它们与呈现形态强耦合（合并树的 `row.live` 分流），不该让两个模式各抄一遍
 * - 搜索是本地过滤（无后端查询接口，AgentRun 历史一次读取后在本地筛选）
 */

import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronsLeft, ChevronsRight, Play, Plus, Search, Sparkles } from 'lucide-react';

import { MenuButton } from '../chrome/MenuButton';
import { StatusBadge } from '../chrome/StatusBadge';
import { Tooltip } from '../chrome/Tooltip';
import { useConsoleActions } from '../data/actions';
import type { HistoryRow, SessionRow } from '../data/sessionRow';
import type { SessionMenuSource } from '../data/sessionMenu';
import { buildThreadRows, type ThreadRow } from '../data/threadRows';
import { groupByWorkspace } from '../data/workspaceGroups';
import { WorkspaceTree, type ThreadMenuKey } from './WorkspaceTree';
import styles from './threads.module.css';

/** 本地过滤：无后端查询接口 */
function matches(query: string, ...fields: (string | undefined)[]): boolean {
  if (!query) return true;
  const needle = query.trim().toLowerCase();
  return fields.some((field) => field?.toLowerCase().includes(needle));
}

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
  readonly onStartTask?: () => void;
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
    onStartTask,
    onNewSessionIn,
  }) => {
    const { t } = useTranslation();
    const actions = useConsoleActions();
    const [query, setQuery] = useState('');

    /**
     * 在跑的与历史的合并成**一张表**再按工作区分组。
     * 过滤发生在合并**之后**，保证同一 AgentRun 的实时态和磁盘态使用同一条件。
     */
    const groups = useMemo(() => {
      const rows = buildThreadRows({ sessions, history });
      return groupByWorkspace(
        rows.filter((row) => matches(query, row.label, row.workspace)),
        t('sessionWorkbenchUi.shell.defaultWorkspace'),
      );
    }, [history, query, sessions, t]);

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

    if (collapsed) {
      return (
        /* 收起态：展开按钮 + 状态点竖列 + 新建菜单 */
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

          <span className={styles.rule} />

          <div className={styles.collapsedList}>
            {/* 收起态只列在跑的：52px 里放不下历史 */}
            {groups.flatMap((group) =>
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
                      <StatusBadge status={row.live!.status} dotOnly />
                    </button>
                  </Tooltip>
                )),
            )}
          </div>

          <span>
            <MenuButton
              items={[
                { key: 'blank', label: t('sessionWorkbenchUi.sidebar.blankSession'), icon: <Sparkles size={12} /> },
                { key: 'template', label: t('sessionWorkbenchUi.sidebar.startTask'), icon: <Play size={12} /> },
              ]}
              onSelect={(key) => (key === 'blank' ? onNewSession?.() : onStartTask?.())}
              ariaLabel={t('sessionWorkbenchUi.sidebar.create')}
              triggerClassName={styles.iconButton}
              placement="inline-end"
            >
              <Plus size={13} />
            </MenuButton>
          </span>
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

          {/* `+` 两项：空白会话 / 启动任务模板 */}
          <span>
            <MenuButton
              items={[
                { key: 'blank', label: t('sessionWorkbenchUi.sidebar.blankSession'), icon: <Sparkles size={12} /> },
                { key: 'template', label: t('sessionWorkbenchUi.sidebar.startTask'), icon: <Play size={12} /> },
              ]}
              onSelect={(key) => (key === 'blank' ? onNewSession?.() : onStartTask?.())}
              ariaLabel={t('sessionWorkbenchUi.sidebar.create')}
              triggerClassName={styles.newButton}
            >
              <Plus size={13} />
            </MenuButton>
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

        <div className={styles.scroll}>
          <WorkspaceTree
            groups={groups}
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
