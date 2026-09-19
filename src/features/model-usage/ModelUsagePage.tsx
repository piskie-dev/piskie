import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowUp, BarChart3, CalendarDays, Download, HelpCircle, RefreshCw, Settings2, SlidersHorizontal, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { UsageFacet, UsageFilter, UsageRecord, UsageReport, UsageSort, UsageStorageStatus } from '../../../shared/types/model-usage';
import { knownTokens } from '../../../shared/model-usage';
import { resolveInitialAppLanguage } from '../../../shared/utils/app-language';
import { Dialog } from '../console/chrome/Dialog';
import { Select } from '../../components/shared/Select';
import { UsageOverview } from './UsageOverview';
import { UsageSettings } from './UsageSettings';
import { UsagePicker } from './UsagePicker';
import { dateRange, duration, localDate, number } from './format';
import styles from './model-usage.module.css';
import deckStyles from '../prefdeck/deck.module.css';

const api = () => window.piskie.observability.modelUsage;
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
type Selection = { filter: UsageFilter; datePreset: string };
type Drilldown = Selection & { returnTab: 'overview' | 'details'; facets?: UsageReport['facets'] };

export function ModelUsagePage() {
  const { t, i18n } = useTranslation();
  const [selection, setSelection] = useState<Selection>(() => ({ filter: dateRange(7), datePreset: '7' }));
  const [drilldown, setDrilldown] = useState<Drilldown>();
  const { filter, datePreset } = drilldown ?? selection;
  const [tab, setTab] = useState<'overview' | 'details'>('overview');
  const [storedReport, setReport] = useState<UsageReport>();
  const report = storedReport && JSON.stringify(storedReport.filter) === JSON.stringify(filter) ? storedReport : undefined;
  const [storage, setStorage] = useState<UsageStorageStatus>();
  const [rows, setRows] = useState<UsageRecord[]>([]);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<UsageSort>('startedAt');
  const [descending, setDescending] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pageBusy, setPageBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [newCalls, setNewCalls] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  const [help, setHelp] = useState(false);
  const [detail, setDetail] = useState<{ record: UsageRecord; related: UsageRecord[] }>();
  const revision = useRef(0);
  const pageRevision = useRef(0);
  const invalidate = useCallback(() => { revision.current++; pageRevision.current++; }, []);
  const root = useRef<HTMLDivElement>(null);
  const tablist = useRef<HTMLDivElement>(null);
  const drillContext = useRef<HTMLDivElement>(null);
  const isDrilling = !!drilldown;
  useEffect(() => { if (isDrilling) drillContext.current?.focus(); }, [isDrilling]);
  const reload = useCallback(async () => {
    const request = ++revision.current;
    pageRevision.current++;
    setBusy(true); setPageBusy(false); setError(''); setDetail(undefined);
    try {
      const data = await api().query(filter);
      if (request !== revision.current) return;
      setReport(data); setStorage(data.storage); setRows(data.records); setOffset(0);
      setSort('startedAt'); setDescending(true); setNewCalls(false);
    } catch (cause) { if (request === revision.current) { setError(errorText(cause)); setReport(undefined); } }
    finally { if (request === revision.current) setBusy(false); }
  }, [filter]);
  useEffect(() => {
    const timer = setTimeout(() => void reload(), 100);
    return () => { clearTimeout(timer); invalidate(); };
  }, [reload, invalidate]);
  useEffect(() => {
    if (!report) return;
    let active = true;
    const timer = setInterval(() => {
      void api().status().then((status) => {
        if (!active) return;
        setStorage(status);
        if (status.revision !== report.revision) {
          setNewCalls(true);
          if (tab === 'overview' && !settings && !detail && !filtersOpen) void reload();
        }
      }).catch((cause) => { if (active) setError(errorText(cause)); });
    }, 10_000);
    return () => { active = false; clearInterval(timer); };
  }, [report, tab, settings, detail, filtersOpen, reload]);
  const updateSelection = (change: (old: Selection) => Selection) => {
    if (drilldown) setDrilldown((old) => old ? { ...old, ...change(old) } : old);
    else setSelection(change);
  };
  const update = (patch: Partial<UsageFilter>, preset?: string) => updateSelection((old) => ({ filter: { ...old.filter, ...patch }, datePreset: preset ?? old.datePreset }));
  const resetFilters = () => updateSelection((old) => ({ ...old, filter: { from: old.filter.from, to: old.filter.to } }));
  const scrollTop = () => { if (root.current) root.current.scrollTop = 0; };
  const drill = (patch: Partial<UsageFilter>) => {
    // Keep the normal report selection intact, including across nested detail links.
    setDrilldown({ filter: { ...filter, ...patch }, datePreset: patch.from !== undefined || patch.to !== undefined ? 'custom' : datePreset, returnTab: drilldown?.returnTab ?? tab, facets: report?.facets ?? drilldown?.facets });
    setTab('details'); setDetail(undefined); setNotice(''); scrollTop();
  };
  const changeTab = (next: 'overview' | 'details') => {
    if (next === 'overview') setDrilldown(undefined);
    setTab(next); setDetail(undefined); setNotice(''); scrollTop();
    tablist.current?.querySelector<HTMLButtonElement>(`[data-view="${next}"]`)?.focus();
  };
  const leaveDrilldown = () => { const next = drilldown?.returnTab ?? 'overview'; setDrilldown(undefined); changeTab(next); };
  const page = async (next: number, nextSort = sort, nextDescending = descending) => {
    if (!report) return;
    const request = ++pageRevision.current;
    setPageBusy(true); setError('');
    try {
      const result = await api().page(report.snapshotId, next, nextSort, nextDescending);
      if (request === pageRevision.current) { setRows(result.records); setOffset(next); setSort(nextSort); setDescending(nextDescending); }
    } catch (cause) { if (request === pageRevision.current) setError(errorText(cause)); }
    finally { if (request === pageRevision.current) setPageBusy(false); }
  };
  const openDetail = async (id: string) => {
    if (!report) return;
    const request = revision.current;
    try { const data = await api().detail(report.snapshotId, id); if (request === revision.current) setDetail(data); }
    catch (cause) { setError(errorText(cause)); }
  };
  const exportReport = async () => {
    if (!report) return;
    setError(''); setNotice('');
    try {
      const result = await api().export(report.snapshotId, resolveInitialAppLanguage(i18n.resolvedLanguage ?? i18n.language));
      if (result === null) return;
      setNotice(t('modelUsage.exportDone', { count: result.exportedCount, file: result.fileName }));
    } catch (cause) { setError(errorText(cause)); }
  };
  const facetItems = (key: keyof UsageFilter): UsageFacet[] => {
    if (key === 'purpose') return ['inference', 'compaction', 'test'].map((id) => ({ id, label: t(`modelUsage.${id}`) }));
    if (key === 'status') return ['running', 'success', 'failed', 'cancelled', 'interrupted'].map((id) => ({ id, label: t(`modelUsage.${id}`) }));
    return (report?.facets ?? drilldown?.facets ?? storedReport?.facets)?.[key as keyof UsageReport['facets']] ?? [];
  };
  const facetLabel = (key: keyof UsageFilter) => facetItems(key).find((item) => item.id === filter[key])?.label
    || drilldown?.facets?.[key as keyof UsageReport['facets']]?.find((item) => item.id === filter[key])?.label
    || String(filter[key] || t('modelUsage.none'));
  const setDate = (key: 'from' | 'to', value: string) => {
    if (!value) { update({ [key]: undefined }, 'custom'); return; }
    const date = new Date(`${value}T00:00:00`);
    if (key === 'to') date.setDate(date.getDate() + 1);
    const at = date.getTime();
    if (!Number.isFinite(at)) return;
    if ((key === 'from' && filter.to !== undefined && at >= filter.to) || (key === 'to' && filter.from !== undefined && at <= filter.from)) { setError(t('modelUsage.dateError')); return; }
    update({ [key]: at }, 'custom');
  };
  const columns: [string, UsageSort?][] = [['modelId'], ['mainAgentId'], ['tokens', 'tokens'], ['duration', 'duration'], ['status']];
  const selectedKeys = (Object.keys(filter) as (keyof UsageFilter)[]).filter((key) => key !== 'from' && key !== 'to' && filter[key] !== undefined);
  const filterKeys = ['mainAgentId', 'providerId', 'modelTarget', 'agentType', 'agentId', 'purpose', 'status', 'protocol', 'reasoning'] as const;
  const rangeSummary = `${filter.from === undefined ? t('modelUsage.all') : localDate(new Date(filter.from))} – ${filter.to === undefined ? t('modelUsage.all') : localDate(new Date(filter.to - 1))}`;
  const scopeHint = t(drilldown ? 'modelUsage.drilldownFilters' : 'modelUsage.sharedFilters');
  const drillRange = datePreset === 'custom'
    ? `${filter.from === undefined ? t('modelUsage.all') : new Date(filter.from).toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} – ${filter.to === undefined ? t('modelUsage.all') : new Date(filter.to - 1).toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`
    : rangeSummary;
  const filterChips = <div className={styles.activeFilters}><div className={styles.chips}>
    {selectedKeys.map((key) => <button key={key} title={`${t(`modelUsage.${key}`)}: ${facetLabel(key)}`} onClick={() => update({ [key]: undefined })}><span>{t(`modelUsage.${key}`)}: {facetLabel(key)}</span><X size={12} /></button>)}
    {drilldown && <button title={`${t('modelUsage.timeRange')}: ${drillRange}`} onClick={() => setFiltersOpen(true)}><CalendarDays size={12} /><span>{drillRange}</span></button>}
  </div>{!!selectedKeys.length && <button className={styles.resetFilters} onClick={resetFilters}>{t('modelUsage.reset')}</button>}</div>;
  return <div className={styles.page}>
    <header className={`${deckStyles.deskHead} ${styles.heading}`}>
      <div className={deckStyles.deskIdent}><h1 className={deckStyles.deskTitle}><span>{t('modelUsage.title')}</span></h1><div className={deckStyles.deskSub}>{t('modelUsage.subtitle')}</div></div>
      <div className={`${deckStyles.headActs} ${styles.actions}`}><button className={deckStyles.btn} aria-label={t('modelUsage.help')} title={t('modelUsage.help')} onClick={() => setHelp(true)}><HelpCircle size={15} /></button><button className={deckStyles.btn} aria-label={t('modelUsage.settings')} title={t('modelUsage.settings')} onClick={() => setSettings(true)}><Settings2 size={15} /><span className={styles.actionLabel}>{t('modelUsage.settings')}</span></button>
        <button className={deckStyles.btn} aria-label={t('modelUsage.export')} title={t('modelUsage.export')} disabled={!report || busy} onClick={() => void exportReport()}><Download size={15} /><span className={styles.actionLabel}>{t('modelUsage.export')}</span></button>
        <button className={deckStyles.btn} aria-label={t(busy ? 'modelUsage.refreshing' : 'modelUsage.refresh')} title={t('modelUsage.refresh')} disabled={busy} onClick={() => void reload()}><RefreshCw size={15} /></button></div>
    </header>
    <div className={`${deckStyles.deskBody} ${styles.body}`} ref={root}>
    <div className={styles.viewBar}>
      <div className={styles.tabs} role="tablist" aria-label={t('modelUsage.title')} ref={tablist}>{(['overview', 'details'] as const).map((key) => <button role="tab" key={key} data-view={key} aria-selected={tab === key} onClick={() => changeTab(key)}>{t(`modelUsage.${key}`)}</button>)}</div>
      <div className={styles.filterToolbar}>
        <div className={styles.datePresetControl} title={rangeSummary}><CalendarDays size={13} aria-hidden="true" /><Select className={styles.rangeSelect} ariaLabel={t('modelUsage.timeRange')} value={datePreset} options={[...[1, 7, 30, 90, 0].map((days, index) => ({ value: String(days), label: t(`modelUsage.${['today', 'week', 'month', 'quarter', 'allTime'][index]}`) })), { value: 'custom', label: datePreset === 'custom' ? rangeSummary : t('modelUsage.customRange') }]} onChange={(value) => { if (value === 'custom') { update({}, value); setFiltersOpen(true); } else update({ from: undefined, to: undefined, ...dateRange(Number(value)) }, value); }} /></div>
        <button className={styles.filterToggle} aria-label={t('modelUsage.filters')} title={scopeHint} aria-haspopup="dialog" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(true)}><SlidersHorizontal size={13} />{t('modelUsage.filterAction')}{selectedKeys.length > 0 && <b>{selectedKeys.length}</b>}</button>
      </div>
    </div>
    {drilldown ? <div className={styles.drillContext} role="region" aria-label={t('modelUsage.drilldown')} tabIndex={-1} ref={drillContext}>
      <div className={styles.drillHeading}><strong>{t('modelUsage.drilldown')}</strong><button onClick={leaveDrilldown}><ArrowLeft size={13} />{t(drilldown.returnTab === 'overview' ? 'modelUsage.backToOverview' : 'modelUsage.backToCalls')}</button></div>
      <p>{scopeHint}</p>{filterChips}
    </div> : !!selectedKeys.length && filterChips}
    {error && <p role="alert" className={styles.error}>{t('modelUsage.error')}: {error}</p>}
    {notice && <p role="status" className={styles.notice}>{notice}<button aria-label={t('modelUsage.close')} onClick={() => setNotice('')}><X size={14} /></button></p>}
    {(storage?.writeError || report?.storage.writeError) && <p role="alert" className={styles.error}>{storage?.writeError || report?.storage.writeError}</p>}
    {!!report?.corruptLines && <p role="alert" className={styles.error}>{t('modelUsage.corrupt', { count: report.corruptLines })}</p>}
    {newCalls && <button className={styles.notice} onClick={() => void reload()}>{t('modelUsage.newCalls')}</button>}
    {busy && !report && <p className={styles.empty} role="status">{t('modelUsage.loading')}</p>}
    {report && report.total === 0 && <section className={`${styles.panel} ${styles.empty}`}><div className={styles.emptyGlyph}><BarChart3 size={26} /></div><div><h2>{t(report.storage.files ? 'modelUsage.emptyFilter' : 'modelUsage.emptyHistory')}</h2><p>{t(report.storage.files ? 'modelUsage.emptyFilterHint' : 'modelUsage.emptyHint')}</p></div></section>}
    {report && report.total > 0 && tab === 'overview' && <UsageOverview report={report} drill={drill} />}
    {report && report.total > 0 && tab === 'details' && <section className={`${styles.panel} ${styles.tablePanel}`} aria-busy={pageBusy}>
      <header className={styles.tableToolbar}><h2>{t('modelUsage.details')}</h2><div className={styles.sortControls}><span>{t('modelUsage.sortBy')}</span><Select ariaLabel={t('modelUsage.sortBy')} value={sort} options={(['startedAt', 'tokens', 'duration'] as const).map((key) => ({ value: key, label: t(`modelUsage.${key}`) }))} disabled={pageBusy} onChange={(value) => void page(0, value, descending)} /><button className={styles.iconButton} disabled={pageBusy} aria-label={t(descending ? 'modelUsage.descending' : 'modelUsage.ascending')} title={t(descending ? 'modelUsage.descending' : 'modelUsage.ascending')} onClick={() => void page(0, sort, !descending)}>{descending ? <ArrowDown size={14} /> : <ArrowUp size={14} />}</button></div></header>
      <div className={styles.tableScroll}><table className={styles.callsTable}><thead><tr>{columns.map(([key, field]) => <th key={key} aria-sort={field === sort ? descending ? 'descending' : 'ascending' : undefined}>{field ? <button disabled={pageBusy} onClick={() => void page(0, field, field === sort ? !descending : true)}>{t(`modelUsage.${key}`)}{field === sort ? descending ? ' ↓' : ' ↑' : ''}</button> : t(`modelUsage.${key}`)}</th>)}</tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}>
          <td data-field="model"><button className={styles.link} title={r.modelName} onClick={() => void openDetail(r.id)}>{r.modelName}</button><small title={r.providerName}>{r.providerName}</small><time dateTime={new Date(r.startedAt).toISOString()} title={new Date(r.startedAt).toLocaleString()}>{new Date(r.startedAt).toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time></td>
          <td data-field="session"><button className={styles.link} title={r.runName || r.mainAgentId} onClick={() => void openDetail(r.id)}>{r.runName || r.mainAgentId || t('modelUsage.none')}</button><small>{r.agentType || t('modelUsage.none')} · {t(`modelUsage.${r.purpose}`)}</small></td>
          <td data-label={t('modelUsage.tokens')}>{r.usage.totalInputTokens !== undefined || r.usage.totalOutputTokens !== undefined ? number(knownTokens(r.usage)) : '—'}<small>{t('modelUsage.input')} {number(r.usage.totalInputTokens)}<br />{t('modelUsage.output')} {number(r.usage.totalOutputTokens)}</small></td>
          <td data-label={t('modelUsage.duration')}>{duration(r.endedAt === undefined ? undefined : r.endedAt - r.startedAt)}<small>{t('modelUsage.firstResponse')} {duration(r.firstResponseMs)}</small></td>
          <td data-field="status"><span className={styles.badge} data-status={r.status}>{t(`modelUsage.${r.status}`)}</span><small>{t('modelUsage.attempt')} {r.attempt}</small></td>
        </tr>)}</tbody></table></div>
      <footer className={styles.pagination}><span>{t('modelUsage.total', { count: report.total })}</span><button disabled={pageBusy || offset === 0} onClick={() => void page(offset - 50)}>{t('modelUsage.previous')}</button><span>{t('modelUsage.page', { page: Math.floor(offset / 50) + 1, pages: Math.ceil(report.total / 50) })}</span><button disabled={pageBusy || offset + 50 >= report.total} onClick={() => void page(offset + 50)}>{t('modelUsage.next')}</button></footer>
    </section>}
    <footer className={styles.storage}><span>{storage?.earliestDay && t('modelUsage.historyRange', { from: storage.earliestDay, to: storage.latestDay })}</span><span>{report && t('modelUsage.refreshed', { time: new Date(report.createdAt).toLocaleTimeString() })}</span><p>{t('modelUsage.partialHistory')}</p></footer>
    </div>
    <Dialog open={filtersOpen} onClose={() => setFiltersOpen(false)} title={t('modelUsage.filters')} width={640} className={styles.filterShell} bodyClassName={styles.filterDialog}>
      <p className={styles.filterHint}>{scopeHint} · {Intl.DateTimeFormat().resolvedOptions().timeZone}</p>
      <div className={styles.dateGrid}>
        <label className={styles.filterField}><span className={styles.fieldLabel}>{t('modelUsage.from')}</span><input type="date" value={filter.from === undefined ? '' : localDate(new Date(filter.from))} onChange={(e) => setDate('from', e.target.value)} /></label>
        <label className={styles.filterField}><span className={styles.fieldLabel}>{t('modelUsage.to')}</span><input type="date" value={filter.to === undefined ? '' : localDate(new Date(filter.to - 1))} onChange={(e) => setDate('to', e.target.value)} /></label>
      </div>
      <div className={styles.filterGrid}>{filterKeys.map((key) => <UsagePicker key={key} label={t(`modelUsage.${key}`)} value={filter[key]} items={facetItems(key)} onChange={(value) => update({ [key]: value })} />)}</div>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <div className={styles.filterDialogFooter}><span>{report && t('modelUsage.total', { count: report.total })}</span><div className={styles.actions}><button disabled={!selectedKeys.length} onClick={resetFilters}>{t('modelUsage.reset')}</button><button className={styles.primary} onClick={() => setFiltersOpen(false)}>{t('modelUsage.done')}</button></div></div>
    </Dialog>
    {settings && <UsageSettings open close={() => setSettings(false)} changed={() => void reload()} storage={storage} />}
    <Dialog open={help} onClose={() => setHelp(false)} title={t('modelUsage.help')}><p>{t('modelUsage.rules')}</p><p>{t('modelUsage.cacheHint')}</p><button onClick={() => setHelp(false)}>{t('modelUsage.close')}</button></Dialog>
    <UsageDetail detail={report ? detail : undefined} close={() => setDetail(undefined)} drill={drill} />
  </div>;
}

