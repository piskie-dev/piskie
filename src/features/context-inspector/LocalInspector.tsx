import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ContextLedgerRow } from './ledger-projection';
import { CopyButton, MessageBlocks } from './block-renderers';
import { CompactionHistory } from './CompactionHistory';
import { formatRequestTokenCheckpoint } from './format-request-token-checkpoint';
import { safeJson } from './ledger-projection';
import { LinkedMarkdown } from '@/components/content-links';
import styles from './context-inspector.module.css';

type InspectorView = 'content' | 'raw';

export function LocalInspector({
  row,
  agentId,
  paneRef,
}: {
  readonly row: ContextLedgerRow | null;
  readonly agentId: string;
  readonly paneRef?: React.RefObject<HTMLElement>;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const [view, setView] = useState<InspectorView>('content');

  if (!row) {
    return (
      <section ref={paneRef} className={styles.localInspector}>
        <div className={styles.inspectorEmpty}>
          <p>{t('contextUi.inspector.empty')}</p>
        </div>
      </section>
    );
  }

  const views = row.kind === 'tool'
    ? [{ id: 'raw' as const, label: t('contextUi.inspector.rawDefinition') }]
    : [
        { id: 'content' as const, label: t('contextUi.inspector.content') },
        { id: 'raw' as const, label: t('contextUi.inspector.raw') },
      ];

  return (
    <section ref={paneRef} className={styles.localInspector}>
      <header className={styles.localHeader}>
        <div>
          <h2>{row.title}</h2>
          <p>
            {rowPosition(row, t)}
            {row.kind === 'message' && row.inputTokens !== undefined
              ? ` · ${formatRequestTokenCheckpoint(row.inputTokens, row.inputTokenDelta, locale)}`
              : ''}
          </p>
        </div>
        <CopyButton value={rowCopyValue(row)} label={t('contextUi.inspector.copyCurrent')} />
      </header>

      {views.length > 1 && (
        <div className={styles.localTabs} role="tablist" aria-label={t('contextUi.inspector.viewAria')}>
          {views.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              role="tab"
              aria-selected={view === candidate.id}
              data-active={view === candidate.id || undefined}
              onClick={() => setView(candidate.id)}
            >
              {candidate.label}
            </button>
          ))}
        </div>
      )}

      <div className={styles.localBody}>
        {row.kind === 'system' && view === 'content' && (
          <article className={styles.systemDocument}>
            <LinkedMarkdown>{row.text}</LinkedMarkdown>
          </article>
        )}
        {row.kind === 'system' && view === 'raw' && (
          <pre className={`${styles.json} ${styles.rawDocument}`}>{row.text}</pre>
        )}
        {row.kind === 'tool' && (
          <pre className={`${styles.json} ${styles.rawDocument}`}>{safeJson(row.tool)}</pre>
        )}
        {row.kind === 'message' && view === 'content' && (
          <>
            <MessageBlocks message={row.message} />
            {row.message.subtype === 'context_summary' && (
              <CompactionHistory agentId={agentId} />
            )}
          </>
        )}
        {row.kind === 'message' && view === 'raw' && (
          <pre className={`${styles.json} ${styles.rawDocument}`}>{safeJson(row.message)}</pre>
        )}
      </div>
    </section>
  );
}

function rowCopyValue(row: ContextLedgerRow): string {
  if (row.kind === 'system') return row.text;
  if (row.kind === 'tool') return safeJson(row.tool);
  return safeJson(row.message);
}

function rowPosition(row: ContextLedgerRow, translate: (key: string, values?: Record<string, number>) => string): string {
  if (row.kind === 'system') return translate('contextUi.inspector.systemPrompt');
  if (row.kind === 'tool') return translate('contextUi.inspector.toolPosition', { number: row.toolIndex + 1 });
  if (row.message.role === 'assistant') {
    return translate('contextUi.inspector.assistantPosition', { number: row.messageIndex + 1 });
  }
  const isResult = Array.isArray(row.message.content)
    && row.message.content.length > 0
    && row.message.content.every((block) => block.type === 'tool_result');
  return translate(
    isResult ? 'contextUi.inspector.resultPosition' : 'contextUi.inspector.userPosition',
    { number: row.messageIndex + 1 },
  );
}
