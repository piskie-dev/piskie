import { useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { UsageDimension, UsageFilter, UsageGroup, UsageReport, UsageSummary } from '../../../shared/types/model-usage';
import { Select } from '../../components/shared/Select';
import { cacheRate, duration, number, percent, successRate } from './format';
import styles from './model-usage.module.css';

const colors = ['var(--cyber-primary)', 'var(--cyber-success)', 'var(--cyber-purple)', 'var(--cyber-warning)', 'var(--cyber-error)'];

export function UsageOverview({ report, drill }: { report: UsageReport; drill(filter: Partial<UsageFilter>): void }) {
  const { t } = useTranslation();
  const value = (s: UsageSummary) => s.tokens;
  const formatted = (s: UsageSummary) => t('modelUsage.distributionAmounts', { tokens: s.completeUsage + s.partialUsage ? number(s.tokens) : '—', calls: number(s.calls) });
  const s = report.summary;
  const coverage = t('modelUsage.completeCoverage', { complete: s.completeUsage, partial: s.partialUsage, unknown: s.calls - s.completeUsage - s.partialUsage });
  const cards = [
    ['calls', number(s.calls), `${number(s.requests)} ${t('modelUsage.requests')}`],
    ['tokens', s.completeUsage + s.partialUsage ? number(s.tokens) : '—', coverage],
  ];
  const quality = [
    ['successRate', percent(successRate(s)), t('modelUsage.endedCoverage', { ended: s.calls - s.running, running: s.running })],
    ['cacheRate', percent(cacheRate(s)), t('modelUsage.samples', { count: s.cacheSamples })],
    ['averageFirst', duration(s.firstResponseSamples ? s.firstResponseTotal / s.firstResponseSamples : undefined), t('modelUsage.samples', { count: s.firstResponseSamples })],
  ];
  return <>
    <div className={styles.metrics}>{cards.map(([key, amount, hint]) => <section className={styles.metricCard} key={key} data-metric={key}>
      <span>{t(`modelUsage.${key}`)}</span><strong>{amount}</strong><small>{hint}</small>
    </section>)}</div>
    <div className={styles.qualityMetrics}>{quality.map(([key, amount, hint]) => <div key={key}><span>{t(`modelUsage.${key}`)}</span><strong>{amount}</strong><small>{hint}</small></div>)}</div>
    <div className={styles.chartToolbar}>
      <h2>{t('modelUsage.analysis')}</h2>
    </div>
    <section className={`${styles.panel} ${styles.trendPanel}`}>
      <header><h2>{t('modelUsage.trend')}</h2><small>{t('modelUsage.chartHint')}</small></header>
      <Trend report={report} drill={drill} />
      <p className={styles.hint}>{t('modelUsage.cacheHint')}</p>
    </section>
    <Ranking groups={report.groups.mainAgentId} drill={drill} />
    <div className={styles.breakdowns}>
      <section className={styles.panel}>
        <header><h2>{t('modelUsage.modelDistribution')}</h2><small>{t('modelUsage.distributionMetric')}</small></header>
        <Distribution groups={report.groups.modelId} value={value} formatted={formatted} drill={(id) => drill({ modelTarget: id })} />
      </section>
      {(['providerId', 'agentType', 'purpose'] as const).map((dimension, index) => <Bars key={dimension} dimension={dimension} groups={report.groups[dimension]} title={t(`modelUsage.${['providerDistribution', 'agentDistribution', 'purposeDistribution'][index]}`)} value={value} formatted={formatted} drill={drill} />)}
    </div>
  </>;
}

function Trend({ report, drill }: { report: UsageReport; drill(filter: Partial<UsageFilter>): void }) {
  const { t } = useTranslation();
  const [hidden, setHidden] = useState<string[]>([]);
  const series = [
    { key: 'input', read: (s: UsageSummary) => s.inputSamples || !s.calls ? s.input : undefined },
    { key: 'output', read: (s: UsageSummary) => s.outputSamples || !s.calls ? s.output : undefined },
    { key: 'cacheRead', read: (s: UsageSummary) => s.cacheReadSamples || !s.calls ? s.cacheRead : undefined },
    { key: 'calls', read: (s: UsageSummary) => s.calls },
  ];
  const shown = series.filter((s) => !hidden.includes(s.key));
  const tokenSeries = shown.filter((s) => s.key !== 'calls');
  const tokenMax = Math.max(1, ...report.trend.flatMap((b) => tokenSeries.map((s) => s.read(b.summary) ?? 0)));
  // Calls use a separate scale with integer ticks, even for a single call.
  const callsMax = Math.max(2, Math.ceil(Math.max(0, ...report.trend.map((b) => b.summary.calls)) / 2) * 2);
  const x = (index: number) => 58 + (report.trend.length <= 1 ? 256 : index * 512 / (report.trend.length - 1));
  const y = (value: number, key: string) => 190 - value / (key === 'calls' ? callsMax : tokenMax) * 155;
  return <>
    <div className={styles.legend}>{series.map((s, index) => <button key={s.key} aria-pressed={!hidden.includes(s.key)} onClick={() => setHidden(hidden.includes(s.key) ? hidden.filter((key) => key !== s.key) : [...hidden, s.key])}><svg width="18" height="8" aria-hidden="true"><line x1="0" x2="18" y1="4" y2="4" stroke={colors[index]} strokeWidth="2" strokeDasharray={s.key === 'calls' ? '4 3' : undefined} /></svg>{t(`modelUsage.${s.key}`)}</button>)}</div>
    <svg viewBox="0 0 640 230" className={styles.trend} role="img" aria-label={t('modelUsage.trend')}>
      <g data-axis="tokens"><text x="58" y="16">{t('modelUsage.tokenAxis')}</text>{[0, .5, 1].map((fraction) => <g key={fraction}><line x1="58" x2="570" y1={y(tokenMax * fraction, 'tokens')} y2={y(tokenMax * fraction, 'tokens')} /><text x="49" y={y(tokenMax * fraction, 'tokens') + 4} textAnchor="end">{number(tokenMax * fraction)}</text></g>)}</g>
      <g data-axis="calls" className={styles.callsAxis}><text x="570" y="16" textAnchor="end">{t('modelUsage.callsAxis')}</text>{[0, .5, 1].map((fraction) => <text key={fraction} x="582" y={y(callsMax * fraction, 'calls') + 4}>{number(callsMax * fraction)}</text>)}</g>
      {shown.map((s) => <path key={s.key} data-series={s.key} fill="none" stroke={colors[series.indexOf(s)]} strokeWidth="2.5" strokeDasharray={s.key === 'calls' ? '6 4' : undefined} d={report.trend.map((b, i) => {
        const amount = s.read(b.summary);
        if (amount === undefined) return '';
        return `${i === 0 || s.read(report.trend[i - 1]!.summary) === undefined ? 'M' : 'L'}${x(i)} ${y(amount, s.key)}`;
      }).join(' ')} />)}
      {report.trend.map((bucket, index) => {
        const select = () => drill({ from: Math.max(bucket.at, report.filter.from ?? 0), to: Math.min(bucket.to, report.filter.to ?? Infinity) });
        const hint = [new Date(bucket.at).toLocaleString(), ...series.map((s) => `${t(`modelUsage.${s.key}`)}: ${number(s.read(bucket.summary))}${s.key === 'calls' ? '' : ' Token'}`)].join(' · ');
        return <g key={bucket.at} role="button" tabIndex={0} aria-label={hint} onClick={select} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); } }}>
          <title>{hint}</title><rect x={x(index) - 7} y="25" width="14" height="168" fill="transparent" />
          {shown.map((s) => { const amount = s.read(bucket.summary); return amount === undefined ? null : <circle key={s.key} cx={x(index)} cy={y(amount, s.key)} r="3.5" fill={colors[series.indexOf(s)]} />; })}
          {(index === 0 || index === report.trend.length - 1 || index % Math.max(1, Math.ceil(report.trend.length / 4)) === 0) && <text x={x(index)} y="217" textAnchor="middle">{new Date(bucket.at).toLocaleString(undefined, { month: 'numeric', day: 'numeric', ...(bucket.to - bucket.at < 86_400_000 && { hour: '2-digit', minute: '2-digit' }) })}</text>}
        </g>;
      })}
    </svg>
  </>;
}

