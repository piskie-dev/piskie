import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ContextLedgerRow } from './ledger-projection';
import { formatRequestTokenCheckpoint } from './format-request-token-checkpoint';
import styles from './context-inspector.module.css';

const ROW_HEIGHT = 30;
const OVERSCAN = 5;

export function ContextLedger({
  rows,
  selectedKey,
  timelineFocusKeys = null,
  onSelect,
}: {
  readonly rows: readonly ContextLedgerRow[];
  readonly selectedKey: string | null;
  readonly timelineFocusKeys?: ReadonlySet<string> | null;
  readonly onSelect: (row: ContextLedgerRow) => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const update = () => setViewportHeight(element.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (selectedKey === null) return;
    const index = rows.findIndex((row) => row.key === selectedKey);
    if (index < 0) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const top = index * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    if (top >= viewport.scrollTop && bottom <= viewport.scrollTop + viewport.clientHeight) return;
    scrollLedger(viewport, top - (viewport.clientHeight - ROW_HEIGHT) / 2);
  }, [rows, selectedKey]);

  useLayoutEffect(() => {
    if (timelineFocusKeys === null || timelineFocusKeys.size === 0) return;
    const indexes = rows.flatMap((row, index) => timelineFocusKeys.has(row.key) ? [index] : []);
    const first = indexes.at(0);
    const last = indexes.at(-1);
    const viewport = viewportRef.current;
    if (first === undefined || last === undefined || !viewport) return;
    const focusHeight = (last - first + 1) * ROW_HEIGHT;
    const target = focusHeight > viewport.clientHeight
      ? first
      : indexes[Math.floor((indexes.length - 1) / 2)] ?? first;
    scrollLedger(
      viewport,
      target * ROW_HEIGHT - (focusHeight > viewport.clientHeight
        ? 0
        : (viewport.clientHeight - ROW_HEIGHT) / 2),
    );
  }, [rows, timelineFocusKeys]);

  const window = useMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(
      rows.length,
      Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN,
    );
    return { start, end, rows: rows.slice(start, end) };
  }, [rows, scrollTop, viewportHeight]);

  return (
    <div
      ref={viewportRef}
      className={styles.ledgerViewport}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div className={styles.ledgerTrack} style={{ height: rows.length * ROW_HEIGHT }}>
        {window.rows.map((row, localIndex) => {
          const absoluteIndex = window.start + localIndex;
          return (
            <button
              key={row.key}
              type="button"
              className={styles.ledgerRow}
              data-kind={row.kind}
              data-selected={row.key === selectedKey || undefined}
              data-timeline-focus={timelineFocusKeys === null
                ? undefined
                : timelineFocusKeys.has(row.key) ? 'inside' : 'outside'}
              style={{ transform: `translateY(${absoluteIndex * ROW_HEIGHT}px)` }}
              onClick={() => onSelect(row)}
            >
              <span className={styles.rowIndex}>{String(absoluteIndex).padStart(3, '0')}</span>
              <span className={styles.rowKind}>{rowKindLabel(row, t)}</span>
              <span className={styles.rowCopy}>
                <span className={styles.rowTitle}>{row.title}</span>
                <span className={styles.rowSubtitle}>{row.subtitle}</span>
              </span>
              {row.kind === 'message' && row.inputTokens !== undefined && (
                <span className={styles.rowTokens}>
                  {formatRequestTokenCheckpoint(row.inputTokens, row.inputTokenDelta, locale)}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function scrollLedger(viewport: HTMLDivElement, top: number): void {
  const boundedTop = Math.max(0, top);
  if (typeof viewport.scrollTo === 'function') {
    viewport.scrollTo({ top: boundedTop, behavior: 'smooth' });
    return;
  }
  viewport.scrollTop = boundedTop;
}

function rowKindLabel(row: ContextLedgerRow, translate: (key: string) => string): string {
  if (row.kind === 'system') return translate('contextUi.filterSystem');
  if (row.kind === 'tool') return translate('contextUi.filterTool');
  if (row.message.role === 'assistant') return translate('contextUi.filterAssistant');
  if (
    Array.isArray(row.message.content)
    && row.message.content.length > 0
    && row.message.content.every((block) => block.type === 'tool_result')
  ) {
    return translate('contextUi.filterResult');
  }
  return translate('contextUi.filterUser');
}
