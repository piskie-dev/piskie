/**
 * WorkspaceTree —— 左栏会话树，dock 与 thread 共用。
 *
 * 两级：**工作区 → thread**。一个 thread = 一个 AgentRun，在跑的与历史的在**同一列表**里，
 * 活动、未读与最新消息时间使用同一套行布局。
 *
 * **worker 不进左栏**——它短命、数量不定，改由主屏 agent tab 承载。
 * 分组与排序全在 `data/workspaceGroups` + `data/threadRows`（纯函数 + 单测），本组件只渲染。
 *
 * 长列表两道闸：
 * - 默认收起，手动展开态持久化；搜索临时展开匹配组；
 * - 每组默认列前 {@link GROUP_PREVIEW_LIMIT} 条及选中项，可展开全部并收起。
 */

import { memo, useEffect, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronRight, FolderOpen, History, Pause, Plus, Square, Trash2 } from 'lucide-react';
import { hasUnreadMessages } from '@shared/agent-run-messages';

import { useUIStore } from '../../../store/uiStore';

import { MenuButton, type MenuItemDescriptor } from '../chrome/MenuButton';
import { OrbIndicator } from './OrbIndicator';
import { MessageTime } from './MessageTime';
import { Tooltip } from '../chrome/Tooltip';
import {
  buildHistoryMenu,
  buildSessionMenu,
  type SessionMenuKey,
  type SessionMenuSource,
} from '../data/sessionMenu';
import type { ThreadRow } from '../data/threadRows';
import type { WorkspaceDropEdge, WorkspaceGroup } from '../data/workspaceGroups';
import { resolvePresentationText } from '../data/presentationText';
import styles from './threads.module.css';

const LIVE_MENU_ICON = {
  workspace: <FolderOpen size={12} />,
  trace: <History size={12} />,
  pause: <Pause size={12} />,
  stop: <Square size={12} />,
} as const;

const HISTORY_MENU_ICON = {
  open: <FolderOpen size={12} />,
  trace: <History size={12} />,
  delete: <Trash2 size={12} />,
} as const;

export type ThreadMenuKey = SessionMenuKey | 'open' | 'delete' | 'markRead';

export interface WorkspaceTreeProps {
  readonly groups: readonly WorkspaceGroup[];
  readonly searching?: boolean;
  readonly onMoveGroup?: (source: string, target: string, edge: WorkspaceDropEdge) => void;
  readonly selectedAgentId?: string | null;
  readonly onSelect: (row: ThreadRow) => void;
  readonly menuSourceOf: (agentId: string) => SessionMenuSource;
  readonly onMenuAction: (key: ThreadMenuKey, row: ThreadRow) => void;
  /** 组头「在此工作区新建会话」:回空态并预选该组目录(默认组为 undefined) */
  readonly onNewSessionIn?: (workspace?: string) => void;
}

const Row = memo<{
  readonly row: ThreadRow;
  readonly selected: boolean;
  readonly onSelect: (row: ThreadRow) => void;
  readonly menuSourceOf: (agentId: string) => SessionMenuSource;
  readonly onMenuAction: (key: ThreadMenuKey, row: ThreadRow) => void;
}>(({ row, selected, onSelect, menuSourceOf, onMenuAction }) => {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const reveal = useUIStore((store) => {
    const selection = store.consoleSelection;
    return selection?.kind !== 'empty' && selection?.agentId === row.agentId ? selection : null;
  });
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [selected, reveal]);
  const live = row.live;
  const unread = hasUnreadMessages(row.messages);
  const activity = live
    ? resolvePresentationText(live.activity.text, (key, values) => t(key, values ?? {}))
    : undefined;

  const items: MenuItemDescriptor[] = live
    ? buildSessionMenu(menuSourceOf(row.agentId)).map((item) => ({
        ...item,
        label: t(`sessionWorkbenchUi.sessionMenu.${item.key === 'workspace' ? 'openWorkspace' : item.key === 'trace' ? 'viewTrace' : item.key}`),
        icon: LIVE_MENU_ICON[item.key],
      }))
    : // 走到这个分支即非在跑 ⇒ 恒可删（`deletable` 的判断就是"是否在跑"）
      buildHistoryMenu({ deletable: true }).map((item) => ({
        ...item,
        label: t(`sessionWorkbenchUi.sessionMenu.${item.key === 'open' ? 'openRecord' : item.key === 'trace' ? 'viewTrace' : item.key}`),
        icon: HISTORY_MENU_ICON[item.key],
      }));

  if (unread) items.push({ key: 'markRead', label: t('sessionWorkbenchUi.sessionMenu.markRead'), icon: <Check size={12} /> });

  return (
    <div
      ref={ref}
      className={styles.row}
      data-agent-id={row.agentId}
      aria-label={[row.label, unread ? t('sessionWorkbenchUi.sidebar.unread') : '', live?.working ? t('sessionWorkbenchUi.agentActivity.working') : ''].filter(Boolean).join(', ')}
      data-live={live ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(row)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(row);
        }
      }}
      title={row.label}
    >
      <span className={styles.dotSlot} data-unread={unread || undefined} aria-hidden />

      <span className={styles.rowLabel} title={row.label}>{row.label}</span>

      <span className={styles.activitySlot} title={activity}>
        {live?.working && <OrbIndicator size={14} variant="expanding" />}
      </span>
      <MessageTime timestamp={row.messages?.latestMessage?.timestamp} />

      <span className={styles.rowMenu}>
        <MenuButton
          items={items}
          onSelect={(key) => onMenuAction(key as ThreadMenuKey, row)}
          ariaLabel={live
            ? t('sessionWorkbenchUi.sidebar.taskActions')
            : t('sessionWorkbenchUi.sidebar.historyActions')}
        />
      </span>
    </div>
  );
});

