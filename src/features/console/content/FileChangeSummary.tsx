import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { ActivityChips } from '../data/activity';
import styles from './fileChangeSummary.module.css';

export interface FileChangeSummaryProps {
  readonly changes: Pick<ActivityChips, 'filesChanged' | 'added' | 'removed'>;
}

export const FileChangeSummary = memo<FileChangeSummaryProps>(({ changes }) => {
  const { t } = useTranslation();
  if (changes.filesChanged === 0) return null;

  const label = t('sessionWorkbenchUi.fileChanges.filesChanged', { count: changes.filesChanged });
  const lines = t('sessionWorkbenchUi.fileChanges.lines', { added: changes.added, removed: changes.removed });

  return (
    <div className={styles.row}>
      <div className={styles.summary} role="group" aria-label={`${label} · ${lines}`} title={lines}>
        <span className={styles.label}>{label}</span>
        <span className={styles.diff} aria-hidden="true">
          <span className={styles.added}>+{changes.added}</span>
          <span className={styles.removed}>-{changes.removed}</span>
        </span>
      </div>
    </div>
  );
});

FileChangeSummary.displayName = 'FileChangeSummary';
