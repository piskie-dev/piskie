import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import type { ScheduleCreateInput, ScheduleUpdateInput } from '@shared/electron-contracts/schedules';
import type { ScheduleFireRecord } from '@shared/types/schedules';
import { Dialog } from '../console/chrome/Dialog';
import { createConsoleHeaderAction } from '../console/shell/headerAction';
import {
  useAgentControl,
  useRendererRuntime,
  useScheduleRepository,
  useTaskDefinitionRepository,
} from '../../renderer-runtime/hooks';
import { useMessagingStore } from '../../store/messagingStore';
import { pushToast } from '../toasts';
import { formatDateShort } from './format';
import { HistoryView } from './HistoryView';
import { addDays, DAY_MS, startOfWeek } from './local-days';
import { PromptView } from './PromptView';
import { directoryGroup } from './schedule-presenter';
import { ScheduleDirectory } from './ScheduleDirectory';
import { ScheduleFormDialog, type ScheduleFormMode } from './ScheduleFormDialog';
import { ScheduleHead } from './ScheduleHead';
import { buildSlotGrid, DAYS_PER_WEEK } from './slot-grid-model';
import { SlotGridView } from './SlotGridView';
import { useNow } from './useNow';
import styles from './schedules.module.css';

type ContentView = 'grid' | 'history' | 'prompt';

const HISTORY_WINDOW_MS = 30 * DAY_MS;

