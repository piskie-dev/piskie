import { ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { TaskDefinitionSnapshot } from '@shared/electron-contracts/task-definitions';
import type { ScheduleFireRecord, ScheduleView } from '@shared/types/schedules';
import { describeOutcome, formatDayHeading, formatTime, formatTimeWithSeconds } from './format';
import { dayKey } from './local-days';
import { fireTone, recordAgentId, templateOf, type LiveStates } from './schedule-presenter';
import styles from './schedules.module.css';

export interface HistoryViewProps {
  readonly records: readonly ScheduleFireRecord[];
  readonly items: readonly ScheduleView[];
  readonly definitions: readonly TaskDefinitionSnapshot[];
  readonly live: LiveStates;
  readonly now: Date;
  readonly locale: string;
  /** 「全部任务」下每条前面带任务名。 */
  readonly showNames: boolean;
  readonly loading: boolean;
  readonly onLoadMore: () => void;
  readonly onOpenRun: (agentId: string) => void;
}

export function HistoryView(props: HistoryViewProps) {
  const { t } = useTranslation();
  const { locale, now } = props;
  const viewsById = new Map(props.items.map((view) => [view.schedule.scheduleId, view]));
  const sorted = [...props.records].sort((left, right) => Date.parse(right.firedAt) - Date.parse(left.firedAt));
  const days = new Map<string, ScheduleFireRecord[]>();
  for (const record of sorted) {
    const key = dayKey(new Date(record.firedAt));
    const bucket = days.get(key);
    if (bucket) bucket.push(record);
    else days.set(key, [record]);
  }

  return (
    <div className={styles.timeline}>
      {sorted.length === 0 && !props.loading && (
        <div className={styles.empty}><p>{t('schedulesUi.history.empty')}</p></div>
      )}
      {[...days.entries()].map(([key, bucket]) => {
        const heading = formatDayHeading(new Date(bucket[0]!.firedAt), now, locale, t);
        return (
          <section key={key}>
            <div className={styles.timelineDay}>
              <h3>{heading.title}</h3>
              <span>{heading.subtitle}</span>
            </div>
            {bucket.map((record) => {
              const tone = fireTone(record);
              const agentId = recordAgentId(record);
              const runIsLive = agentId ? Boolean(props.live[agentId]) : false;
              const view = viewsById.get(record.scheduleId);
              const planned = new Date(record.manual ? record.firedAt : record.scheduledFor);
              const meta = describeRecord(record, view, props.definitions, t);
              return (
                <div key={`${record.scheduleId}-${record.firedAt}`} className={styles.trow} data-tone={tone}>
                  <div className={styles.trowTime}>
                    {formatTime(planned, locale)}
                    <small>{t('schedulesUi.history.actual', { time: formatTimeWithSeconds(new Date(record.firedAt), locale) })}</small>
                  </div>
                  <div className={styles.trowRail}><i /></div>
                  <div className={styles.trowMain}>
                    <strong>
                      {props.showNames && <span>{view?.schedule.name ?? record.scheduleId}</span>}
                      <span className={styles.chip} data-tone={tone}>{describeOutcome(record.outcome, t)}</span>
                      {record.manual && <span className={styles.chip} data-tone="plain">{t('schedulesUi.outcome.manual')}</span>}
                    </strong>
                    {meta && <div className={styles.trowMeta}><span>{meta}</span></div>}
                  </div>
                  <div className={styles.trowTail}>
                    {agentId && (runIsLive ? (
                      <button
                        type="button"
                        className={styles.link}
                        onClick={() => props.onOpenRun(agentId)}
                        title={t('schedulesUi.history.openRun')}
                      >
                        <code>{agentId}</code>
                        <ExternalLink size={12} />
                      </button>
                    ) : (
                      <span className={`${styles.link} ${styles.muted}`} title={t('schedulesUi.history.runGone')}>
                        <code>{agentId}</code>
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </section>
        );
      })}
      <div className={styles.loadMore}>
        <button type="button" className={`${styles.button} ${styles.ghost}`} disabled={props.loading} onClick={props.onLoadMore}>
          {t('schedulesUi.history.loadMore')}
        </button>
      </div>
    </div>
  );
}

function describeRecord(
  record: ScheduleFireRecord,
  view: ScheduleView | undefined,
  definitions: readonly TaskDefinitionSnapshot[],
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  const { outcome } = record;
  if (outcome.kind === 'failed') {
    return `${t(`schedulesUi.outcome.stage.${outcome.stage}`)} · ${outcome.message}`;
  }
  if (outcome.kind === 'skipped' || !view) return null;
  const { action } = view.schedule;
  if (action.kind === 'inject') return t('schedulesUi.target.inject');
  if (action.launch.kind === 'inline') {
    return `${t('schedulesUi.target.inline')} · ${t(`schedulesUi.approval.${action.launch.approvalMode}`)}`;
  }
  const template = templateOf(view, definitions);
  if (!template) return t('schedulesUi.target.templateMissing');
  return `${t('schedulesUi.target.template', { name: template.name })} · ${t(`schedulesUi.approval.${template.defaultApprovalMode}`)}`;
}
