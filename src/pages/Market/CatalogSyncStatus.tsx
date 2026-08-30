import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, LoaderCircle, RefreshCw } from 'lucide-react';

import type { CatalogSyncState } from '../../store/marketStore';
import styles from './market.module.css';

interface CatalogSyncHintProps {
  sync: CatalogSyncState;
  reading: boolean;
  failed: boolean;
  message?: string;
  onRetry: () => void;
}

export const CatalogSyncHint: React.FC<CatalogSyncHintProps> = ({
  sync,
  reading,
  failed,
  message,
  onRetry,
}) => {
  const { t } = useTranslation();
  const activeSources = sync.sources.filter((source) => (
    source.status === 'pending' || source.status === 'syncing'
  ));
  const activeLabel = activeSources.length > 1
    ? t('marketUi.catalog.multipleSources', {
        name: activeSources[0]!.name,
        count: activeSources.length,
      })
    : activeSources[0]?.name;
  const label = failed
    ? t('marketUi.catalog.syncFailed')
    : reading
      ? t('marketUi.catalog.reading')
      : activeLabel
        ? t('marketUi.catalog.syncingNamed', { name: activeLabel })
        : t('marketUi.catalog.syncing');

  return (
    <div
      className={`${styles.catalogSyncHint} ${failed ? styles.catalogSyncHintFailed : ''}`}
      role="status"
      aria-live="polite"
      aria-busy={!failed}
    >
      {failed
        ? <AlertTriangle aria-hidden />
        : <LoaderCircle className={styles.spin} aria-hidden />}
      <strong>{label}</strong>
      {!failed && sync.total > 0 && (
        <span>{sync.completed}/{sync.total}</span>
      )}
      {failed && message && <small title={message}>{message}</small>}
      {failed && (
        <button type="button" onClick={onRetry}>
          <RefreshCw aria-hidden />
          {t('marketUi.catalog.retry')}
        </button>
      )}
    </div>
  );
};