export function SchedulesPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const navigate = useNavigate();
  const runtime = useRendererRuntime();
  const phase = useScheduleRepository((snapshot) => snapshot.phase);
  const items = useScheduleRepository((snapshot) => snapshot.items);
  const loadError = useScheduleRepository((snapshot) => snapshot.error);
  const revision = useScheduleRepository((snapshot) => snapshot.revision);
  const definitions = useTaskDefinitionRepository((snapshot) => snapshot.definitions);
  const definitionsPhase = useTaskDefinitionRepository((snapshot) => snapshot.phase);
  const connections = useMessagingStore((store) => store.connections);
  const fetchConnections = useMessagingStore((store) => store.fetchConnections);
  // IM 连接列表只在消息页加载；这里要知道哪些模板已被 Bot 绑定，进页面拉一次。
  useEffect(() => {
    void fetchConnections();
  }, [fetchConnections]);
  const boundTemplates = useMemo(() => {
    const bound = new Map<string, string>();
    for (const connection of connections) {
      if (connection.config.definitionId) bound.set(connection.config.definitionId, connection.config.name);
    }
    return bound;
  }, [connections]);
  const live = useAgentControl((snapshot) => snapshot.agentsById);
  const now = useNow();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [view, setView] = useState<ContentView>('grid');
  const [weekRecords, setWeekRecords] = useState<readonly ScheduleFireRecord[]>([]);
  const [history, setHistory] = useState<{ key: string; records: readonly ScheduleFireRecord[] }>({ key: '', records: [] });
  const [historyFrom, setHistoryFrom] = useState(() => new Date(Date.now() - HISTORY_WINDOW_MS));
  const [form, setForm] = useState<ScheduleFormMode | null>(null);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (definitionsPhase === 'idle') void runtime.taskDefinitions.refresh();
  }, [definitionsPhase, runtime]);

  // 选中项以快照为准：任务被删除后自动回到「全部」，指令页随之退回网格。
  const selected = useMemo(
    () => (selectedId ? items.find((item) => item.schedule.scheduleId === selectedId) ?? null : null),
    [items, selectedId],
  );
  const deleteTarget = useMemo(
    () => (deleteTargetId ? items.find((item) => item.schedule.scheduleId === deleteTargetId) ?? null : null),
    [deleteTargetId, items],
  );
  const currentId = selected ? selected.schedule.scheduleId : null;
  const currentView: ContentView = view === 'prompt' && !selected ? 'grid' : view;

  // 本周的触发记录：翻周或快照变化（新触发）时重拉。
  useEffect(() => {
    let cancelled = false;
    const from = weekStart.toISOString();
    const to = new Date(addDays(weekStart, DAYS_PER_WEEK).getTime() - 1).toISOString();
    runtime.schedules.queryHistory({ from, to })
      .then((records) => { if (!cancelled) setWeekRecords(records); })
      .catch((error: unknown) => { console.error('Failed to load schedule history for the week:', error); });
    return () => { cancelled = true; };
  }, [runtime, weekStart, revision]);

  // 记录时间轴：选中任务或「全部」，向前逐月加载。key 变了但还没加载到就是 loading。
  const historyKey = `${currentId ?? '*'}|${historyFrom.getTime()}|${revision}`;
  const historyLoading = currentView === 'history' && history.key !== historyKey;
  useEffect(() => {
    if (currentView !== 'history') return;
    let cancelled = false;
    runtime.schedules.queryHistory({
      from: historyFrom.toISOString(),
      to: new Date().toISOString(),
      ...(currentId ? { scheduleId: currentId } : {}),
    })
      .then((records) => { if (!cancelled) setHistory({ key: historyKey, records }); })
      .catch((error: unknown) => { console.error('Failed to load schedule history:', error); });
    return () => { cancelled = true; };
  }, [runtime, currentView, currentId, historyFrom, historyKey]);

  const model = useMemo(
    () => buildSlotGrid({ weekStart, now, items, records: weekRecords }),
    [weekStart, now, items, weekRecords],
  );
  const attentionCount = items.filter((item) => directoryGroup(item) === 'attention').length;

  const failToast = useCallback((titleKey: string, error: unknown) => {
    pushToast({
      id: `schedule-action-${Date.now()}`,
      tone: 'error',
      title: t(titleKey),
      detail: error instanceof Error ? error.message : String(error),
    });
  }, [t]);

  const perform = useCallback(async (titleKey: string, action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      failToast(titleKey, error);
    } finally {
      setBusy(false);
    }
  }, [failToast]);

  const openRun = useCallback((agentId: string) => {
    navigate('/console', {
      state: { consoleAction: createConsoleHeaderAction({ kind: 'reveal', target: { agentId } }) },
    });
  }, [navigate]);
  const openTemplates = useCallback(() => navigate('/console'), [navigate]);

  const onCreate = useCallback(async (input: ScheduleCreateInput) => {
    const created = await runtime.schedules.create(input);
    setSelectedId(created.schedule.scheduleId);
  }, [runtime]);
  const onUpdate = useCallback(async (scheduleId: string, updates: ScheduleUpdateInput) => {
    await runtime.schedules.update(scheduleId, updates);
  }, [runtime]);

  const weekEnd = addDays(weekStart, DAYS_PER_WEEK - 1);

  return (
    <div className={styles.workspace}>
      <ScheduleDirectory
        items={items}
        definitions={definitions}
        now={now}
        locale={locale}
        selectedId={currentId}
        query={query}
        loading={phase === 'loading' || phase === 'refreshing'}
        busy={busy}
        onQuery={setQuery}
        onSelect={setSelectedId}
        onDelete={setDeleteTargetId}
        onCreate={() => setForm({ kind: 'create' })}
        onRefresh={() => { void runtime.schedules.refresh(); void runtime.taskDefinitions.refresh(); }}
      />
      <main className={styles.main}>
        <ScheduleHead
          view={selected}
          items={items}
          definitions={definitions}
          now={now}
          locale={locale}
          summary={model.summary}
          attentionCount={attentionCount}
          busy={busy}
          onRunNow={() => { if (selected) void perform('schedulesUi.toast.runNowFailed', () => runtime.schedules.runNow(selected.schedule.scheduleId)); }}
          onToggleEnabled={() => {
            if (!selected) return;
            const enabled = !(selected.schedule.enabled && !selected.state.suspended);
            void perform('schedulesUi.toast.actionFailed', () => runtime.schedules.update(selected.schedule.scheduleId, { enabled }));
          }}
          onEdit={() => { if (selected) setForm({ kind: 'edit', view: selected }); }}
          onDelete={() => { if (selected) setDeleteTargetId(selected.schedule.scheduleId); }}
          onCreate={() => setForm({ kind: 'create' })}
        />
        {loadError && <div className={styles.error} role="alert">{loadError}</div>}
        <div className={styles.bar}>
          <div className={styles.weekNav}>
            <button
              type="button"
              className={styles.iconButton}
              onClick={() => setWeekStart((current) => addDays(current, -DAYS_PER_WEEK))}
              aria-label={t('schedulesUi.week.previous')}
              title={t('schedulesUi.week.previous')}
            >
              <ChevronLeft size={14} />
            </button>
            <b>{t('schedulesUi.week.range', { from: formatDateShort(weekStart, locale), to: formatDateShort(weekEnd, locale) })}</b>
            <button
              type="button"
              className={styles.iconButton}
              onClick={() => setWeekStart((current) => addDays(current, DAYS_PER_WEEK))}
              aria-label={t('schedulesUi.week.next')}
              title={t('schedulesUi.week.next')}
            >
              <ChevronRight size={14} />
            </button>
          </div>
          <div className={`${styles.seg} ${styles.viewSeg}`} role="group" aria-label={t('schedulesUi.view.label')}>
            <button type="button" aria-pressed={currentView === 'grid'} onClick={() => setView('grid')}>{t('schedulesUi.view.grid')}</button>
            <button type="button" aria-pressed={currentView === 'history'} onClick={() => setView('history')}>{t('schedulesUi.view.history')}</button>
            <button type="button" aria-pressed={currentView === 'prompt'} disabled={!selected} onClick={() => setView('prompt')}>{t('schedulesUi.view.prompt')}</button>
          </div>
        </div>
        {phase === 'ready' && items.length === 0 ? (
          <div className={styles.empty}>
            <div>
              <p><strong>{t('schedulesUi.empty.title')}</strong></p>
              <p>{t('schedulesUi.empty.body')}</p>
              <button type="button" className={`${styles.button} ${styles.primary}`} onClick={() => setForm({ kind: 'create' })}>
                {t('schedulesUi.create')}
              </button>
            </div>
          </div>
        ) : currentView === 'grid' ? (
          <SlotGridView
            model={model}
            items={items}
            selectedId={currentId}
            now={now}
            locale={locale}
            onPick={setSelectedId}
          />
        ) : currentView === 'history' ? (
          <HistoryView
            records={history.records}
            items={items}
            definitions={definitions}
            live={live}
            now={now}
            locale={locale}
            showNames={!selected}
            loading={historyLoading}
            onLoadMore={() => setHistoryFrom((current) => new Date(current.getTime() - HISTORY_WINDOW_MS))}
            onOpenRun={openRun}
          />
        ) : selected ? (
          <PromptView
            view={selected}
            definitions={definitions}
            live={live}
            now={now}
            locale={locale}
            onOpenTemplates={openTemplates}
            onOpenRun={openRun}
          />
        ) : null}
      </main>

      {form && (
        <ScheduleFormDialog
          key={form.kind === 'edit' ? form.view.schedule.scheduleId : 'create'}
          open
          mode={form}
          definitions={definitions}
          boundTemplates={boundTemplates}
          now={now}
          locale={locale}
          onClose={() => setForm(null)}
          onCreate={onCreate}
          onUpdate={onUpdate}
          onOpenTemplates={openTemplates}
        />
      )}

      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTargetId(null)}
        title={t('schedulesUi.confirmDelete.title')}
        width={420}
      >
        <p className={styles.confirmText}>{t('schedulesUi.confirmDelete.body', { name: deleteTarget?.schedule.name ?? '' })}</p>
        <div className={styles.formFooter}>
          <button type="button" className={`${styles.button} ${styles.ghost}`} onClick={() => setDeleteTargetId(null)}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={`${styles.button} ${styles.danger}`}
            disabled={busy}
            onClick={() => {
              if (!deleteTarget) return;
              const { scheduleId } = deleteTarget.schedule;
              setDeleteTargetId(null);
              void perform('schedulesUi.toast.actionFailed', async () => {
                await runtime.schedules.delete(scheduleId);
                setSelectedId((current) => current === scheduleId ? null : current);
              });
            }}
          >
            {t('common.delete')}
          </button>
        </div>
      </Dialog>
    </div>
  );
}
