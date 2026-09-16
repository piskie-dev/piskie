import { memo } from 'react';
import { Network } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { WorkerNode } from '@/domains/transcript/nodes';
import { workerPresentation } from '../chrome/workerPresentation';
import { isActiveStatus, type StatusKey } from '../data/status';
import { OrbIndicator } from './OrbIndicator';
import activeTextStyles from './activeText.module.css';
import styles from './thread.module.css';

interface WorkerCreationRowProps {
  readonly cell: WorkerNode;
  readonly status?: StatusKey;
  readonly onActivate?: () => void;
}

/** Worker task row with its existing navigation, type icon and activity effects. */
export const WorkerCreationRow = memo<WorkerCreationRowProps>(function WorkerCreationRow({
  cell, status, onActivate,
}) {
  const { t } = useTranslation();
  const presentation = cell.workerType ? workerPresentation(cell.workerType) : undefined;
  const Icon = presentation?.icon ?? Network;
  const live = isActiveStatus(status);
  return (
    <button
      className={styles.workerCreation}
      type="button"
      disabled={!onActivate}
      onClick={onActivate}
      data-clickable={!!onActivate}
      data-live={live}
    >
      <span className={styles.workerCreationIcon} aria-hidden>
        {live ? <OrbIndicator size={14} variant="expanding" /> : <Icon size={14} />}
      </span>
      <span className={`${styles.workerCreationText} ${live ? activeTextStyles.text : ''}`}>
        <span className={styles.workerCreationLabel}>{t(cell.titleKey, cell.titleArgs ?? {})}</span>
        {presentation && (
          <span className={styles.workerCreationType} title={t(presentation.labelKey)}>
            {t(presentation.shortLabelKey)}
          </span>
        )}
        <span className={styles.workerCreationSubject} title={cell.subject}>{cell.subject}</span>
      </span>
    </button>
  );
});
