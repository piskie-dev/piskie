import { memo, useContext } from 'react';
import { Network } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { WorkerNode } from '@/domains/transcript/nodes';
import { workerPresentation } from '../chrome/workerPresentation';
import { isActiveStatus, type StatusKey } from '../data/status';
import { useWorkerActivity } from '../data/useWorkerActivity';
import type { WorkerActivity } from '../data/workerActivity';
import { OrbIndicator } from './OrbIndicator';
import { WorkerActivityVisibility } from './workerActivityVisibility';
import activeTextStyles from './activeText.module.css';
import styles from './thread.module.css';

interface WorkerCreationRowProps {
  readonly cell: WorkerNode;
  readonly mainAgentId?: string;
  readonly activity?: WorkerActivity;
  readonly status?: StatusKey;
  readonly onActivate?: () => void;
}

/** Worker task row with its existing navigation, type icon and activity effects. */
export const WorkerCreationRow = memo<WorkerCreationRowProps>(function WorkerCreationRow(props) {
  const showActivity = useContext(WorkerActivityVisibility);
  return props.mainAgentId && showActivity
    ? <LiveWorkerCreationRow {...props} mainAgentId={props.mainAgentId} />
    : <WorkerRow {...props} activity={showActivity ? props.activity : undefined}
      status={showActivity || props.cell.creating ? props.status : undefined} />;
});

function LiveWorkerCreationRow(props: WorkerCreationRowProps & { mainAgentId: string }) {
  const activity = useWorkerActivity(props.mainAgentId, props.cell.workerId);
  return <WorkerRow {...props} activity={props.cell.creating ? undefined : activity} />;
}

function WorkerRow({ cell, status, onActivate, activity }: WorkerCreationRowProps) {
  const { t } = useTranslation();
  const presentation = cell.workerType ? workerPresentation(cell.workerType) : undefined;
  const Icon = presentation?.icon ?? Network;
  const live = isActiveStatus(status) && !activity?.outcome;
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
        <span className={styles.workerCreationSubject} data-has-action={!!activity?.text}
          title={[cell.subject, activity?.text].filter(Boolean).join(' · ')}>
          <span className={styles.workerCreationTaskTitle}>{cell.subject}</span>
          {activity?.text && <span className={styles.workerCreationAction}> · {activity.text}</span>}
        </span>
      </span>
    </button>
  );
}
