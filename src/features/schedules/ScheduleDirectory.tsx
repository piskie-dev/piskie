import { useState } from 'react';
import { AlertTriangle, CalendarClock, CheckCircle2, ChevronDown, ChevronRight, Clock, Pause, Plus, RefreshCw, Repeat, Search, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { TaskDefinitionSnapshot } from '@shared/electron-contracts/task-definitions';
import type { ScheduleView } from '@shared/types/schedules';
import { describeSuspension, describeTrigger, formatRelativeDateTime } from './format';
import {
  DIRECTORY_GROUPS,
  directoryGroup,
  matchesQuery,
  type DirectoryGroup,
} from './schedule-presenter';
import styles from './schedules.module.css';

export interface ScheduleDirectoryProps {
  readonly items: readonly ScheduleView[];
  readonly definitions: readonly TaskDefinitionSnapshot[];
  readonly now: Date;
  readonly locale: string;
  readonly selectedId: string | null;
  readonly query: string;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly onQuery: (query: string) => void;
  readonly onSelect: (scheduleId: string | null) => void;
  readonly onDelete: (scheduleId: string) => void;
  readonly onCreate: () => void;
  readonly onRefresh: () => void;
}

export function ScheduleDirectory(props: ScheduleDirectoryProps) {
  const { t } = useTranslation();
  const { items, now, locale } = props;
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<DirectoryGroup>>(() => new Set());
  const visible = items.filter((view) => matchesQuery(view, props.query, props.definitions));
  const grouped = new Map<DirectoryGroup, ScheduleView[]>();
  for (const view of visible) {
    const group = directoryGroup(view);
    const bucket = grouped.get(group);
    if (bucket) bucket.push(view);
    else grouped.set(group, [view]);
  }

  return (
    <aside className={styles.directory} aria-label={t('schedulesUi.directory')}>
      <header className={styles.directoryHeader}>
        <h1>{t('schedulesUi.title')}</h1>
        <span className={styles.count}>{items.length}</span>
        <div className={styles.directoryActions}>
          <button
            type="button"
            className={styles.iconButton}
            disabled={props.loading}
            onClick={props.onRefresh}
            aria-label={t('common.refresh')}
            title={t('common.refresh')}
          >
            <RefreshCw size={16} />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            onClick={props.onCreate}
            aria-label={t('schedulesUi.create')}
            title={t('schedulesUi.create')}
          >
            <Plus size={16} />
          </button>
        </div>
      </header>
      <label className={styles.search}>
        <Search size={14} />
        <input
          value={props.query}
          onChange={(event) => props.onQuery(event.target.value)}
          placeholder={t('schedulesUi.search')}
          aria-label={t('schedulesUi.search')}
        />
      </label>
      <nav className={styles.list}>
        <button
          type="button"
          className={`${styles.item} ${styles.itemAll}`}
          aria-current={props.selectedId === null ? 'true' : undefined}
          onClick={() => props.onSelect(null)}
        >
          <span className={styles.itemIcon}><CalendarClock size={16} /></span>
          <span className={styles.itemText}>
            <strong>{t('schedulesUi.all')}</strong>
            <small>{t('schedulesUi.allSummary', { count: items.length })}</small>
          </span>
        </button>
        {DIRECTORY_GROUPS.map((group) => {
          const bucket = grouped.get(group);
          if (!bucket || bucket.length === 0) return null;
          const collapsible = group === 'active' || group === 'fired';
          const collapsed = collapsible && collapsedGroups.has(group);
          const groupItemsId = `schedule-directory-group-${group}`;
          return (
            <div key={group}>
              {collapsible ? (
                <button
                  type="button"
                  className={`${styles.group} ${styles.groupToggle}`}
                  aria-expanded={!collapsed}
                  aria-controls={groupItemsId}
                  onClick={() => {
                    setCollapsedGroups((current) => {
                      const next = new Set(current);
                      if (next.has(group)) next.delete(group);
                      else next.add(group);
                      return next;
                    });
                  }}
                >
                  <span>{t(`schedulesUi.group.${group}`)}</span>
                  <span className={styles.groupTrailing}>
                    <span>{bucket.length}</span>
                    {collapsed ? <ChevronRight size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
                  </span>
                </button>
              ) : (
                <div className={styles.group}>
                  <span>{t(`schedulesUi.group.${group}`)}</span>
                  <span>{bucket.length}</span>
                </div>
              )}
              <div id={groupItemsId} hidden={collapsed}>
                {bucket.map((view) => {
                  const { schedule, state } = view;
                  const dim = group === 'paused' || group === 'fired';
                  const iconTone = state.suspended ? 'err' : undefined;
                  const Icon = state.suspended
                    ? AlertTriangle
                    : state.firedAt
                      ? CheckCircle2
                      : !schedule.enabled
                        ? Pause
                        : schedule.trigger.kind === 'once'
                          ? Clock
                          : Repeat;
                  const hint = state.suspended
                    ? describeSuspension(state.suspended, t)
                    : state.consecutiveFailures > 0
                      ? t('schedulesUi.itemHint.lastFailed')
                      : state.firedAt
                        ? t('schedulesUi.itemHint.firedAt', { time: formatRelativeDateTime(new Date(state.firedAt), now, locale, t) })
                        : !schedule.enabled
                          ? t('schedulesUi.itemHint.paused')
                          : view.nextRunAt
                            ? t('schedulesUi.itemHint.next', { time: formatRelativeDateTime(new Date(view.nextRunAt), now, locale, t) })
                            : t('schedulesUi.noNextRun');
                  const dotTone = state.consecutiveFailures > 0 && !state.suspended ? 'err' : undefined;
                  return (
                    <div
                      key={schedule.scheduleId}
                      className={styles.itemRow}
                    >
                      <button
                        type="button"
                        className={`${styles.item} ${dim ? styles.itemDim : ''}`}
                        aria-current={props.selectedId === schedule.scheduleId ? 'true' : undefined}
                        onClick={() => props.onSelect(schedule.scheduleId)}
                      >
                        <span className={styles.itemIcon} data-tone={iconTone}><Icon size={16} /></span>
                        <span className={styles.itemText}>
                          <strong>{schedule.name}</strong>
                          <small>{describeTrigger(schedule.trigger, now, locale, t)} · {hint}</small>
                        </span>
                        {dotTone && <span className={styles.itemDot} data-tone={dotTone} />}
                      </button>
                      <button
                        type="button"
                        className={styles.itemDelete}
                        disabled={props.busy}
                        onClick={() => props.onDelete(schedule.scheduleId)}
                        aria-label={t('schedulesUi.action.delete')}
                        title={t('schedulesUi.action.delete')}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