function Distribution({ groups, value, formatted, drill }: { groups: UsageGroup[]; value(s: UsageSummary): number; formatted(s: UsageSummary): string; drill(id: string): void }) {
  const { t } = useTranslation();
  const sorted = [...groups].sort((a, b) => value(b.summary) - value(a.summary));
  const total = groups.reduce((n, group) => n + value(group.summary), 0);
  const sizes = sorted.map((group) => total ? value(group.summary) / total * 270.18 : 0);
  return <div className={styles.distribution}>
    <svg viewBox="0 0 120 120" className={styles.donut} aria-label={t('modelUsage.modelDistribution')}>
      <circle cx="60" cy="60" r="43" stroke="var(--surface-2)" strokeWidth="13" fill="none" />
      {sorted.map((group, index) => {
        const size = sizes[index]!;
        const start = sizes.slice(0, index).reduce((sum, n) => sum + n, 0);
        return <circle key={group.id} cx="60" cy="60" r="43" fill="none" stroke={colors[index % colors.length]} strokeWidth="13" strokeDasharray={`${size} ${270.18 - size}`} strokeDashoffset={-start} transform="rotate(-90 60 60)"><title>{group.label}: {formatted(group.summary)}</title></circle>;
      })}
    </svg>
    <div className={styles.distributionList}>{sorted.map((group, index) => <button key={group.id} title={group.label} onClick={() => drill(group.id)}><i style={{ background: colors[index % colors.length] }} /><span><b>{group.label}</b><small>{formatted(group.summary)}</small></span><span>{percent(total ? value(group.summary) / total : undefined)}</span></button>)}</div>
  </div>;
}

