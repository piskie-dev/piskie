import React from 'react';
import { useTranslation } from 'react-i18next';
import { Toggle } from '../../../components/task-definition/controls';
import { useWebSearchStore } from '../../../store/webSearchStore';
import styles from '../deck.module.css';

export const SearchSettingsDesk: React.FC = () => {
  const { t } = useTranslation();
  const { config, setEnabled, isApplying } = useWebSearchStore();
  if (!config) return null;
  return <div className={styles.deskBody}>
    <div className={styles.slab}>
      <div className={styles.slabCap}>{t('settings.webSearch.title')}</div>
      <div className={styles.rowLine}>
        <span className={styles.rowMain}>
          <span className={styles.rowName}>{t('settings.webSearch.enabled')}</span>
          <span className={styles.rowNote}>{t('settings.webSearch.enabledHint')}</span>
        </span>
        <Toggle on={config.enabled} disabled={isApplying} ariaLabel={t('settings.webSearch.enabled')}
          onFlip={(enabled) => void setEnabled(enabled)} />
      </div>
      <div className={styles.fieldNote}>{t('settings.webSearch.anonymousHint')}</div>
      <div className={styles.fieldNote}>{t('settings.webSearch.current', {
        name: config.defaultProvider ? config.providers[config.defaultProvider]?.displayName : t('settings.webSearch.noSelection'),
      })}</div>
    </div>
  </div>;
};
