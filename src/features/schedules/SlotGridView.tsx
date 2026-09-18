import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';

import { describeCron, describeOutcome, formatDateShort, formatTime, formatWeekdayShort } from './format';
import type { FireTone } from './schedule-presenter';
import {
  type BandEntry,
  type SlotEntry,
  type SlotGridModel,
  type SlotRow,
} from './slot-grid-model';
import styles from './schedules.module.css';
import type { ScheduleView } from '@shared/types/schedules';

export interface SlotGridViewProps {
  readonly model: SlotGridModel;
  readonly items: readonly ScheduleView[];
  readonly selectedId: string | null;
  readonly now: Date;
  readonly locale: string;
  readonly onPick: (scheduleId: string) => void;
}

const LEGEND: readonly { tone: string; key: string }[] = [
  { tone: 'ok', key: 'ok' },
  { tone: 'err', key: 'err' },
  { tone: 'skip', key: 'skip' },
  { tone: 'future', key: 'future' },
  { tone: 'paused', key: 'paused' },
  { tone: 'fold', key: 'fold' },
];

export function SlotGridView(props: SlotGridViewProps) {
  const { t } = useTranslation();
  const { model, selectedId, locale, now } = props;
  // 选中任务后保留完整周视图，用淡化提供上下文并突出当前任务。
  const filtering = selectedId !== null;
  const cronOf = new Map(props.items.map((view) => [view.schedule.scheduleId, view.schedule.trigger]));

  const rows = model.rows;
  const showBand = model.band.some((cell) => cell.length > 0);
  const nowIndex = model.nowRowIndex;
  const summary = selectedId ? (model.summaryByScheduleId[selectedId] ?? { started: 0, failed: 0, skipped: 0, future: 0 }) : model.summary;

  const renderEntry = (entry: SlotEntry, showTime: boolean) => {
    const highlighted = selectedId !== null && entry.scheduleId === selectedId;
    const detail = entry.kind === 'past'
      ? describeOutcome(entry.record.outcome, t)
      : entry.paused
        ? t('schedulesUi.grid.foldPaused')
        : entry.once
          ? t('schedulesUi.form.once')
          : t('schedulesUi.legend.future');
    return (
      <button
        key={`${entry.scheduleId}-${entry.at.getTime()}-${entry.kind}`}
        type="button"
        className={styles.ev}
        data-kind={entry.kind}
        data-tone={entry.kind === 'past' ? entry.tone : undefined}
        data-once={entry.kind === 'future' && entry.once ? '' : undefined}
        data-paused={entry.kind === 'future' && entry.paused ? '' : undefined}
        data-hl={highlighted ? '' : undefined}
        onClick={() => props.onPick(entry.scheduleId)}
      >
        <i />
        <div>
          {showTime && <span className={styles.evTime}>{formatTime(entry.at, locale)}</span>}
          <strong>{entry.name}</strong>
          <small>{detail}</small>
        </div>
      </button>
    );
  };

  const renderBand = (entry: BandEntry) => {
    const trigger = cronOf.get(entry.scheduleId);
    const cadence = trigger?.kind === 'cron' ? describeCron(trigger.expression, t) : entry.name;
    const highlighted = selectedId !== null && entry.scheduleId === selectedId;
    const headline = entry.past === 0
      ? t('schedulesUi.grid.foldFuture', { cadence, count: entry.future })
      : entry.future === 0
        ? t('schedulesUi.grid.foldTotal', { cadence, count: entry.total })
        : t('schedulesUi.grid.foldMixed', { cadence, past: entry.past, future: entry.future });
    const parts: string[] = [];
    if (entry.tones.ok > 0) parts.push(`${entry.tones.ok} ${t('schedulesUi.legend.ok')}`);
    if (entry.tones.err > 0) parts.push(`${entry.tones.err} ${t('schedulesUi.legend.err')}`);
    if (entry.tones.skip > 0) parts.push(`${entry.tones.skip} ${t('schedulesUi.legend.skip')}`);
    if (entry.paused) parts.push(t('schedulesUi.grid.foldPaused'));
    const dominant: FireTone | undefined = entry.tones.err > 0 ? 'err' : entry.tones.ok > 0 ? 'ok' : entry.tones.skip > 0 ? 'skip' : undefined;
    return (
      <button
        key={entry.scheduleId}
        type="button"
        className={styles.ev}
        data-kind={entry.past === 0 ? 'future' : 'past'}
        data-tone={dominant}
        data-paused={entry.paused && entry.past === 0 ? '' : undefined}
        data-hl={highlighted ? '' : undefined}
        onClick={() => props.onPick(entry.scheduleId)}
      >
        <i />
        <div>
          <span className={styles.evCadence}>{headline}</span>
          <strong>{entry.name}</strong>
          {parts.length > 0 && <small>{parts.join(' · ')}</small>}
        </div>
      </button>
    );
  };

  const renderNowRow = () => (
    <Fragment key="now">
      <div className={styles.gridTime} data-now="">
        <span>{t('schedulesUi.grid.now')}</span>
      </div>
      {model.days.map((day) => (
        <div key={day.date.getTime()} className={styles.gridCell} data-now="" data-today={day.isToday ? '' : undefined}>
          {day.isToday && <span className={styles.nowMini}>{t('schedulesUi.grid.nowLine', { time: formatTime(now, locale) })}</span>}
        </div>
      ))}
    </Fragment>
  );

  const renderRow = (row: SlotRow) => {
    return (
      <Fragment key={row.minuteOfDay}>
        <div className={styles.gridTime}>
          <span>{formatTime(row.at, locale)}</span>
          <small>{t('schedulesUi.grid.entries', { count: row.count })}</small>
        </div>
        {row.cells.map((cell, index) => {
          const day = model.days[index]!;
          return (
            <div
              key={day.date.getTime()}
              className={styles.gridCell}
              data-today={day.isToday ? '' : undefined}
              data-weekend={day.isWeekend ? '' : undefined}
            >
              {cell.map((entry) => renderEntry(entry, false))}
            </div>
          );
        })}
      </Fragment>
    );
  };

  const empty = rows.length === 0 && !showBand;

  return (
    <div className={styles.view}>
      <div className={styles.slotGrid} data-filtering={filtering ? '' : undefined} role="grid" aria-label={t('schedulesUi.view.grid')}>
        <div className={`${styles.gridHead} ${styles.gridCorner}`}><span>{t('schedulesUi.grid.timeColumn')}</span></div>
        {model.days.map((day) => (
          <div
            key={day.date.getTime()}
            className={styles.gridHead}
            data-today={day.isToday ? '' : undefined}
            data-weekend={day.isWeekend ? '' : undefined}
          >
            <b>{formatWeekdayShort(day.date, locale)}</b>
            <span>{formatDateShort(day.date, locale)}</span>
            {day.isToday && <em>{t('schedulesUi.day.today')}</em>}
          </div>
        ))}
        {showBand && (
          <>
            <div className={styles.gridTime} data-band="">
              <span>{t('schedulesUi.grid.band')}</span>
            </div>
            {model.band.map((cell, index) => {
              const day = model.days[index]!;
              return (
                <div
                  key={day.date.getTime()}
                  className={styles.gridCell}
                  data-band=""
                  data-today={day.isToday ? '' : undefined}
                  data-weekend={day.isWeekend ? '' : undefined}
                >
                  {cell.map(renderBand)}
                </div>
              );
            })}
          </>
        )}
        {rows.map((row, index) => (
          <Fragment key={row.minuteOfDay}>
            {nowIndex === index && renderNowRow()}
            {renderRow(row)}
          </Fragment>
        ))}
        {nowIndex !== null && nowIndex >= rows.length && renderNowRow()}
      </div>
      {empty && <div className={styles.empty}><p>{t('schedulesUi.grid.empty')}</p></div>}
      <div className={styles.legend}>
        <span className={styles.kbd}>{t('schedulesUi.legend.title')}</span>
        {LEGEND.map((item) => (
          <span key={item.key} className={styles.legendItem}>
            <i className={styles.legendDot} data-tone={item.tone === 'ok' ? undefined : item.tone} />
            {t(`schedulesUi.legend.${item.key}`)}
          </span>
        ))}
        <span className={styles.legendSummary}>
          {selectedId
            ? t('schedulesUi.weekSummaryTask', { ...summary })
            : t('schedulesUi.weekSummary', { ...summary })}
        </span>
      </div>
    </div>
  );
}
