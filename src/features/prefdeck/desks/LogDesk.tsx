/**
 * 系统日志页（重写）。
 *
 * 过滤(关键字/作用域·事件(逗号多值)/级别多选/时间预设/起止 datetime-local)、
 * 过滤变更回第一页、日志文件折叠清单、记录行(时间毫秒/级别/事件/作用域/消息/详情)、
 * 详情弹窗(原生 dialog,全字段 + context/error JSON)、分页(可变页大小)、
 * 导出(按当前过滤;用户取消 aborted 静默)、刷新。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Download, RotateCw, X } from 'lucide-react';

import type {
  LogEntry,
  SystemLogFileSummary,
  SystemLogQuery,
} from '../../../../shared/types';
import { useNativeDialog } from '../../../components/task-definition/useNativeDialog';
import { messageText, rawText, type PresentationText } from '../../../i18n/presentationText';
import { DeckSelect } from '../bits/DeckSelect';
import styles from '../deck.module.css';

const LEVELS = ['error', 'warn', 'info', 'debug'] as const;
const PAGE_SIZES = ['20', '50', '100'] as const;

/** 时间预设:小时数或日历口径 */
const TIME_PRESETS = [
  { value: '1', labelKey: 'logs.pastHour' },
  { value: '6', labelKey: 'logs.pastSixHours' },
  { value: '24', labelKey: 'logs.pastDay' },
  { value: 'today', labelKey: 'logs.sinceMidnight' },
  { value: 'week', labelKey: 'logs.currentWeek' },
] as const;

function inElectron(): boolean {
  return typeof window !== 'undefined' && window.piskie?.runtime.host === 'electron';
}

function splitTerms(text: string): string[] | undefined {
  const terms = text.split(',').map((term) => term.trim()).filter(Boolean);
  return terms.length > 0 ? terms : undefined;
}

