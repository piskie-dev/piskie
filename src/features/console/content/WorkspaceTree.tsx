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
 * - 每组默认列全部置顶项、前 {@link GROUP_PREVIEW_LIMIT} 条未置顶项及选中项，可展开全部并收起。
 */

import { memo, useEffect, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  GripVertical,
  FolderOpen,
  History,
  Pause,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Square,
  Trash2,
} from 'lucide-react';

import { useUIStore } from '../../../store/uiStore';

import { MenuButton, type MenuItemDescriptor } from '../chrome/MenuButton';
import { useContextMenu } from '../chrome/useContextMenu';
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
  rename: <Pencil size={12} />,
  pause: <Pause size={12} />,
  stop: <Square size={12} />,
} as const;

const HISTORY_MENU_ICON = {
  open: <FolderOpen size={12} />,
  trace: <History size={12} />,
  rename: <Pencil size={12} />,
  delete: <Trash2 size={12} />,
} as const;

export type ThreadMenuKey = SessionMenuKey | 'open' | 'delete' | 'markRead' | 'pin' | 'unpin' | 'moveUp' | 'moveDown';
export type WorkspaceMenuKey = 'newSession' | 'openFolder' | 'copyPath' | 'sessionSort' | 'auto' | 'manual' | 'moveUp' | 'moveDown' | 'removeFromSidebar';

