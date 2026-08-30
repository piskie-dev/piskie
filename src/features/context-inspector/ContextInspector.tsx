import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { useRendererRuntime, useContextInspectorResource } from '../../renderer-runtime/hooks';
import { Divider } from '../console/chrome/Divider';
import { ContextLedger } from './ContextLedger';
import { ContextTimeline } from './ContextTimeline';
import { LocalInspector } from './LocalInspector';
import {
  contextTimelineFocusKeys,
  type ContextTimelineRange,
} from './context-timeline';
import {
  projectContextLedger,
  type ContextLedgerRow,
} from './ledger-projection';
import { resolveContextLedgerSelection } from './ledger-selection';
import styles from './context-inspector.module.css';

type LedgerFilter = 'all' | 'system' | 'tool' | 'user' | 'assistant' | 'result';

const FILTERS: readonly { readonly value: LedgerFilter; readonly labelKey: string }[] = [
  { value: 'all', labelKey: 'contextUi.filterAll' },
  { value: 'system', labelKey: 'contextUi.filterSystem' },
  { value: 'tool', labelKey: 'contextUi.filterTool' },
  { value: 'user', labelKey: 'contextUi.filterUser' },
  { value: 'assistant', labelKey: 'contextUi.filterAssistant' },
  { value: 'result', labelKey: 'contextUi.filterResult' },
];

