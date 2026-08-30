import { ChevronRight, LoaderCircle, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ContextInspectorResourceSnapshot } from './context-inspector-resource';
import { projectContextLedger } from './ledger-projection';
import styles from './context-inspector.module.css';

export function ContextBreakdown({
  resource,
  agentId,
  onInspect,
  onRetry,
}: {
  readonly resource: ContextInspectorResourceSnapshot;
  readonly agentId: string;
  readonly onInspect: () => void;
  readonly onRetry: () => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  if (resource.agentId !== agentId || resource.phase === 'opening') {
    return (
      <div className={styles.breakdownState}>
        <LoaderCircle size={16} className="animate-spin" />
        <span>{t('contextUi.loading')}</span>
      </div>
    );
  }
  if (resource.phase === 'failed' && !resource.snapshot) {
    return (
      <div className={styles.breakdownState} data-error>
        <TriangleAlert size={16} />
        <span>{resource.error}</span>
        <button type="button" onClick={onRetry}>{t('contextUi.breakdown.retry')}</button>
      </div>
    );
  }
  if (!resource.snapshot) return null;

  const projection = projectContextLedger(resource.snapshot, resource.generation, {
    systemPrompt: t('contextUi.projection.systemPrompt'),
    assistant: t('contextUi.projection.assistant'),
    toolResult: t('contextUi.projection.toolResult'),
    contextSummary: t('contextUi.projection.contextSummary'),
    user: t('contextUi.projection.user'),
    emptyContent: t('contextUi.projection.emptyContent'),
  });
  const usage = resource.snapshot.usage;
  return (
    <div className={styles.breakdown}>
      <header>
        <span>{t('contextUi.breakdown.used')}</span>
        <strong>{formatTokens(usage.tokens, locale)} / {formatTokens(usage.limit, locale)}</strong>
        <em>{usage.percentage === undefined ? '—' : `${Math.round(usage.percentage)}%`}</em>
      </header>
      <dl>
        <div><dt>{t('contextUi.breakdown.systemPrompt')}</dt><dd>{t('contextUi.itemCount', { count: projection.counts.system })}</dd></div>
        <div><dt>{t('contextUi.breakdown.toolDefinitions')}</dt><dd>{t('contextUi.itemCount', { count: projection.counts.tool })}</dd></div>
        <div><dt>{t('contextUi.breakdown.messages')}</dt><dd>{t('contextUi.itemCount', { count: projection.counts.message })}</dd></div>
      </dl>
      <button type="button" className={styles.inspectAction} onClick={onInspect}>
        {t('contextUi.breakdown.inspect')}
        <ChevronRight size={14} />
      </button>
    </div>
  );
}

function formatTokens(value: number | undefined, locale: string): string {
  return value === undefined ? '—' : new Intl.NumberFormat(locale).format(value);
}