function preciseStamp(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} `
    + `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`;
}

/** Date → datetime-local 值(本地时区) */
function toLocalInput(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

export const LogDesk: React.FC<{
  readonly onFlash: (text: PresentationText, tone?: 'halt' | 'hold' | 'calm') => void;
}> = ({ onFlash }) => {
  const { t } = useTranslation();

  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [files, setFiles] = useState<SystemLogFileSummary[]>([]);
  const [filesOpen, setFilesOpen] = useState(false);
  const [focusEntry, setFocusEntry] = useState<LogEntry | null>(null);

  const [keyword, setKeyword] = useState('');
  const [scopeTerms, setScopeTerms] = useState('');
  const [eventTerms, setEventTerms] = useState('');
  const [levels, setLevels] = useState<string[]>([]);
  const [fromAt, setFromAt] = useState('');
  const [tillAt, setTillAt] = useState('');
  const [preset, setPreset] = useState<string | undefined>(undefined);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const detailRef = useNativeDialog(focusEntry !== null, () => setFocusEntry(null));

  const buildQuery = useCallback((paged: boolean): SystemLogQuery => ({
    searchText: keyword || undefined,
    levels: levels.length > 0 ? levels as SystemLogQuery['levels'] : undefined,
    scopes: splitTerms(scopeTerms),
    events: splitTerms(eventTerms),
    startTime: fromAt ? new Date(fromAt) : undefined,
    endTime: tillAt ? new Date(tillAt) : undefined,
    ...(paged ? { limit: pageSize, offset: (page - 1) * pageSize } : {}),
  }), [keyword, levels, scopeTerms, eventTerms, fromAt, tillAt, page, pageSize]);

  const fetchEntries = useCallback(async () => {
    if (!inElectron()) return;
    setLoading(true);
    try {
      const data = await window.piskie.observability.systemLogs.query(buildQuery(true));
      setEntries(data.logs);
      setTotal(data.total);
    } catch {
      onFlash(messageText('logs.loadFailed'), 'halt');
    } finally {
      setLoading(false);
    }
  }, [buildQuery, onFlash]);

  // 文件清单只取一次
  useEffect(() => {
    if (!inElectron()) return;
    let stale = false;
    void window.piskie.observability.systemLogs.files()
      .then((list) => {
        if (!stale) setFiles(list);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, []);

  // 过滤变更回第一页(分页变化不触发)
  const filterKey = `${keyword}|${scopeTerms}|${eventTerms}|${levels.join(',')}|${fromAt}|${tillAt}`;
  const filterKeyRef = useRef(filterKey);
  useEffect(() => {
    if (filterKeyRef.current !== filterKey) {
      filterKeyRef.current = filterKey;
      setPage(1);
    }
  }, [filterKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => void fetchEntries(), 150);
    return () => window.clearTimeout(timer);
  }, [fetchEntries]);

  const applyPreset = (value: string): void => {
    const now = new Date();
    let from: Date;
    if (value === 'today') {
      from = new Date(now);
      from.setHours(0, 0, 0, 0);
    } else if (value === 'week') {
      from = new Date(now);
      from.setDate(now.getDate() - now.getDay());
      from.setHours(0, 0, 0, 0);
    } else {
      from = new Date(now.getTime() - Number(value) * 3_600_000);
    }
    setFromAt(toLocalInput(from));
    setTillAt(toLocalInput(now));
    setPreset(value);
  };

  const exportEntries = async (): Promise<void> => {
    if (!inElectron()) return;
    try {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
        + `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
      const result = await window.piskie.observability.systemLogs.export(
        buildQuery(false),
        `logs_export_${stamp}.json`,
      );
      onFlash(messageText('logs.savedTo', { path: rawText(result.fileName) }));
    } catch (error) {
      if ((error as { code?: string }).code === 'aborted') return;
      onFlash(messageText('logs.saveFailed'), 'halt');
    }
  };

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      <div className={styles.deskHead}>
        <span className={styles.deskIdent}>
          <div className={styles.deskTitle}><span>{t('logs.title')}</span></div>
          <div className={styles.deskSub}>{t('logs.entryCount', { total })}</div>
        </span>
        <span className={styles.headSpring} />
        <span className={styles.headActs}>
          <button type="button" className={styles.btn} disabled={loading} onClick={() => void fetchEntries()}>
            <RotateCw size={13} /> {t('logs.refresh')}
          </button>
          <button type="button" className={styles.btn} disabled={entries.length === 0} onClick={() => void exportEntries()}>
            <Download size={13} /> {t('logs.export')}
          </button>
        </span>
      </div>

      <div className={styles.deskBody}>
        <div className={styles.slab}>
          <div className={styles.slabCap}>{t('logs.filterWorkbench')}</div>
          <div className={styles.filterRack}>
            <span className={styles.textIn}>
              <input
                value={keyword}
                placeholder={t('logs.searchMessages')}
                aria-label={t('logs.searchMessages')}
                onChange={(event) => setKeyword(event.target.value)}
              />
            </span>
            <span className={styles.textIn}>
              <input
                value={scopeTerms}
                placeholder={t('logs.commaListHint', { field: t('logs.scope') })}
                aria-label={t('logs.scope')}
                onChange={(event) => setScopeTerms(event.target.value)}
              />
            </span>
            <span className={styles.textIn}>
              <input
                value={eventTerms}
                placeholder={t('logs.commaListHint', { field: t('logs.event') })}
                aria-label={t('logs.event')}
                onChange={(event) => setEventTerms(event.target.value)}
              />
            </span>
            <span className={styles.filterFixed}>
              <DeckSelect
                ariaLabel={t('logs.timeRange')}
                placeholder={t('logs.timeRange')}
                options={TIME_PRESETS.map((item) => ({ value: item.value, label: t(item.labelKey) }))}
                value={preset}
                onPick={applyPreset}
              />
            </span>
          </div>

          <div className={styles.filterRack} style={{ marginBlockStart: 8, alignItems: 'center' }}>
            <span className={styles.lever} role="group" aria-label={t('logs.logLevel')}>
              {LEVELS.map((level) => (
                <button
                  key={level}
                  type="button"
                  data-on={levels.includes(level)}
                  onClick={() => setLevels((current) => (
                    current.includes(level)
                      ? current.filter((item) => item !== level)
                      : [...current, level]
                  ))}
                >
                  {level.toUpperCase()}
                </button>
              ))}
            </span>
            <span className={`${styles.textIn} ${styles.filterFixed}`} style={{ flexBasis: 190 }}>
              <input
                type="datetime-local"
                value={fromAt}
                aria-label={t('logs.startTime')}
                onChange={(event) => {
                  setFromAt(event.target.value);
                  setPreset(undefined);
                }}
              />
            </span>
            <span className={styles.rowNote}>~</span>
            <span className={`${styles.textIn} ${styles.filterFixed}`} style={{ flexBasis: 190 }}>
              <input
                type="datetime-local"
                value={tillAt}
                aria-label={t('logs.endTime')}
                onChange={(event) => {
                  setTillAt(event.target.value);
                  setPreset(undefined);
                }}
              />
            </span>
            {(fromAt || tillAt) && (
              <button
                type="button"
                className={`${styles.btn} ${styles.btnQuiet}`}
                onClick={() => {
                  setFromAt('');
                  setTillAt('');
                  setPreset(undefined);
                }}
              >
                {t('logs.resetTimeWindow')}
              </button>
            )}
          </div>
        </div>

        {files.length > 0 && (
          <div>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnQuiet}`}
              aria-expanded={filesOpen}
              onClick={() => setFilesOpen((open) => !open)}
            >
              <ChevronRight size={11} style={{ rotate: filesOpen ? '90deg' : '0deg', transition: 'rotate 160ms ease' }} />
              {t('logs.logFiles')} ({files.length})
            </button>
            {filesOpen && (
              <div style={{ marginBlockStart: 6 }}>
                {files.map((file) => {
                  const kb = file.size / 1024;
                  const sizeWord = kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb.toFixed(1)} KB`;
                  return (
                    <span key={file.filename} className={styles.fileChip}>
                      {file.filename}
                      <span className={styles.monoNote}>{sizeWord}</span>
                      {file.modifiedAt && (
                        <span className={styles.monoNote}>{preciseStamp(String(file.modifiedAt)).slice(5, 16)}</span>
                      )}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <div className={styles.slab}>
          <div className={styles.slabCap}>
            {t('logs.streamTitle')}
            <span className={styles.capSpring} />
            {loading && <span style={{ textTransform: 'none' }}>{t('logs.readingEntries')}</span>}
          </div>

          {entries.length === 0 && !loading ? (
            <div className={styles.voidBox}>{t('logs.noMatches')}</div>
          ) : (
            entries.map((entry) => (
              <div key={entry.id} className={styles.logRow}>
                <span className={styles.logTime}>{preciseStamp(entry.timestamp)}</span>
                <span className={styles.lvlBadge} data-l={entry.level}>{entry.level.toUpperCase()}</span>
                <span className={styles.eventCode} title={entry.event}>{entry.event}</span>
                <span className={styles.eventCode} style={{ flexBasis: 130 }} title={entry.scope}>
                  {entry.scope ?? '-'}
                </span>
                <span className={styles.logMsg} title={entry.message}>{entry.message}</span>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnQuiet}`}
                  onClick={() => setFocusEntry(entry)}
                >
                  {t('logs.details')}
                </button>
              </div>
            ))
          )}

          <div className={styles.pageRow} style={{ marginBlockStart: 10 }}>
            <span style={{ inlineSize: 96 }}>
              <DeckSelect
                ariaLabel={t('logs.entriesPerPage')}
                options={PAGE_SIZES.map((size) => ({
                  value: size,
                  label: t('logs.pageSizeChoice', { count: size }),
                }))}
                value={String(pageSize)}
                onPick={(value) => {
                  setPageSize(Number(value));
                  setPage(1);
                }}
              />
            </span>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnQuiet}`}
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              {t('logs.earlierEntries')}
            </button>
            <span>{Math.min(page, pageCount)} / {pageCount}</span>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnQuiet}`}
              disabled={page >= pageCount}
              onClick={() => setPage(page + 1)}
            >
              {t('logs.laterEntries')}
            </button>
          </div>
        </div>
      </div>

      {/* 详情弹窗 */}
      <dialog ref={detailRef} className={styles.forgeShell} aria-label={t('logs.logDetail')}>
        <div className={styles.forgeHead}>
          <span className={styles.forgeTitle}>{t('logs.logDetail')}</span>
          <button type="button" className={styles.orbBtn} aria-label={t('common.close')} onClick={() => setFocusEntry(null)}>
            <X size={14} />
          </button>
        </div>
        {focusEntry && (
          <div className={styles.forgeBody}>
            {/* 元数据一行看尽:级别 / 来源 / 精确时间 */}
            <div className={styles.metaRow}>
              <span className={styles.lvlBadge} data-l={focusEntry.level}>{focusEntry.level.toUpperCase()}</span>
              <span className={styles.chip}>{focusEntry.origin}</span>
              <span className={styles.metaMono}>{preciseStamp(focusEntry.timestamp)}</span>
            </div>

            <section className={styles.forgeSect}>
              <div className={styles.sectCap}>{t('logs.entryFacts')}</div>
              <div className={styles.codeTag}><b>{t('logs.event')}</b>{focusEntry.event}</div>
              {focusEntry.scope && (
                <div className={styles.codeTag}><b>{t('logs.scope')}</b>{focusEntry.scope}</div>
              )}
              <div className={styles.proseBlock}>{focusEntry.message}</div>
            </section>

            {(focusEntry.context || focusEntry.error) && (
              <section className={styles.forgeSect}>
                <div className={styles.sectCap}>{t('logs.context')}</div>
                <pre className={styles.probeFailRaw} style={{ maxBlockSize: 240 }}>
                  {JSON.stringify({ context: focusEntry.context, error: focusEntry.error }, null, 2)}
                </pre>
              </section>
            )}
          </div>
        )}
      </dialog>
    </>
  );
};