export function ContextInspector({
  open,
  onClose,
  agentId,
  sourceVersion,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly agentId: string;
  readonly sourceVersion: number;
}) {
  const { t, i18n } = useTranslation();
  const runtime = useRendererRuntime();
  const resource = useContextInspectorResource((value) => value);
  const requestedRef = useRef<{ agentId: string; sourceVersion: number } | null>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  /* 原 antd Drawer 改原生 <dialog>(top layer + ::backdrop):开合受控同步 */
  const drawerRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = drawerRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);
  const [filter, setFilter] = useState<LedgerFilter>('all');
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState<{
    readonly agentId: string;
    readonly row: ContextLedgerRow;
  } | null>(null);
  const [timelineSelection, setTimelineSelection] = useState<{
    readonly agentId: string;
    readonly generation: number;
    readonly range: ContextTimelineRange;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    const previous = requestedRef.current;
    requestedRef.current = { agentId, sourceVersion };
    const current = runtime.contextInspector.state.getState();
    if (current.agentId !== agentId) {
      void runtime.contextInspector.open(agentId);
      return;
    }
    if (previous && previous.agentId === agentId && previous.sourceVersion !== sourceVersion) {
      void runtime.contextInspector.refresh();
    }
  }, [agentId, open, runtime, sourceVersion]);

  const snapshot = resource.agentId === agentId ? resource.snapshot : null;
  const projection = useMemo(
    () => snapshot ? projectContextLedger(snapshot, resource.generation, {
      systemPrompt: t('contextUi.projection.systemPrompt'),
      assistant: t('contextUi.projection.assistant'),
      toolResult: t('contextUi.projection.toolResult'),
      contextSummary: t('contextUi.projection.contextSummary'),
      user: t('contextUi.projection.user'),
      emptyContent: t('contextUi.projection.emptyContent'),
    }) : null,
    [resource.generation, snapshot, t],
  );
  const visibleRows = useMemo(() => {
    if (!projection) return [];
    const needle = query.trim().toLocaleLowerCase();
    return projection.rows.filter((row) => (
      matchesFilter(row, filter)
      && (!needle || row.searchText.toLocaleLowerCase().includes(needle))
    ));
  }, [filter, projection, query]);

  const intendedSelection = selection?.agentId === agentId
    ? resolveContextLedgerSelection(visibleRows, selection.row)
    : null;
  const selected = intendedSelection ?? visibleRows[0] ?? null;
  const selectedIndex = selected
    ? visibleRows.findIndex((row) => row.key === selected.key)
    : -1;
  const timelineMatchKeys = useMemo(() => (
    filter === 'all' && query.trim() === ''
      ? null
      : new Set(visibleRows.map((row) => row.key))
  ), [filter, query, visibleRows]);
  const timelineRange = timelineSelection?.agentId === agentId
    && timelineSelection.generation === resource.generation
    ? timelineSelection.range
    : null;
  const setTimelineRange = (range: ContextTimelineRange | null) => {
    setTimelineSelection(range === null
      ? null
      : { agentId, generation: resource.generation, range });
  };
  const timelineFocusKeys = useMemo(
    () => contextTimelineFocusKeys(projection?.rows ?? [], timelineRange),
    [projection, timelineRange],
  );
  const usage = snapshot?.usage;
  const selectRow = (row: ContextLedgerRow) => setSelection({ agentId, row });

  const moveSelection = (direction: -1 | 1) => {
    if (visibleRows.length === 0) return;
    const next = selectedIndex < 0
      ? 0
      : (selectedIndex + direction + visibleRows.length) % visibleRows.length;
    const row = visibleRows[next];
    if (!row) return;
    if (timelineFocusKeys !== null && !timelineFocusKeys.has(row.key)) {
      setTimelineRange(null);
    }
    selectRow(row);
  };

  return (
    <dialog
      ref={drawerRef}
      className={`${styles.drawerRoot} ${styles.drawer}`}
      onClose={onClose}
      onClick={(event) => {
        // 点击落在 ::backdrop 时事件目标是 dialog 自身(children 铺满面板)
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {open && (
      <div className={styles.drawerFrame}>
        <header className={styles.drawerHeader}>
          <div className={styles.drawerTitle}>
            <div className={styles.titleCopy}>
              <strong>{t('contextUi.title')}</strong>
            </div>
            <div className={styles.titleUsage}>
              <strong>{formatTokens(usage?.tokens, i18n.resolvedLanguage ?? i18n.language)} / {formatTokens(usage?.limit, i18n.resolvedLanguage ?? i18n.language)} tokens</strong>
              <em>{usage?.percentage === undefined ? '—' : `${Math.round(usage.percentage)}%`}</em>
            </div>
            <button
              type="button"
              className={styles.iconAction}
              onClick={() => void runtime.contextInspector.refresh()}
              disabled={resource.phase === 'opening' || resource.phase === 'refreshing'}
              aria-label={t('contextUi.refresh')}
            >
              <RefreshCw size={16} className={resource.phase === 'refreshing' ? 'animate-spin' : undefined} />
            </button>
            <button type="button" className={styles.iconAction} onClick={onClose} aria-label={t('contextUi.close')}>
              <X size={18} />
            </button>
          </div>
        </header>
      <div className={styles.contextShell}>
        <div className={styles.toolbar}>
          <div className={styles.filters} role="group" aria-label={t('contextUi.categoryAria')}>
            {FILTERS.map(({ value, labelKey }) => (
              <button
                key={value}
                type="button"
                data-active={filter === value || undefined}
                onClick={() => setFilter(value)}
              >
                {t(labelKey)}
              </button>
            ))}
          </div>
          <label className={styles.searchField}>
            <Search size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('contextUi.search')}
            />
            <span>{visibleRows.length}</span>
          </label>
          <div className={styles.searchNavigation}>
            <button type="button" onClick={() => moveSelection(-1)} disabled={visibleRows.length === 0} aria-label={t('contextUi.previousMatch')}>
              <ChevronUp size={15} />
            </button>
            <button type="button" onClick={() => moveSelection(1)} disabled={visibleRows.length === 0} aria-label={t('contextUi.nextMatch')}>
              <ChevronDown size={15} />
            </button>
          </div>
        </div>

        {resource.phase === 'opening' || resource.agentId !== agentId ? (
          <StatePanel title={t('contextUi.loading')} />
        ) : resource.phase === 'failed' && !snapshot ? (
          <StatePanel title={t('contextUi.loadFailed')} detail={resource.error} error />
        ) : projection ? (
          <div className={styles.contextContent}>
            <ContextTimeline
              rows={projection.rows}
              range={timelineRange}
              selectedKey={selected?.key ?? null}
              matchKeys={timelineMatchKeys}
              onRangeChange={setTimelineRange}
              onSelect={(row) => {
                setFilter('all');
                setQuery('');
                setTimelineRange(null);
                selectRow(row);
              }}
            />
            <div ref={workspaceRef} className={styles.workspace}>
              <section className={styles.ledgerPane}>
                <header className={styles.paneHeader}>
                  <div>
                    <strong>{t('contextUi.modelInput')}</strong>
                    <span>{visibleRows.length === projection.rows.length
                      ? t('contextUi.itemCount', { count: projection.rows.length })
                      : t('contextUi.filteredItemCount', {
                          visible: visibleRows.length,
                          total: projection.rows.length,
                        })}</span>
                  </div>
                </header>
                {resource.phase === 'failed' && (
                  <div className={styles.staleBanner}>
                    {resource.error} · {t('contextUi.staleContent')}
                  </div>
                )}
                <ContextLedger
                  rows={visibleRows}
                  selectedKey={selected?.key ?? null}
                  timelineFocusKeys={timelineFocusKeys}
                  onSelect={(row) => {
                    if (timelineFocusKeys !== null && !timelineFocusKeys.has(row.key)) {
                      setTimelineRange(null);
                    }
                    selectRow(row);
                  }}
                />
              </section>
              <div className={styles.workspaceDivider}>
                <Divider
                  cssVar="--context-detail-width"
                  targetRef={workspaceRef}
                  measureRef={inspectorRef}
                  pane="trailing"
                  defaultValue="clamp(320px, 38%, 440px)"
                  min={320}
                  max={720}
                  ariaLabel={t('contextUi.resizeDetail')}
                />
              </div>
              <LocalInspector
                key={`${agentId}:${intendedSelection && selection
                  ? selection.row.key
                  : selected?.key ?? 'empty'}`}
                paneRef={inspectorRef}
                row={selected}
                agentId={agentId}
              />
            </div>
          </div>
        ) : (
          <StatePanel title={t('contextUi.empty')} />
        )}
      </div>
      </div>
      )}
    </dialog>
  );
}

function StatePanel({ title, detail, error = false }: {
  readonly title: string;
  readonly detail?: string | null;
  readonly error?: boolean;
}) {
  return (
    <div className={styles.statePanel} data-error={error || undefined}>
      <strong>{title}</strong>
      {detail && <p>{detail}</p>}
    </div>
  );
}

function matchesFilter(row: ContextLedgerRow, filter: LedgerFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'system' || filter === 'tool') return row.kind === filter;
  if (row.kind !== 'message') return false;
  if (filter === 'assistant') return row.message.role === 'assistant';
  const isResult = Array.isArray(row.message.content)
    && row.message.content.length > 0
    && row.message.content.every((block) => block.type === 'tool_result');
  if (filter === 'result') return isResult;
  return row.message.role === 'user' && !isResult;
}

function formatTokens(value: number | undefined, locale: string): string {
  return value === undefined ? '—' : new Intl.NumberFormat(locale).format(value);
}
