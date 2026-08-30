import { useState } from 'react';
import { Archive, ChevronDown, ChevronRight, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  CompactionHistoryView,
  CompactionMessageView,
  CompactionSummaryView,
} from '@shared/types/context';
import { MessageBlocks } from './block-renderers';
import styles from './context-inspector.module.css';

export function CompactionHistory({ agentId }: { readonly agentId: string }) {
  const { t } = useTranslation();
  const [history, setHistory] = useState<CompactionHistoryView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setHistory(await window.piskie.agentRuns.listCompactions(agentId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  if (!history) {
    return (
      <section className={styles.archiveGate}>
        <div>
          <Archive size={16} />
          <span>{t('contextUi.history.title')}</span>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading}>
          {loading && <LoaderCircle size={14} className="animate-spin" />}
          {error ? t('contextUi.history.retry') : t('contextUi.history.view')}
        </button>
        {error && <small>{error}</small>}
      </section>
    );
  }

  if (history.summaries.length === 0) return null;
  return (
    <section className={styles.archive}>
      <header>
        <span>{t('contextUi.history.title')}</span>
        <strong>{t('contextUi.history.phaseCount', { count: history.stats.totalCompactions })}</strong>
      </header>
      {history.summaries.map((summary, index) => (
        <CompactionPhase
          key={summary.id}
          agentId={agentId}
          summary={summary}
          index={index}
          current={index === history.summaries.length - 1}
        />
      ))}
    </section>
  );
}

function CompactionPhase({ agentId, summary, index, current }: {
  readonly agentId: string;
  readonly summary: CompactionSummaryView;
  readonly index: number;
  readonly current: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState<CompactionMessageView[]>([]);
  const [nextOffset, setNextOffset] = useState<number | undefined>(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPage = async () => {
    if (loading || nextOffset === undefined || !summary.hasOriginalMessages) return;
    setLoading(true);
    setError(null);
    try {
      const page = await window.piskie.agentRuns.originalCompactionMessages({
        agentId,
        summaryId: summary.id,
        offset: nextOffset,
        limit: 50,
      });
      setMessages((currentMessages) => [...currentMessages, ...page.items]);
      setNextOffset(page.nextOffset);
      setTotal(page.total);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && messages.length === 0) void loadPage();
  };

  return (
    <article className={styles.archivePhase}>
      <button type="button" onClick={toggle}>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span>{t('contextUi.history.phase', { number: String(index + 1).padStart(2, '0') })}</span>
        {current && <em>{t('contextUi.history.current')}</em>}
        <small>{t('contextUi.history.messageCount', {
          count: summary.compressedCount,
          tokens: summary.originalTokens.toLocaleString(i18n.resolvedLanguage ?? i18n.language),
        })}</small>
      </button>
      {expanded && (
        <div className={styles.archiveMessages}>
          {!summary.hasOriginalMessages && <p>{t('contextUi.history.originalsUnavailable')}</p>}
          {messages.map((message, messageIndex) => (
            <article key={`${summary.id}:${messageIndex}`} className={styles.archiveMessage}>
              <header>
                <span>{roleLabel(message.role, t)}{message.subtype ? ` / ${message.subtype}` : ''}</span>
              </header>
              <MessageBlocks message={message} />
            </article>
          ))}
          {error && <p className={styles.inlineError}>{error}</p>}
          {nextOffset !== undefined && summary.hasOriginalMessages && (
            <button type="button" className={styles.loadMore} onClick={() => void loadPage()} disabled={loading}>
              {loading
                ? t('contextUi.history.loading')
                : t('contextUi.history.loadMore', {
                    loaded: messages.length,
                    total: total || summary.compressedCount,
                  })}
            </button>
          )}
        </div>
      )}
    </article>
  );
}

function roleLabel(role: string, translate: (key: string) => string): string {
  if (role === 'assistant') return translate('contextUi.filterAssistant');
  if (role === 'user') return translate('contextUi.filterUser');
  if (role === 'system') return translate('contextUi.filterSystem');
  if (role === 'tool') return translate('contextUi.filterTool');
  return role;
}
