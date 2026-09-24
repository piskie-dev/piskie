import { useEffect, useState } from 'react';
import { MessagesSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMessagingStore } from '../../store/messagingStore';
import styles from '../skybar/skybar.module.css';

export function MessagingHealthCue({ onOpen }: { readonly onOpen: () => void }) {
  const { t } = useTranslation();
  const connections = useMessagingStore((state) => state.connections);
  const fetchConnections = useMessagingStore((state) => state.fetchConnections);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let mounted = true;
    void fetchConnections().then((result) => {
      if (mounted && result.kind === 'refreshed') setReady(true);
    });
    return () => { mounted = false; };
  }, [fetchConnections]);

  if (!ready) return null;
  const isEmpty = connections.length === 0;
  const runningCount = connections.filter(({ status }) => status === 'running').length;
  const stoppedCount = connections.filter(({ status }) => status === 'stopped').length;
  const errorCount = connections.filter(({ status }) => status === 'error').length;
  if (!isEmpty && runningCount + stoppedCount + errorCount === 0) return null;

  const label = isEmpty
    ? t('imPlugin.health.setup')
    : runningCount > 0
      ? t('imPlugin.health.startedCount', { count: runningCount })
      : errorCount > 0
        ? t('imPlugin.health.errorCount', { count: errorCount })
        : t('imPlugin.health.stoppedCount', { count: stoppedCount });
  const hint = isEmpty
    ? t('imPlugin.health.setupHint')
    : [
        [
          runningCount > 0 && t('imPlugin.health.startedCount', { count: runningCount }),
          stoppedCount > 0 && t('imPlugin.health.stoppedCount', { count: stoppedCount }),
          errorCount > 0 && t('imPlugin.health.errorCount', { count: errorCount }),
        ].filter(Boolean).join(' · '),
        runningCount > 0 && t('imPlugin.health.startedHint'),
        stoppedCount > 0 && t('imPlugin.health.stoppedHint'),
        errorCount > 0 && t('imPlugin.health.errorHint'),
      ].filter(Boolean).join(' ');
  return (
    <button type="button" className={styles.lamp} data-tone={runningCount > 0 ? undefined : errorCount > 0 ? 'halt' : 'hold'} title={hint} aria-label={`${label}: ${hint}`} onClick={onOpen}>
      <MessagesSquare size={14} aria-hidden />
      {label}
    </button>
  );
}
