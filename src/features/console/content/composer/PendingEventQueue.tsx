import { memo } from 'react';
import { MessageSquareMore } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { PendingAgentEventView } from '../../../../../shared/types/agent-control';
import runtimeStyles from '../mcpRuntimeCard.module.css';
import styles from './pendingEventQueue.module.css';

const SOURCE_LABEL_KEYS: Record<PendingAgentEventView['source'], string> = {
  user: 'sessionWorkbenchUi.queuedEvent.user',
  api: 'API',
  webhook: 'Webhook',
  system: 'sessionWorkbenchUi.queuedEvent.system',
  browser: 'sessionWorkbenchUi.queuedEvent.browser',
  module: 'sessionWorkbenchUi.queuedEvent.module',
  parent: 'sessionWorkbenchUi.queuedEvent.parentAgent',
  subagent: 'sessionWorkbenchUi.queuedEvent.childAgent',
};

function formatContent(content: PendingAgentEventView['content']): string {
  return typeof content === 'string' ? content : (JSON.stringify(content) || '{}');
}

function summaryOf(
  event: PendingAgentEventView,
  showSource: boolean,
  translate: (key: string, values?: Record<string, string | number>) => string,
): string {
  const content = formatContent(event.content);
  const displayContent = content || (event.imageCount > 0
    ? translate('sessionWorkbenchUi.queuedEvent.imageAttachment')
    : translate('sessionWorkbenchUi.queuedEvent.empty'));
  const sourceLabelKey = SOURCE_LABEL_KEYS[event.source];
  const sourceLabel = sourceLabelKey.includes('.') ? translate(sourceLabelKey) : sourceLabelKey;
  const source = showSource
    ? translate('sessionWorkbenchUi.queuedEvent.sourcePrefix', { source: sourceLabel })
    : '';
  const meta = [
    event.priority === 'high'
      ? translate('sessionWorkbenchUi.queuedEvent.highPriority')
      : event.priority === 'low'
        ? translate('sessionWorkbenchUi.queuedEvent.lowPriority')
        : undefined,
    event.imageCount > 0
      ? translate('sessionWorkbenchUi.queuedEvent.imageCount', { count: event.imageCount })
      : undefined,
  ].filter((item): item is string => Boolean(item));

  const contentWithMeta = meta.length > 0
    ? translate('sessionWorkbenchUi.queuedEvent.summaryMeta', { content: displayContent, meta: meta.join(' · ') })
    : displayContent;
  return `${source}${contentWithMeta}`;
}

export interface PendingEventQueueProps {
  readonly events: readonly PendingAgentEventView[];
}

/** Mailbox 队列的纯展示视图；延迟显隐完全由 CSS 负责。 */
export const PendingEventQueue = memo<PendingEventQueueProps>(({ events }) => {
  const { t } = useTranslation();
  if (events.length === 0) return null;

  const showSource = events.some((event) => event.source !== 'user')
    || new Set(events.map((event) => event.source)).size > 1;
  const summaries = events.map((event) => summaryOf(
    event,
    showSource,
    (key, values) => t(key, values ?? {}),
  ));

  return (
    <section
      className={styles.reveal}
      aria-label={t('sessionWorkbenchUi.queuedEvent.pendingCount', { count: events.length })}
      aria-live="polite"
    >
      <div className={styles.clip}>
        <div className={runtimeStyles.status}>
          <div className={runtimeStyles.line}>
            <MessageSquareMore aria-hidden />
            <span className={runtimeStyles.copy} title={summaries.join('\n')}>
              <strong>{t('sessionWorkbenchUi.queuedEvent.pendingCount', { count: events.length })}</strong>
              <span className={runtimeStyles.names}>
                {events.map((event, index) => (
                  <span
                    key={event.id}
                    className={styles.event}
                    data-event-id={event.id}
                    data-source={event.source}
                    data-priority={event.priority}
                  >
                    {index === 0 ? ': ' : ' · '}{summaries[index]}
                  </span>
                ))}
              </span>
            </span>
          </div>
        </div>
      </div>
    </section>
  );
});

PendingEventQueue.displayName = 'PendingEventQueue';
