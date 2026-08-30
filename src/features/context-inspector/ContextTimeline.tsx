import {
  memo,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { ContextLedgerRow } from './ledger-projection';
import { formatRequestTokenCheckpoint } from './format-request-token-checkpoint';
import {
  contextTimelineKind,
  contextTimelineLane,
  normalizeContextTimelineRange,
  type ContextTimelineRange,
} from './context-timeline';
import styles from './context-inspector.module.css';

const MINIMUM_DRAG_PX = 3;

interface TimelineHover {
  readonly fraction: number;
  readonly rowIndex: number | null;
}

interface TimelineDrag {
  readonly pointerId: number;
  readonly anchorClientX: number;
  readonly anchorTime: number;
  readonly rowIndex: number | null;
}

export const ContextTimeline = memo(function ContextTimeline({
  rows,
  range,
  selectedKey,
  matchKeys = null,
  onRangeChange,
  onSelect,
}: {
  readonly rows: readonly ContextLedgerRow[];
  readonly range: ContextTimelineRange | null;
  readonly selectedKey: string | null;
  readonly matchKeys?: ReadonlySet<string> | null;
  readonly onRangeChange: (range: ContextTimelineRange | null) => void;
  readonly onSelect: (row: ContextLedgerRow) => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const dragRef = useRef<TimelineDrag | null>(null);
  const [draft, setDraft] = useState<ContextTimelineRange | null>(null);
  const [hover, setHover] = useState<TimelineHover | null>(null);
  const rowCount = rows.length;
  const selectedIndex = rows.findIndex((row) => row.key === selectedKey);
  const activeRange = normalizeContextTimelineRange(draft ?? range, rowCount);
  const boundaries = useMemo(() => rows.flatMap((row, index) => (
    index > 0 && row.kind !== rows[index - 1]?.kind ? [index] : []
  )), [rows]);

  const fractionAt = (event: PointerEvent<HTMLDivElement>): number => {
    const rect = event.currentTarget.getBoundingClientRect();
    return clampFraction((event.clientX - rect.left) / Math.max(1, rect.width));
  };

  const timeAt = (event: PointerEvent<HTMLDivElement>): number => (
    fractionAt(event) * rowCount
  );

  const rowIndexAt = (event: PointerEvent<HTMLDivElement>): number | null => {
    const target = event.target instanceof Element ? event.target : null;
    const value = target
      ?.closest<HTMLElement>('[data-context-timeline-record-index]')
      ?.dataset.contextTimelineRecordIndex;
    if (value === undefined) return null;
    const index = Number(value);
    return Number.isInteger(index) ? index : null;
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || rowCount === 0) return;
    const fraction = fractionAt(event);
    const anchorTime = fraction * rowCount;
    const rowIndex = rowIndexAt(event);
    dragRef.current = {
      pointerId: event.pointerId,
      anchorClientX: event.clientX,
      anchorTime,
      rowIndex,
    };
    setHover({ fraction, rowIndex });
    setDraft({ start: anchorTime, end: anchorTime });
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const fraction = fractionAt(event);
    setHover({ fraction, rowIndex: rowIndexAt(event) });
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    setDraft(orderedRange(drag.anchorTime, fraction * rowCount));
  };

  const handlePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const pointTime = timeAt(event);
    const click = Math.abs(event.clientX - drag.anchorClientX) < MINIMUM_DRAG_PX;
    dragRef.current = null;
    setDraft(null);
    setHover({ fraction: fractionAt(event), rowIndex: rowIndexAt(event) });

    if (click && drag.rowIndex !== null) {
      const row = rows[drag.rowIndex];
      if (row !== undefined) {
        onRangeChange(null);
        onSelect(row);
      }
      return;
    }

    const selection = orderedRange(drag.anchorTime, pointTime);
    const nextRange = selection.end - selection.start < 1
      ? centeredRange(click ? selection.start : (selection.start + selection.end) / 2, rowCount)
      : selection;
    onRangeChange(nextRange);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      if (range === null) return;
      event.preventDefault();
      onRangeChange(null);
      return;
    }
    const edgeIndex = event.key === 'Home'
      ? 0
      : event.key === 'End' ? rowCount - 1 : null;
    const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    if (edgeIndex === null && direction === 0) return;
    event.preventDefault();
    const current = selectedIndex < 0 ? 0 : selectedIndex;
    const nextIndex = edgeIndex ?? Math.min(rowCount - 1, Math.max(0, current + direction));
    const row = rows[nextIndex];
    if (row === undefined) return;
    onRangeChange(null);
    onSelect(row);
  };

  const cancelPointer = () => {
    dragRef.current = null;
    setDraft(null);
    setHover(null);
  };

  const selectionStyle = activeRange === null ? undefined : {
    '--context-timeline-selection-left': `${activeRange.start / rowCount * 100}%`,
    '--context-timeline-selection-width': `${(activeRange.end - activeRange.start) / rowCount * 100}%`,
  } as CSSProperties;

  return (
    <section className={styles.timelineRoot} aria-label={t('contextUi.timeline.label')}>
      <div className={styles.timelinePlot}>
        <div className={styles.timelineLabels} aria-hidden="true">
          <span>{t('contextUi.timeline.input')}</span>
          <span>{t('contextUi.timeline.model')}</span>
          <span>{t('contextUi.timeline.tool')}</span>
        </div>
        <div
          className={styles.timelineTrack}
          data-context-timeline-track
          aria-label={t('contextUi.timeline.interactionAria')}
          tabIndex={0}
          onKeyDown={handleKeyDown}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={cancelPointer}
          onPointerLeave={() => {
            if (dragRef.current === null) setHover(null);
          }}
          onDoubleClick={(event) => {
            event.preventDefault();
            onRangeChange(null);
          }}
        >
          {boundaries.map((index) => (
            <span
              key={index}
              className={styles.timelineBoundary}
              aria-hidden="true"
              style={{ '--context-timeline-boundary-left': `${index / rowCount * 100}%` } as CSSProperties}
            />
          ))}
          {hover !== null && hover.rowIndex === null && draft === null && (
            <span
              className={styles.timelineHoverLine}
              aria-hidden="true"
              style={{ '--context-timeline-hover-left': `${hover.fraction * 100}%` } as CSSProperties}
            />
          )}
          {activeRange !== null && (
            <>
              <span
                className={styles.timelineSelection}
                data-dragging={draft === null ? undefined : 'true'}
                aria-hidden="true"
                style={selectionStyle}
              />
              <span
                className={styles.timelineSelectionEdges}
                data-dragging={draft === null ? undefined : 'true'}
                aria-hidden="true"
                style={selectionStyle}
              />
            </>
          )}
          {selectedIndex >= 0 && (
            <span
              className={styles.timelineCursor}
              aria-hidden="true"
              style={{
                '--context-timeline-cursor-left': `${(selectedIndex + 0.5) / rowCount * 100}%`,
              } as CSSProperties}
            />
          )}
          <div className={styles.timelineLanes} aria-hidden="true">
            {rows.map((row, index) => {
              const left = index / rowCount * 100;
              const width = 100 / rowCount;
              const inRange = activeRange === null
                ? undefined
                : index < activeRange.end && index + 1 > activeRange.start;
              return (
                <span
                  key={row.key}
                  className={styles.timelineSpan}
                  data-context-timeline-record-index={index}
                  data-kind={contextTimelineKind(row)}
                  data-current={row.key === selectedKey || undefined}
                  data-hovered={hover?.rowIndex === index || undefined}
                  data-in-range={inRange === undefined ? undefined : String(inRange)}
                  data-search-match={matchKeys === null
                    ? undefined
                    : matchKeys.has(row.key) ? 'true' : 'false'}
                  title={timelineSpanTitle(row, index, t, locale)}
                  style={{
                    '--context-timeline-span-left': `${left}%`,
                    '--context-timeline-span-width': `${width}%`,
                    '--context-timeline-span-gap': `min(${width * 0.08}%, 1px)`,
                    '--context-timeline-span-lane': contextTimelineLane(row),
                  } as CSSProperties}
                />
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
});

function orderedRange(left: number, right: number): ContextTimelineRange {
  return left <= right ? { start: left, end: right } : { start: right, end: left };
}

function centeredRange(center: number, rowCount: number): ContextTimelineRange {
  const start = Math.min(Math.max(center - 0.5, 0), Math.max(0, rowCount - 1));
  return { start, end: Math.min(rowCount, start + 1) };
}

function clampFraction(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function timelineKindLabel(row: ContextLedgerRow, translate: (key: string) => string): string {
  switch (contextTimelineKind(row)) {
    case 'system': return translate('contextUi.timeline.system');
    case 'tool': return translate('contextUi.timeline.toolDefinition');
    case 'assistant': return translate('contextUi.timeline.assistant');
    case 'result': return translate('contextUi.timeline.toolResult');
    case 'user': return translate('contextUi.timeline.user');
  }
}

function timelineSpanTitle(
  row: ContextLedgerRow,
  index: number,
  translate: (key: string) => string,
  locale: string,
): string {
  const checkpoint = row.kind === 'message' && row.inputTokens !== undefined
    ? formatRequestTokenCheckpoint(row.inputTokens, row.inputTokenDelta, locale)
    : null;
  return [
    String(index).padStart(3, '0'),
    timelineKindLabel(row, translate),
    row.title,
    checkpoint,
  ].filter((value) => value !== null).join(' · ');
}
