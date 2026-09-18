import { Bot, CalendarClock, Clock, Pause, Pencil, Play, Plus, Repeat, Trash2, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { TaskDefinitionSnapshot } from '@shared/electron-contracts/task-definitions';
import type { ScheduleView } from '@shared/types/schedules';
import { describeTrigger, formatRelativeDateTime } from './format';
import { scheduleStatus, templateOf, type ScheduleStatus } from './schedule-presenter';
import type { WeekSummary } from './slot-grid-model';
import styles from './schedules.module.css';

const STATUS_TONE: Record<ScheduleStatus, 'ok' | 'err' | 'plain'> = {
  active: 'ok',
  suspended: 'err',
  paused: 'plain',
  fired: 'plain',
};

export interface ScheduleHeadProps {
  readonly view: ScheduleView | null;
  readonly items: readonly ScheduleView[];
  readonly definitions: readonly TaskDefinitionSnapshot[];
  readonly now: Date;
  readonly locale: string;
  readonly summary: WeekSummary;
  readonly attentionCount: number;
  readonly busy: boolean;
  readonly onRunNow: () => void;
  readonly onToggleEnabled: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
  readonly onCreate: () => void;
}

export function ScheduleHead(props: ScheduleHeadProps) {
  const { t } = useTranslation();
  const { view, now, locale } = props;

  if (!view) {
    return (
      <div className={styles.head}>
        <div className={styles.avatar}><CalendarClock size={18} /></div>
        <div className={styles.headText}>
          <div className={styles.headTitle}>
            <h2>{t('schedulesUi.all')}</h2>
            <span className={styles.chip} data-tone="plain">{t('schedulesUi.allSummary', { count: props.items.length })}</span>
            {props.attentionCount > 0 && (
              <span className={styles.chip} data-tone="err">{t('schedulesUi.attentionCount', { count: props.attentionCount })}</span>
            )}
          </div>
          <div className={styles.meta}>
            <span>{t('schedulesUi.weekSummary', { ...props.summary })}</span>
            <span className={styles.sep}>·</span>
            <span>{t('schedulesUi.clickHint')}</span>
          </div>
        </div>
        <div className={styles.headActions}>
          <button type="button" className={`${styles.button} ${styles.primary}`} onClick={props.onCreate}>
            <Plus size={14} />
            {t('schedulesUi.create')}
          </button>
        </div>
      </div>
    );
  }

  const { schedule, state } = view;
  const status = scheduleStatus(view);
  const template = templateOf(view, props.definitions);
  const target = schedule.action.kind === 'inject'
    ? t('schedulesUi.target.inject')
    : schedule.action.launch.kind === 'inline'
      ? t('schedulesUi.target.inline')
      : template
        ? t('schedulesUi.target.template', { name: template.name })
        : t('schedulesUi.target.templateMissing');
  const Icon = state.suspended || !schedule.enabled ? Pause : schedule.trigger.kind === 'once' ? Clock : Repeat;

  return (
    <div className={styles.head}>
      <div className={styles.avatar}><Icon size={18} /></div>
      <div className={styles.headText}>
        <div className={styles.headTitle}>
          <h2>{schedule.name}</h2>
          <span className={styles.chip} data-tone={STATUS_TONE[status]}>{t(`schedulesUi.status.${status}`)}</span>
        </div>
        <div className={styles.meta}>
          <span>{describeTrigger(schedule.trigger, now, locale, t)}</span>
          {schedule.trigger.kind === 'cron' && <code className={styles.muted}>{schedule.trigger.expression}</code>}
          <span className={styles.sep}>·</span>
          <Bot size={12} />
          <span>{target}</span>
          <span className={styles.sep}>·</span>
          <span>{t(schedule.runIfMissed ? 'schedulesUi.missed.run' : 'schedulesUi.missed.skip')}</span>
          <span className={styles.sep}>·</span>
          <span>
            {view.nextRunAt
              ? t('schedulesUi.nextRun', { time: formatRelativeDateTime(new Date(view.nextRunAt), now, locale, t) })
              : t('schedulesUi.noNextRun')}
          </span>
          <span className={styles.sep}>·</span>
          <span>{t(schedule.createdBy.kind === 'user' ? 'schedulesUi.creator.user' : 'schedulesUi.creator.agent')}</span>
        </div>
      </div>
      <div className={styles.headActions}>
        <button type="button" className={styles.button} disabled={props.busy} onClick={props.onRunNow}>
          <Zap size={14} />
          {t('schedulesUi.action.runNow')}
        </button>
        <button type="button" className={`${styles.button} ${styles.ghost}`} disabled={props.busy} onClick={props.onToggleEnabled}>
          {schedule.enabled && !state.suspended ? <Pause size={14} /> : <Play size={14} />}
          {t(schedule.enabled && !state.suspended ? 'schedulesUi.action.pause' : 'schedulesUi.action.resume')}
        </button>
        <button type="button" className={`${styles.button} ${styles.ghost}`} disabled={props.busy} onClick={props.onEdit}>
          <Pencil size={14} />
          {t('schedulesUi.action.edit')}
        </button>
        <button
          type="button"
          className={`${styles.button} ${styles.ghost} ${styles.danger}`}
          disabled={props.busy}
          onClick={props.onDelete}
          aria-label={t('schedulesUi.action.delete')}
          title={t('schedulesUi.action.delete')}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}