function Bars({ dimension, groups, title, value, formatted, drill }: { dimension: UsageDimension; groups: UsageGroup[]; title: string; value(s: UsageSummary): number; formatted(s: UsageSummary): string; drill(filter: Partial<UsageFilter>): void }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const sorted = [...groups].sort((a, b) => value(b.summary) - value(a.summary));
  const max = Math.max(1, ...sorted.map((g) => value(g.summary)));
  return <section className={styles.panel}><header><h2>{title}</h2><small>{t('modelUsage.distributionMetric')}</small>{groups.length > 4 && <button className={styles.link} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? t('modelUsage.close') : t('modelUsage.showMore')}</button>}</header>
    {sorted.slice(0, expanded ? undefined : 4).map((group, index) => <button className={styles.bar} key={group.id} onClick={() => drill({ [dimension]: group.id })}>
      <span><b title={group.label}>{dimension === 'purpose' ? t(`modelUsage.${group.id}`) : group.label || t('modelUsage.none')}</b><small>{formatted(group.summary)}</small></span>
      <span className={styles.track}><i style={{ width: `${value(group.summary) / max * 100}%`, background: colors[index % colors.length] }} /></span>
    </button>)}
  </section>;
}

function Ranking({ groups, drill }: { groups: UsageGroup[]; drill(filter: Partial<UsageFilter>): void }) {
  const { t } = useTranslation();
  const [sort, setSort] = useState('tokens');
  const [descending, setDescending] = useState(true);
  const [page, setPage] = useState(0);
  const numeric = (s: UsageSummary): number => sort === 'successRate' ? successRate(s) ?? -1 : sort === 'cacheRate' ? cacheRate(s) ?? -1 : sort === 'calls' ? s.calls : s.tokens;
  const sorted = groups.filter((group) => group.id).sort((a, b) => (numeric(b.summary) - numeric(a.summary)) * (descending ? 1 : -1));
  const pages = Math.max(1, Math.ceil(sorted.length / 5));
  const activePage = Math.min(page, pages - 1);
  return <section className={`${styles.panel} ${styles.tablePanel}`}>
    <header className={styles.tableToolbar}><div className={styles.sectionIntro}><h2>{t('modelUsage.ranking')}</h2><small>{t('modelUsage.rankingHint')}</small></div><div className={`${styles.sortControls} ${styles.compactSort}`}><Select ariaLabel={t('modelUsage.sortBy')} value={sort} options={['calls', 'tokens', 'successRate', 'cacheRate'].map((key) => ({ value: key, label: t(`modelUsage.${key}`) }))} onChange={(value) => { setSort(value); setPage(0); }} /><button className={styles.iconButton} aria-label={t(descending ? 'modelUsage.descending' : 'modelUsage.ascending')} onClick={() => setDescending(!descending)}>{descending ? <ArrowDown size={14} /> : <ArrowUp size={14} />}</button></div></header>
    <div className={styles.tableScroll}><table className={styles.rankingTable}><thead><tr><th>{t('modelUsage.mainAgentId')}</th>{['calls', 'tokens', 'successRate', 'cacheRate'].map((key) => <th key={key} aria-sort={sort === key ? descending ? 'descending' : 'ascending' : undefined}><button onClick={() => { setDescending(sort === key ? !descending : true); setSort(key); setPage(0); }}>{t(`modelUsage.${key}`)}{sort === key ? descending ? ' ↓' : ' ↑' : ''}</button></th>)}</tr></thead>
      <tbody>{sorted.slice(activePage * 5, activePage * 5 + 5).map((group) => <tr key={group.id}>
        <td data-field="session"><button className={styles.link} title={group.label || group.id} onClick={() => drill({ mainAgentId: group.id })}>{group.label || group.id}</button><small title={group.id}>{group.id}</small></td>
        <td data-label={t('modelUsage.calls')}>{number(group.summary.calls)}<small>{number(group.summary.requests)} {t('modelUsage.requests')}</small></td><td data-label={t('modelUsage.tokens')}>{group.summary.completeUsage + group.summary.partialUsage ? number(group.summary.tokens) : '—'}</td>
        <td data-label={t('modelUsage.successRate')}>{percent(successRate(group.summary))}</td><td data-label={t('modelUsage.cacheRate')}>{percent(cacheRate(group.summary))}</td>
      </tr>)}</tbody></table></div>
    <footer className={styles.pagination}><span>{t('modelUsage.standalone', { count: groups.find((g) => !g.id)?.summary.calls ?? 0 })}</span><button disabled={!activePage} onClick={() => setPage(activePage - 1)}>{t('modelUsage.previous')}</button><span>{t('modelUsage.page', { page: activePage + 1, pages })}</span><button disabled={activePage + 1 >= pages} onClick={() => setPage(activePage + 1)}>{t('modelUsage.next')}</button></footer>
  </section>;
}
