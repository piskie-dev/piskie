import { memo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ActivityChips } from '../data/activity';
import styles from './fileChangeSummary.module.css';

export interface FileChangeSummaryProps {
  readonly changes: Pick<ActivityChips, 'filesChanged' | 'added' | 'removed'>;
  readonly expanded?: boolean;
  readonly onToggle?: () => void;
  readonly inline?: boolean;
}

export const FileChangeSummary = memo<FileChangeSummaryProps>(({ changes, expanded = false, onToggle, inline = false }) => {
  const { t } = useTranslation();
  if (changes.filesChanged === 0) return null;

  const label = t('sessionWorkbenchUi.fileChanges.filesChanged', { count: changes.filesChanged });
  const lines = t('sessionWorkbenchUi.fileChanges.lines', { added: changes.added, removed: changes.removed });

  return (
    <div className={inline ? styles.inline : styles.row}>
      <button type="button" className={styles.summary} aria-label={`${label} · ${lines}`} title={lines} aria-expanded={expanded} onClick={onToggle}>
        <span className={styles.label}>{label}</span>
        <span className={styles.diff} aria-hidden="true">
          <span className={styles.added}>+{changes.added}</span>
          <span className={styles.removed}>-{changes.removed}</span>
        </span>
        {expanded ? <ChevronLeft size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
      </button>
    </div>
  );
});

FileChangeSummary.displayName = 'FileChangeSummary';
