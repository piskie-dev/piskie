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

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronsLeft, ChevronsRight, Play, Search, SquarePen } from 'lucide-react';

import {
  messageText,
  resolvePresentationText,
  type PresentationText,
} from '../../../i18n/presentationText';
import { normalizeWorkspaceSessionSort, useUIStore } from '../../../store/uiStore';
import { copyText } from '../../../services/clipboard';
import { pushToast, useToastStore } from '../../toasts/toast-store';
import type { MenuItemDescriptor } from '../chrome/MenuButton';
import { Dialog } from '../chrome/Dialog';
import { OrbIndicator } from './OrbIndicator';
import { useAgentRunList } from '@/renderer-runtime/hooks';
import { Tooltip } from '../chrome/Tooltip';
import { useConsoleActions } from '../data/actions';
import { useHistoryRowsReady } from '../data/session';
import type { HistoryRow, SessionRow } from '../data/sessionRow';
import type { SessionMenuSource } from '../data/sessionMenu';
import { buildThreadRows, moveThreadRow, sortThreadRows, type ThreadRow } from '../data/threadRows';
import {
  filterWorkspaceGroups,
  groupByWorkspace,
  moveWorkspaceGroup,
  normalizeWorkspaceGroupKeys,
  orderWorkspaceGroups,
  reconcileWorkspaceOrder,
  workspaceGroupKey,
  type WorkspaceDropEdge,
  type WorkspaceGroup,
} from '../data/workspaceGroups';
import { WorkspaceTree, type ThreadMenuKey, type WorkspaceMenuKey } from './WorkspaceTree';
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
  readonly defaultWorkspacePath?: string;
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
    defaultWorkspacePath,
    onNewSessionIn,
  }) => {
    const { t } = useTranslation();
    const actions = useConsoleActions();
    const [query, setQuery] = useState('');
    const [renameTarget, setRenameTarget] = useState<ThreadRow | null>(null);
    const [renameValue, setRenameValue] = useState('');
    const [renameError, setRenameError] = useState<PresentationText | null>(null);
    const [renaming, setRenaming] = useState(false);
    const [confirmation, setConfirmation] = useState<{ kind: 'delete' | 'stop'; row: ThreadRow } | null>(null);
    const [confirming, setConfirming] = useState(false);
    const [confirmError, setConfirmError] = useState<PresentationText | null>(null);
    const confirmationRequest = useRef(0);
    const closeConfirmation = useCallback(() => {
      confirmationRequest.current += 1;
      setConfirmation(null);
      setConfirming(false);
      setConfirmError(null);
    }, []);
    const renameRequest = useRef(0);
    const renameInput = useRef<HTMLInputElement>(null);
    const renameErrorId = useId();
    const selection = useUIStore((state) => state.consoleSelection);
    useEffect(() => setQuery(''), [selection]);
    const historyReady = useHistoryRowsReady();
    const attentionByAgentId = useAgentRunList((state) => state.attentionByAgentId);
    const savedOrder = useUIStore((state) => state.workspaceGroupOrder);
    const pinnedAgentRunIds = useUIStore((state) => state.pinnedAgentRunIds);
    const expandedGroups = useUIStore((state) => state.expandedWorkspaceGroups);
    const setOrder = useUIStore((state) => state.setWorkspaceGroupOrder);
    const toggleAgentRunPin = useUIStore((state) => state.toggleAgentRunPin);
    const hiddenKeys = useUIStore((state) => state.hiddenWorkspaceGroupKeys);
    const savedSessionSort = useUIStore((state) => state.workspaceSessionSort);
    const setSessionSort = useUIStore((state) => state.setWorkspaceSessionSort);
    const reconcileSessionSort = useUIStore((state) => state.reconcileWorkspaceSessionSort);
    const sessionSort = useMemo(() => normalizeWorkspaceSessionSort(savedSessionSort, defaultWorkspacePath), [savedSessionSort, defaultWorkspacePath]);
    const defaultWorkspacePathRef = useRef(defaultWorkspacePath);
    defaultWorkspacePathRef.current = defaultWorkspacePath;
    const searching = query.trim().length > 0;
    const sortingDisabledReason = searching ? t('contextMenu.sidebar.sortingUnavailable')
      : !historyReady ? t('contextMenu.sidebar.historyLoading') : undefined;
    const sortingBlocked = useRef(!!sortingDisabledReason);
    sortingBlocked.current = !!sortingDisabledReason;

    const allGroups = useMemo(() => groupByWorkspace(
      buildThreadRows({ sessions, history, attentionByAgentId, pinnedAgentRunIds }),
      t('sessionWorkbenchUi.shell.defaultWorkspace'),
      defaultWorkspacePath,
    ), [history, sessions, attentionByAgentId, pinnedAgentRunIds, defaultWorkspacePath, t]);
    const order = useMemo(
      () => reconcileWorkspaceOrder(savedOrder, allGroups, defaultWorkspacePath),
      [savedOrder, allGroups, defaultWorkspacePath],
    );
    useEffect(() => {
      if (historyReady && order !== savedOrder) setOrder([...order]);
    }, [historyReady, order, savedOrder, setOrder]);
    useEffect(() => {
      const normalized = normalizeWorkspaceGroupKeys(expandedGroups, defaultWorkspacePath);
      if (normalized !== expandedGroups) {
        useUIStore.setState({ expandedWorkspaceGroups: [...normalized] });
      }
    }, [defaultWorkspacePath, expandedGroups]);
    const orderedGroups = useMemo(() => orderWorkspaceGroups(allGroups, order).map((group) => ({
      ...group, rows: sortThreadRows(group.rows, sessionSort[group.key]),
    })), [allGroups, order, sessionSort]);
    // Merge aliases and freeze/prune against the complete inventory without changing sorting recency.
    useEffect(() => {
      reconcileSessionSort(defaultWorkspacePath, historyReady ? Object.fromEntries(
        allGroups.map((group) => [group.key, group.rows.map((row) => row.agentId)]),
      ) : undefined);
    }, [defaultWorkspacePath, historyReady, allGroups, savedSessionSort, reconcileSessionSort]);
    const visibleGroups = useMemo(() => orderedGroups.filter((group) => !hiddenKeys.includes(group.key)
      && !(group.key === '' && defaultWorkspacePath && hiddenKeys.includes(defaultWorkspacePath))), [orderedGroups, hiddenKeys, defaultWorkspacePath]);
    const groups = useMemo(() => filterWorkspaceGroups(visibleGroups, query), [visibleGroups, query]);
    const moveGroup = useCallback((source: string, target: string, edge: WorkspaceDropEdge) => {
      if (sortingBlocked.current) return;
      setOrder([...moveWorkspaceGroup(order, source, target, edge, visibleGroups.map((group) => group.key))]);
    }, [order, setOrder, visibleGroups]);
    const restoreAutomatic = useCallback((key: string) => {
      if (sortingBlocked.current) return;
      setSessionSort(workspaceGroupKey(key, defaultWorkspacePathRef.current), { mode: 'auto', order: [] });
    }, [setSessionSort]);
    const moveThread = useCallback((groupKey: string, source: string, target: string, edge: WorkspaceDropEdge) => {
      if (sortingBlocked.current) return;
      const group = orderedGroups.find((candidate) => candidate.key === groupKey);
      if (!group) return;
      const next = moveThreadRow(group.rows, source, target, edge);
      if (!next) return;
      const wasManual = sessionSort[groupKey]?.mode === 'manual';
      setSessionSort(groupKey, { mode: 'manual', order: next });
      if (!wasManual) pushToast({
        id: `sidebar-sort:${groupKey}`, tone: 'info', title: t('contextMenu.sidebar.manualSortEnabled'),
        action: { label: t('contextMenu.sidebar.restoreAutomatic'), run: () => restoreAutomatic(groupKey) },
      });
    }, [orderedGroups, restoreAutomatic, sessionSort, setSessionSort, t]);
    useEffect(() => {
      useToastStore.setState((state) => ({ toasts: state.toasts.map((toast) => {
        if (!toast.id.startsWith('sidebar-sort:')) return toast;
        const key = toast.id.slice('sidebar-sort:'.length);
        return { ...toast, detail: sortingDisabledReason, action: sortingDisabledReason ? undefined : {
          label: t('contextMenu.sidebar.restoreAutomatic'), run: () => restoreAutomatic(key),
        } };
      }) }));
    }, [restoreAutomatic, sortingDisabledReason, t]);
    const reportFailure = useCallback((error?: PresentationText) => {
      pushToast({ id: 'sidebar-action-error', tone: 'error', title: t('contextMenu.sidebar.actionFailed', {
        message: error ? resolvePresentationText(error, (key, values) => t(key, values ?? {})) : t('sessionWorkbenchUi.action.operationFailed'),
      }) });
    }, [t]);
    const groupMenuItems = useCallback((group: WorkspaceGroup): readonly MenuItemDescriptor<WorkspaceMenuKey>[] => {
      const index = visibleGroups.findIndex((candidate) => candidate.key === group.key);
      const mode = sessionSort[group.key]?.mode ?? 'auto';
      return [
        ...(onNewSessionIn ? [{ key: 'newSession' as const, label: t('contextMenu.sidebar.newSession') }] : []),
        ...(group.path ? [
          { key: 'openFolder' as const, label: t('contextMenu.sidebar.openFolder') },
          { key: 'copyPath' as const, label: t('contextMenu.sidebar.copyPath') },
        ] : []),
        { key: 'sessionSort', label: t('contextMenu.sidebar.sessionSort'), separatorBefore: true,
          disabled: !!sortingDisabledReason, disabledReason: sortingDisabledReason, children: [
            { key: 'auto', label: t('contextMenu.sidebar.automaticSort'), checked: mode === 'auto', disabled: !!sortingDisabledReason, disabledReason: sortingDisabledReason },
            { key: 'manual', label: t('contextMenu.sidebar.manualSort'), checked: mode === 'manual', disabled: !!sortingDisabledReason, disabledReason: sortingDisabledReason },
          ] },
        { key: 'moveUp', label: t('contextMenu.sidebar.moveUp'), disabled: !!sortingDisabledReason || index === 0,
          disabledReason: sortingDisabledReason ?? (index === 0 ? t('contextMenu.sidebar.atStart') : undefined) },
        { key: 'moveDown', label: t('contextMenu.sidebar.moveDown'), disabled: !!sortingDisabledReason || index === visibleGroups.length - 1,
          disabledReason: sortingDisabledReason ?? (index === visibleGroups.length - 1 ? t('contextMenu.sidebar.atEnd') : undefined) },
        ...(group.path ? [{ key: 'removeFromSidebar' as const, label: t('contextMenu.sidebar.removeFromSidebar'), separatorBefore: true }] : []),
      ];
    }, [onNewSessionIn, sessionSort, sortingDisabledReason, t, visibleGroups]);
    const onGroupMenuAction = useCallback(async (key: WorkspaceMenuKey, group: WorkspaceGroup) => {
      if (key === 'newSession') onNewSessionIn?.(group.path);
      else if (key === 'openFolder' && group.path) {
        const result = await actions.openWorkspace(group.path);
        if (!result.ok) reportFailure(result.error);
      } else if (key === 'copyPath' && group.path) {
        try {
          await copyText(group.path);
          pushToast({ id: 'sidebar-path-copied', tone: 'info', title: t('contextMenu.sidebar.pathCopied') });
        } catch (error) { reportFailure({ kind: 'raw', text: String(error) }); }
      } else if (key === 'removeFromSidebar' && group.path) {
        useUIStore.getState().hideWorkspaceGroup(group.key);
        pushToast({ id: `sidebar-hidden:${group.key}`, tone: 'info', title: t('contextMenu.sidebar.removedFromSidebar'),
          action: { label: t('contextMenu.sidebar.undo'), run: () => useUIStore.getState().restoreWorkspaceGroup(group.key) } });
      } else if (!sortingBlocked.current) {
        if (key === 'auto') restoreAutomatic(group.key);
        else if (key === 'manual' && sessionSort[group.key]?.mode !== 'manual') {
          const complete = orderedGroups.find((candidate) => candidate.key === group.key);
          if (complete) setSessionSort(group.key, { mode: 'manual', order: complete.rows.map((row) => row.agentId) });
        } else if (key === 'moveUp' || key === 'moveDown') {
          const index = visibleGroups.findIndex((candidate) => candidate.key === group.key);
          const target = visibleGroups[index + (key === 'moveUp' ? -1 : 1)];
          if (target) moveGroup(group.key, target.key, key === 'moveUp' ? 'before' : 'after');
        }
      }
    }, [actions, moveGroup, onNewSessionIn, orderedGroups, reportFailure, restoreAutomatic, sessionSort, setSessionSort, t, visibleGroups]);

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

    const openRename = useCallback((row: ThreadRow) => {
      renameRequest.current += 1;
      setRenameTarget(row);
      setRenameValue(row.label);
      setRenameError(null);
      setRenaming(false);
    }, []);

    const closeRename = useCallback(() => {
      renameRequest.current += 1;
      setRenameTarget(null);
      setRenameError(null);
      setRenaming(false);
    }, []);

    useEffect(() => {
      if (!renameTarget) return;
      renameInput.current?.focus();
      renameInput.current?.select();
    }, [renameTarget]);

    const submitRename = useCallback(async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!renameTarget || renaming) return;
      const name = renameValue.trim();
      if (!name) {
        setRenameError(messageText('sessionWorkbenchUi.renameDialog.required'));
        return;
      }
      if (name === renameTarget.label.trim()) {
        closeRename();
        return;
      }

      const request = ++renameRequest.current;
      setRenameError(null);
      setRenaming(true);
      const result = await actions.renameAgentRun(renameTarget.agentId, name);
      if (request !== renameRequest.current) return;
      if (result.ok) {
        closeRename();
        return;
      }
      setRenaming(false);
      setRenameError(result.error ?? messageText('sessionWorkbenchUi.action.renameFailed'));
    }, [actions, closeRename, renameTarget, renameValue, renaming]);

    const onRowMenu = useCallback(
      (key: ThreadMenuKey, row: ThreadRow) => {
        if (key === 'pin' || key === 'unpin') {
          toggleAgentRunPin(row.agentId);
          return;
        }
        if (key === 'moveUp' || key === 'moveDown') {
          const group = orderedGroups.find((candidate) => candidate.rows.some((item) => item.agentId === row.agentId));
          if (!group || sessionSort[group.key]?.mode !== 'manual') return;
          const partition = group.rows.filter((item) => item.pinned === row.pinned);
          const index = partition.findIndex((item) => item.agentId === row.agentId);
          const target = partition[index + (key === 'moveUp' ? -1 : 1)];
          if (target) moveThread(group.key, row.agentId, target.agentId, key === 'moveUp' ? 'before' : 'after');
          return;
        }
        if (key === 'stop' || (key === 'delete' && !row.live && row.history)) {
          confirmationRequest.current += 1;
          setConfirmation({ kind: key, row });
          setConfirming(false);
          setConfirmError(null);
          return;
        }
        if (key === 'rename') {
          openRename(row);
          return;
        }
        if (key === 'markRead') {
          void actions.markRead(row.agentId, row.messages?.latestMessage?.index ?? -1);
          return;
        }
        if (row.live) {
          if (key === 'workspace') void actions.openWorkspace(row.workspace);
          else if (key === 'trace') void actions.openTrace(row.agentId);
          else if (key === 'pause') void actions.pause({ agentId: row.agentId });
          return;
        }

        const record = row.history;
        if (!record) return;
        if (key === 'open') onSelectHistory(record);
        else if (key === 'trace') void actions.openTrace(record.agentId);
      },
      [actions, moveThread, onSelectHistory, openRename, orderedGroups, sessionSort, toggleAgentRunPin],
    );

    const submitConfirmation = async () => {
      if (!confirmation || confirming) return;
      const { kind, row } = confirmation;
      if (kind === 'delete' && sessions.some((session) => session.agentId === row.agentId)) {
        setConfirmation(null);
        return;
      }
      const request = ++confirmationRequest.current;
      setConfirming(true);
      try {
        const result = await (kind === 'delete' ? actions.deleteHistory(row.agentId) : actions.stop(row.agentId));
        if (result.ok && kind === 'delete') useUIStore.getState().forgetSessionOrder(row.agentId);
        if (request !== confirmationRequest.current) return;
        if (!result.ok) { setConfirmError(result.error ?? messageText('sessionWorkbenchUi.action.operationFailed')); return; }
        closeConfirmation();
      } catch (error) {
        if (request === confirmationRequest.current) setConfirmError({ kind: 'raw', text: String(error) });
      } finally {
        if (request === confirmationRequest.current) setConfirming(false);
      }
    };

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
            {visibleGroups.flatMap((group) =>
              group.rows
                .filter((row) => !!row.live)
                .map((row) => (
                  <Tooltip key={row.key} title={`${group.label} · ${row.label}`}>
                    <button
                      type="button"
                      className={styles.iconButton}
                      data-selected={row.agentId === selectedAgentId ? 'true' : undefined}
                      onClick={() => onSelectSession(row.agentId)}
                      aria-label={[row.label, row.unread ? t('sessionWorkbenchUi.sidebar.unread') : ''].filter(Boolean).join(', ')}
                    >
                      {row.live!.working && <OrbIndicator size={14} variant="expanding" />}
                      <span
                        className={`${styles.dotSlot} ${row.live!.working ? styles.runningUnread : ''}`}
                        data-unread={row.unread || undefined}
                        aria-hidden
                      />
                    </button>
                  </Tooltip>
                )),
            )}
          </div>
        </div>
      );
    }

    return (
      <>
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

          <div className={styles.scroll} data-workspace-scroll>
            <WorkspaceTree
              groups={groups}
              searching={searching}
              onMoveGroup={!sortingDisabledReason ? moveGroup : undefined}
              onMoveThread={!sortingDisabledReason ? moveThread : undefined}
              sortingDisabledReason={sortingDisabledReason}
              groupMenuItems={groupMenuItems}
              onGroupMenuAction={(key, group) => { void onGroupMenuAction(key, group); }}
              selectedAgentId={selectedAgentId}
              onSelect={onSelectRow}
              menuSourceOf={menuSourceOf}
              onMenuAction={onRowMenu}
              onNewSessionIn={onNewSessionIn}
            />
          </div>
        </div>
        <Dialog
          open={confirmation !== null}
          onClose={closeConfirmation}
          title={t(`contextMenu.sidebar.${confirmation?.kind === 'stop' ? 'stopTitle' : 'deleteTitle'}`)}
          width={400}
        >
          {confirmation && <div className={styles.renameForm} aria-busy={confirming}>
            <p>{t(`contextMenu.sidebar.${confirmation.kind === 'delete' ? 'deleteBody' : 'stopBody'}`, { name: confirmation.row.label })}</p>
            {confirmError && <p className={styles.renameError} role="alert">{resolvePresentationText(confirmError, (key, values) => t(key, values ?? {}))}</p>}
            <div className={styles.renameActions}>
              <button type="button" className={styles.renameButton} disabled={confirming} onClick={closeConfirmation}>{t('common.cancel')}</button>
              <button type="button" className={`${styles.renameButton} ${styles.dangerButton}`} disabled={confirming} onClick={() => void submitConfirmation()}>
                {t(confirming ? `contextMenu.sidebar.${confirmation.kind === 'delete' ? 'deleting' : 'stopping'}` : `sessionWorkbenchUi.sessionMenu.${confirmation.kind}`)}
              </button>
            </div>
          </div>}
        </Dialog>
        <Dialog
          open={renameTarget !== null}
          onClose={closeRename}
          title={t('sessionWorkbenchUi.renameDialog.title')}
          width={400}
        >
          {renameTarget && (
            <form className={styles.renameForm} aria-busy={renaming} onSubmit={submitRename}>
              <label className={styles.renameField}>
                <span>{t('sessionWorkbenchUi.renameDialog.label')}</span>
                <input
                  ref={renameInput}
                  autoFocus
                  className={styles.renameInput}
                  value={renameValue}
                  disabled={renaming}
                  aria-invalid={renameError ? 'true' : undefined}
                  aria-describedby={renameError ? renameErrorId : undefined}
                  placeholder={t('sessionWorkbenchUi.renameDialog.placeholder')}
                  onChange={(event) => {
                    setRenameValue(event.target.value);
                    setRenameError(null);
                  }}
                />
              </label>
              {renameError && (
                <p id={renameErrorId} className={styles.renameError} role="alert">
                  {resolvePresentationText(renameError, (key, values) => t(key, values ?? {}))}
                </p>
              )}
              <div className={styles.renameActions}>
                <button
                  type="button"
                  className={styles.renameButton}
                  disabled={renaming}
                  onClick={closeRename}
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  className={`${styles.renameButton} ${styles.renamePrimary}`}
                  disabled={renaming}
                >
                  {t(renaming ? 'sessionWorkbenchUi.renameDialog.saving' : 'common.save')}
                </button>
              </div>
            </form>
          )}
        </Dialog>
      </>
    );
  },
);

ThreadSidebar.displayName = 'ThreadSidebar';