Row.displayName = 'WorkspaceThreadRow';

interface GroupProps extends Omit<WorkspaceTreeProps, 'groups' | 'onMoveGroup'> {
  readonly group: WorkspaceGroup;
  readonly dropEdge?: WorkspaceDropEdge;
  readonly dragging: boolean;
  readonly onDragStart?: (event: DragEvent<HTMLElement>) => void;
  readonly onDragOver: (event: DragEvent<HTMLElement>) => void;
  readonly onDrop: (event: DragEvent<HTMLElement>) => void;
  readonly onDragEnd: () => void;
}

/** 每组默认露出的条数；在跑的排最前，天然不会被藏 */
const GROUP_PREVIEW_LIMIT = 5;

const Group = memo<GroupProps>(({ group, selectedAgentId, onSelect, menuSourceOf, onMenuAction,
  onNewSessionIn, searching, dropEdge, dragging, onDragStart, onDragOver, onDrop, onDragEnd }) => {
  const { t } = useTranslation();
  const expandedGroups = useUIStore((store) => store.expandedWorkspaceGroups);
  const toggleWorkspaceGroup = useUIStore((store) => store.toggleWorkspaceGroup);
  const open = searching || expandedGroups.includes(group.key);

  const [showAll, setShowAll] = useState(false);
  const previewRows = group.rows.filter((row, index) => index < GROUP_PREVIEW_LIMIT || row.agentId === selectedAgentId);
  const hiddenCount = group.rows.length - previewRows.length;
  const visibleRows = showAll || searching ? group.rows : previewRows;

  return (
    <section
      className={styles.group}
      data-open={open ? 'true' : undefined}
      data-drop-edge={dropEdge}
      data-dragging={dragging || undefined}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className={styles.groupHead}>
        <button
          type="button"
          className={styles.groupToggle}
          onClick={() => { if (!searching) toggleWorkspaceGroup(group.key); }}
          aria-expanded={open}
          aria-disabled={searching || undefined}
          draggable={!!onDragStart}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        >
          <span className={styles.caret}>
            <ChevronRight size={10} />
          </span>
          {group.path ? (
            <Tooltip title={group.path}>
              <span className={styles.groupLabel}>{group.label}</span>
            </Tooltip>
          ) : (
            <span className={styles.groupLabel}>{group.label}</span>
          )}
        </button>
        {onNewSessionIn && (
          <Tooltip title={t('sessionWorkbenchUi.sidebar.newInWorkspace')}>
            <button
              type="button"
              className={styles.groupNew}
              aria-label={t('sessionWorkbenchUi.sidebar.newInNamedWorkspace', { name: group.label })}
              onClick={() => onNewSessionIn(group.path)}
            >
              <Plus size={11} />
            </button>
          </Tooltip>
        )}
      </div>

      {open &&
        visibleRows.map((row) => (
          <Row
            key={row.key}
            row={row}
            selected={row.agentId === selectedAgentId}
            onSelect={onSelect}
            menuSourceOf={menuSourceOf}
            onMenuAction={onMenuAction}
          />
        ))}

      {open && !searching && hiddenCount > 0 && (
        <button type="button" className={styles.moreRow} onClick={() => setShowAll((value) => !value)}>
          {showAll
            ? t('sessionWorkbenchUi.sidebar.fewerRows')
            : t('sessionWorkbenchUi.sidebar.moreRows', { count: hiddenCount })}
        </button>
      )}
    </section>
  );
});

Group.displayName = 'WorkspaceGroup';

export const WorkspaceTree = memo<WorkspaceTreeProps>(({ groups, onMoveGroup, ...rest }) => {
  const { t } = useTranslation();
  const [source, setSource] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ key: string; edge: WorkspaceDropEdge } | null>(null);
  const clearDrag = () => { setSource(null); setDrop(null); };
  const dropEdge = (event: DragEvent<HTMLElement>): WorkspaceDropEdge => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  };
  if (groups.length === 0) {
    return <div className={styles.empty}>{t(rest.searching ? 'sessionWorkbenchUi.sidebar.noMatches' : 'sessionWorkbenchUi.sidebar.empty')}</div>;
  }

  return (
    <div onDragLeave={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(null);
    }}>
      {groups.map((group) => (
        <Group
          key={group.key}
          group={group}
          {...rest}
          dragging={source === group.key}
          dropEdge={drop?.key === group.key ? drop.edge : undefined}
          onDragStart={onMoveGroup ? (event) => {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', group.key);
            setSource(group.key);
          } : undefined}
          onDragOver={(event) => {
            if (!onMoveGroup || source === null) return;
            if (source === group.key) { setDrop(null); return; }
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            setDrop({ key: group.key, edge: dropEdge(event) });
          }}
          onDrop={(event) => {
            if (!onMoveGroup || source === null) return;
            event.preventDefault();
            onMoveGroup(source, group.key, dropEdge(event));
            clearDrag();
          }}
          onDragEnd={clearDrag}
        />
      ))}
    </div>
  );
});

WorkspaceTree.displayName = 'WorkspaceTree';