export interface WorkspaceTreeProps {
  readonly groups: readonly WorkspaceGroup[];
  readonly searching?: boolean;
  readonly onMoveGroup?: (source: string, target: string, edge: WorkspaceDropEdge) => void;
  readonly onMoveThread?: (groupKey: string, source: string, target: string, edge: WorkspaceDropEdge) => void;
  readonly sortingDisabledReason?: string;
  readonly groupMenuItems?: (group: WorkspaceGroup) => readonly MenuItemDescriptor<WorkspaceMenuKey>[];
  readonly onGroupMenuAction?: (key: WorkspaceMenuKey, group: WorkspaceGroup) => void;
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
  readonly manual: boolean;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly sortingDisabledReason?: string;
  readonly dragging: boolean;
  readonly dropEdge?: WorkspaceDropEdge;
  readonly onDragStart?: (event: DragEvent<HTMLElement>) => void;
  readonly onDragOver: (event: DragEvent<HTMLElement>) => void;
  readonly onDrop: (event: DragEvent<HTMLElement>) => void;
  readonly onDragEnd: () => void;
}>(({ row, selected, onSelect, menuSourceOf, onMenuAction, manual, canMoveUp, canMoveDown,
  sortingDisabledReason, dragging, dropEdge, onDragStart, onDragOver, onDrop, onDragEnd }) => {
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
  const unread = row.unread;
  const activity = live
    ? resolvePresentationText(live.activity.text, (key, values) => t(key, values ?? {}))
    : undefined;
  const pinKey = row.pinned ? 'unpin' : 'pin';
  const pinLabel = t(`sessionWorkbenchUi.sessionMenu.${pinKey}`);

  let items: MenuItemDescriptor<ThreadMenuKey>[] = [{
    key: pinKey,
    label: pinLabel,
    icon: row.pinned ? <PinOff size={12} /> : <Pin size={12} />,
  }, ...(live
    ? buildSessionMenu({ ...menuSourceOf(row.agentId), renamable: true }).map((item) => ({
        ...item,
        label: t(`sessionWorkbenchUi.sessionMenu.${item.key === 'workspace' ? 'openWorkspace' : item.key === 'trace' ? 'viewTrace' : item.key}`),
        icon: LIVE_MENU_ICON[item.key],
      }))
    : // 走到这个分支即非在跑 ⇒ 恒可删（`deletable` 的判断就是"是否在跑"）
      buildHistoryMenu({ deletable: true }).map((item) => ({
        ...item,
        label: t(`sessionWorkbenchUi.sessionMenu.${item.key === 'open' ? 'openRecord' : item.key === 'trace' ? 'viewTrace' : item.key}`),
        icon: HISTORY_MENU_ICON[item.key],
      })))];

  if (unread) items.push({ key: 'markRead', label: t('sessionWorkbenchUi.sessionMenu.markRead'), icon: <Check size={12} /> });
  if (manual) {
    items.push(...(['moveUp', 'moveDown'] as const).map((key) => {
      const allowed = key === 'moveUp' ? canMoveUp : canMoveDown;
      return {
        key, label: t(`contextMenu.sidebar.${key}`),
        icon: key === 'moveUp' ? <ArrowUp size={12} /> : <ArrowDown size={12} />,
        disabled: !!sortingDisabledReason || !allowed,
        disabledReason: sortingDisabledReason ?? (!allowed ? t(`contextMenu.sidebar.${key === 'moveUp' ? 'atStart' : 'atEnd'}`) : undefined),
      };
    }));
  }
  const menuOrder: ThreadMenuKey[] = ['pin', 'unpin', 'rename', 'markRead', 'workspace', 'open', 'trace', 'moveUp', 'moveDown', 'pause', 'stop', 'delete'];
  items.sort((a, b) => menuOrder.indexOf(a.key) - menuOrder.indexOf(b.key));
  items = items.map((item, index) => ({
    ...item,
    label: item.key === 'delete' || item.key === 'stop'
      ? t(`contextMenu.sidebar.${item.key === 'delete' ? 'deleteSession' : 'stopSession'}`)
      : item.key === 'rename' ? `${item.label}…` : item.label,
    separatorBefore: index > 0 && (['workspace', 'open', 'moveUp', 'pause', 'delete'].includes(item.key)
      || (item.key === 'stop' && items[index - 1]?.key !== 'pause')),
  }));
  const selectMenu = (key: ThreadMenuKey) => onMenuAction(key, row);
  const contextMenu = useContextMenu({ items, onSelect: selectMenu, ariaLabel: t('contextMenu.sidebar.sessionMenuLabel') });

  return (
    <div
      ref={ref}
      className={styles.row}
      data-agent-id={row.agentId}
      data-dragging={dragging || undefined}
      data-drop-edge={dropEdge}
      data-context-menu={contextMenu.menu ? 'true' : undefined}
      onContextMenu={contextMenu.onContextMenu}
      onDragOver={onDragOver}
      onDrop={onDrop}
      aria-label={[
        row.label,
        row.pinned ? t('sessionWorkbenchUi.sidebar.pinned') : '',
        unread ? t('sessionWorkbenchUi.sidebar.unread') : '',
        live?.working ? t('sessionWorkbenchUi.agentActivity.working') : '',
      ].filter(Boolean).join(', ')}
      data-live={live ? 'true' : undefined}
      data-pinned={row.pinned ? 'true' : undefined}
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
      <span
        className={styles.dragHandle}
        draggable={!!onDragStart}
        onDragStart={(event) => {
          event.stopPropagation();
          contextMenu.close();
          if (ref.current) event.dataTransfer.setDragImage?.(ref.current, 16, 14);
          onDragStart?.(event);
        }}
        onDragEnd={onDragEnd}
        onClick={(event) => event.stopPropagation()}
        title={sortingDisabledReason ?? t('contextMenu.sidebar.dragSession')}
        aria-label={t('contextMenu.sidebar.dragSession')}
      ><GripVertical size={11} /></span>
      <span
        className={styles.activitySlot}
        title={[activity, row.pinned ? t('sessionWorkbenchUi.sidebar.pinned') : ''].filter(Boolean).join(' · ')}
      >
        {live?.working
          ? <OrbIndicator size={14} variant="expanding" />
          : row.pinned ? <Pin size={10} aria-hidden /> : null}
      </span>

      <span className={styles.rowLabel} title={row.label}>{row.label}</span>

      <span className={styles.dotSlot} data-unread={unread || undefined} aria-hidden />
      <div className={styles.rowMeta}>
        <MessageTime timestamp={row.messages?.latestMessage?.timestamp} />
        <Tooltip title={pinLabel}>
          <button
            type="button"
            className={styles.rowPin}
            aria-label={pinLabel}
            onClick={(event) => {
              event.stopPropagation();
              onMenuAction(pinKey, row);
            }}
          >
            {row.pinned ? <PinOff size={13} /> : <Pin size={13} />}
          </button>
        </Tooltip>
      </div>

      <span className={styles.rowMenu}>
        <MenuButton
          items={items}
          onSelect={selectMenu}
          ariaLabel={live
            ? t('sessionWorkbenchUi.sidebar.taskActions')
            : t('sessionWorkbenchUi.sidebar.historyActions')}
        />
      </span>
      {contextMenu.menu}
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

/** 每组默认露出的未置顶条数；置顶项始终可见 */
const GROUP_PREVIEW_LIMIT = 5;

const Group = memo<GroupProps>(({ group, selectedAgentId, onSelect, menuSourceOf, onMenuAction,
  onNewSessionIn, searching, dropEdge, dragging, onDragStart, onDragOver, onDrop, onDragEnd,
  onMoveThread, sortingDisabledReason, groupMenuItems, onGroupMenuAction }) => {
  const { t } = useTranslation();
  const expandedGroups = useUIStore((store) => store.expandedWorkspaceGroups);
  const toggleWorkspaceGroup = useUIStore((store) => store.toggleWorkspaceGroup);
  const open = searching || expandedGroups.includes(group.key);
  const manual = useUIStore((store) => store.workspaceSessionSort[group.key]?.mode === 'manual');
  const contextMenu = useContextMenu({
    items: groupMenuItems?.(group) ?? [],
    onSelect: (key) => onGroupMenuAction?.(key, group),
    ariaLabel: t('contextMenu.sidebar.workspaceMenuLabel'),
  });
  const [source, setSource] = useState<ThreadRow | null>(null);
  const [rowDrop, setRowDrop] = useState<{ id: string; edge: WorkspaceDropEdge } | null>(null);
  const clearRowDrag = () => { setSource(null); setRowDrop(null); };

  const [showAll, setShowAll] = useState(false);
  let unpinnedSeen = 0;
  const previewRows = group.rows.filter((row) => {
    if (row.pinned) return true;
    unpinnedSeen += 1;
    return unpinnedSeen <= GROUP_PREVIEW_LIMIT || row.agentId === selectedAgentId;
  });
  const hiddenCount = group.rows.length - previewRows.length;
  const visibleRows = showAll || searching ? group.rows : previewRows;
  const positions = new Map(group.rows.map((row, index) => [row.agentId, index]));

  return (
    <section
      className={styles.group}
      data-open={open ? 'true' : undefined}
      data-drop-edge={dropEdge}
      data-dragging={dragging || undefined}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setRowDrop(null);
      }}
    >
      <div className={styles.groupHead} onContextMenu={contextMenu.onContextMenu} data-context-menu={contextMenu.menu ? 'true' : undefined}>
        <span
          className={styles.dragHandle}
          draggable={!!onDragStart}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          title={sortingDisabledReason ?? t('contextMenu.sidebar.dragWorkspace')}
          aria-label={t('contextMenu.sidebar.dragWorkspace')}
        ><GripVertical size={11} /></span>
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
      {contextMenu.menu}

      {open &&
        visibleRows.map((row) => (
          <Row
            key={row.key}
            row={row}
            selected={row.agentId === selectedAgentId}
            onSelect={onSelect}
            menuSourceOf={menuSourceOf}
            onMenuAction={onMenuAction}
            manual={manual}
            canMoveUp={group.rows[positions.get(row.agentId)! - 1]?.pinned === row.pinned}
            canMoveDown={group.rows[positions.get(row.agentId)! + 1]?.pinned === row.pinned}
            sortingDisabledReason={sortingDisabledReason}
            dragging={source?.agentId === row.agentId}
            dropEdge={rowDrop?.id === row.agentId ? rowDrop.edge : undefined}
            onDragStart={onMoveThread ? (event) => {
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', row.agentId);
              setSource(row);
            } : undefined}
            onDragOver={(event) => {
              if (!source || !onMoveThread) return;
              event.stopPropagation();
              if (source.agentId === row.agentId || source.pinned !== row.pinned) { setRowDrop(null); return; }
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setRowDrop({ id: row.agentId, edge: dragEdge(event) });
            }}
            onDrop={(event) => {
              if (!source || !onMoveThread) return;
              event.stopPropagation();
              event.preventDefault();
              onMoveThread(group.key, source.agentId, row.agentId, dragEdge(event));
              clearRowDrag();
            }}
            onDragEnd={clearRowDrag}
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

  if (groups.length === 0) {
    return <div className={styles.empty}>{t(rest.searching ? 'sessionWorkbenchUi.sidebar.noMatches' : 'sessionWorkbenchUi.sidebar.empty')}</div>;
  }

  return (
    <div onDragOverCapture={(event) => {
      const scroll = event.currentTarget.closest<HTMLElement>('[data-workspace-scroll]');
      if (!scroll) return;
      const rect = scroll.getBoundingClientRect();
      if (event.clientY < rect.top + 32) scroll.scrollTop -= 16;
      else if (event.clientY > rect.bottom - 32) scroll.scrollTop += 16;
    }} onDragLeave={(event) => {
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
            const head = event.currentTarget.closest('section')?.querySelector<HTMLElement>(`.${styles.groupHead}`);
            if (head) event.dataTransfer.setDragImage?.(head, 16, 12);
            setSource(group.key);
          } : undefined}
          onDragOver={(event) => {
            if (!onMoveGroup || source === null) return;
            if (source === group.key) { setDrop(null); return; }
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            setDrop({ key: group.key, edge: dragEdge(event) });
          }}
          onDrop={(event) => {
            if (!onMoveGroup || source === null) return;
            event.preventDefault();
            onMoveGroup(source, group.key, dragEdge(event));
            clearDrag();
          }}
          onDragEnd={clearDrag}
        />
      ))}
    </div>
  );
});

WorkspaceTree.displayName = 'WorkspaceTree';

function dragEdge(event: DragEvent<HTMLElement>): WorkspaceDropEdge {
  const rect = event.currentTarget.getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}
