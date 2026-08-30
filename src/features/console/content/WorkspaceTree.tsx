/**
 * WorkspaceTree —— 左栏会话树，dock 与 thread 共用。
 *
 * 两级：**工作区 → thread**。一个 thread = 一个 AgentRun，在跑的与历史的在**同一列表**里，
 * "在跑"只是行上的一个状态点 + 提亮，不是独立分区（理由见 `data/threadRows.ts`）。
 *
 * 行的两种语义必须能一眼分辨（硬要求：恢复 ≠ 新建）：
 *
 * | | 在跑 | 历史 |
 * |---|---|---|
 * | 前置 | 状态点 | 同宽空位（不留则文字错位） |
 * | 文字 | 常规色 | 弱化色 |
 * | 右侧 | worker 数（>0 才出） | 无 |
 * | 点击 | 选中该会话 | 恢复该记录（后端懒恢复） |
 * | `···` | 工作区 / 追踪 / 暂停 / 停止 | 打开 / 追踪 / 删除 |
 *
 * **worker 不进左栏**——它短命、数量不定，改由主屏 agent tab 承载。
 * 分组与排序全在 `data/workspaceGroups` + `data/threadRows`（纯函数 + 单测），本组件只渲染。
 *
 * 长列表两道闸：
 * - 折叠态持久化（uiStore），默认展开、只记被折叠的组；
 * - 每组默认只列前 {@link GROUP_PREVIEW_LIMIT} 条，尾行「还有 N 条」点开全量
 *   （会话级临时态；选中项藏在隐藏区时自动全显，不让当前会话凭空消失）。
 */

import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, FolderOpen, History, Pause, Plus, Square, Trash2 } from 'lucide-react';

import { useUIStore } from '../../../store/uiStore';

import { MenuButton } from '../chrome/MenuButton';
import { StatusBadge } from '../chrome/StatusBadge';
import { Tooltip } from '../chrome/Tooltip';
import {
  buildHistoryMenu,
  buildSessionMenu,
  type SessionMenuKey,
  type SessionMenuSource,
} from '../data/sessionMenu';
import type { ThreadRow } from '../data/threadRows';
import type { WorkspaceGroup } from '../data/workspaceGroups';
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

export type ThreadMenuKey = SessionMenuKey | 'open' | 'delete';

export interface WorkspaceTreeProps {
  readonly groups: readonly WorkspaceGroup[];
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
  const live = row.live;
  const activity = live
    ? resolvePresentationText(live.activity.text, (key, values) => t(key, values ?? {}))
    : undefined;

  const items = live
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

  return (
    <div
      className={styles.row}
      data-live={live ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(row)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(row);
        }
      }}
      title={activity ?? row.label}
    >
      {live ? <StatusBadge status={live.status} dotOnly /> : <span className={styles.dotSlot} />}

      <span className={styles.rowLabel}>{row.label}</span>

      {live && live.workerCount > 0 && <span className={styles.rowMeta}>{live.workerCount}</span>}

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

interface GroupProps extends Omit<WorkspaceTreeProps, 'groups'> {
  readonly group: WorkspaceGroup;
}

/** 每组默认露出的条数；在跑的排最前，天然不会被藏 */
const GROUP_PREVIEW_LIMIT = 5;

const Group = memo<GroupProps>(({ group, selectedAgentId, onSelect, menuSourceOf, onMenuAction, onNewSessionIn }) => {
  const { t } = useTranslation();
  const collapsed = useUIStore((store) => store.collapsedWorkspaceGroups);
  const toggleWorkspaceGroup = useUIStore((store) => store.toggleWorkspaceGroup);
  const open = !collapsed.includes(group.key);
  const toggle = useCallback(() => toggleWorkspaceGroup(group.key), [group.key, toggleWorkspaceGroup]);

  const [showAll, setShowAll] = useState(false);
  const hidden = group.rows.slice(GROUP_PREVIEW_LIMIT);
  // 选中的会话藏在截断区时强制全显——列表里凭空找不到当前会话是最糟的形态
  const expanded =
    showAll || hidden.length === 0 || hidden.some((row) => row.agentId === selectedAgentId);
  const visibleRows = expanded ? group.rows : group.rows.slice(0, GROUP_PREVIEW_LIMIT);

  return (
    <section className={styles.group} data-open={open ? 'true' : undefined}>
      <div className={styles.groupHead}>
        <button type="button" className={styles.groupToggle} onClick={toggle} aria-expanded={open}>
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
          {/* 计数含全部 thread，不只在跑的 */}
          <span className={styles.groupCount}>{group.rows.length}</span>
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

      {open && !expanded && (
        <button type="button" className={styles.moreRow} onClick={() => setShowAll(true)}>
          {t('sessionWorkbenchUi.sidebar.moreRows', { count: hidden.length })}
        </button>
      )}
    </section>
  );
});

Group.displayName = 'WorkspaceGroup';

export const WorkspaceTree = memo<WorkspaceTreeProps>(({ groups, ...rest }) => {
  const { t } = useTranslation();
  if (groups.length === 0) {
    return <div className={styles.empty}>{t('sessionWorkbenchUi.sidebar.empty')}</div>;
  }

  return (
    <>
      {groups.map((group) => (
        <Group key={group.key} group={group} {...rest} />
      ))}
    </>
  );
});

WorkspaceTree.displayName = 'WorkspaceTree';