function UsageDetail({ detail, close, drill }: { detail?: { record: UsageRecord; related: UsageRecord[] }; close(): void; drill(filter: Partial<UsageFilter>): void }) {
  const { t } = useTranslation();
  const r = detail?.record;
  return <Dialog open={!!r} onClose={close} title={t('modelUsage.detailTitle')} width={640} className={styles.drawer}>
    {r && <div className={styles.detail}>
      <h2>{r.modelName}</h2><p>{r.providerName} · {t(`modelUsage.${r.status}`)} · {new Date(r.startedAt).toLocaleString()}</p>
      <dl>{([
        ['mainAgentId', r.runName || r.mainAgentId || t('modelUsage.none')], ['agentId', r.agentId], ['agentType', r.agentType], ['purpose', t(`modelUsage.${r.purpose}`)],
        ['requestId', r.requestId], ['runId', r.runId], ['attempt', r.attempt], ['protocol', r.protocol], ['reasoning', r.reasoning],
        ['duration', duration(r.endedAt === undefined ? undefined : r.endedAt - r.startedAt)], ['firstResponse', duration(r.firstResponseMs)],
      ] as const).map(([key, value]) => <div key={key}><dt>{t(`modelUsage.${key}`)}</dt><dd>{value ?? '—'}</dd></div>)}</dl>
      <h3>{t('modelUsage.tokens')}</h3><dl>{([
        ['input', r.usage.totalInputTokens], ['output', r.usage.totalOutputTokens], ['cacheRead', r.usage.cachedInputTokens], ['cacheWrite', r.usage.cacheWriteTokens], ['reasoningTokens', r.usage.reasoningTokens],
      ] as const).map(([key, value]) => <div key={key}><dt>{t(`modelUsage.${key}`)}</dt><dd>{number(value)}</dd></div>)}</dl><p>{t('modelUsage.cacheHint')}</p>
      {r.error && <><h3>{t('modelUsage.errorDetails')}</h3><code>{[r.error.source, r.error.stage, r.error.code, r.error.httpStatus].filter((v) => v !== undefined).join(' · ')}</code><p>{t('modelUsage.noBody')}</p></>}
      {!!detail?.related.length && <><h3>{t('modelUsage.related')}</h3><ul>{detail.related.map((call) => <li key={call.id}>{new Date(call.startedAt).toLocaleTimeString()} · {t('modelUsage.attempt')} {call.attempt} · {t(`modelUsage.${call.status}`)} · {number(knownTokens(call.usage))}</li>)}</ul></>}
      <div className={styles.actions}>{r.mainAgentId && <button onClick={() => drill({ mainAgentId: r.mainAgentId })}>{t('modelUsage.filterSession')}</button>}{r.requestId && <button onClick={() => drill({ requestId: r.requestId, mainAgentId: r.mainAgentId ?? '', agentId: r.agentId ?? '', status: undefined })}>{t('modelUsage.filterRequest')}</button>}<button onClick={close}>{t('modelUsage.close')}</button></div>
    </div>}
  </Dialog>;
}
