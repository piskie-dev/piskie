import { ArrowUpRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../console/chrome/Dialog';
import type { GuideId } from './catalog';
import { PlanModeScene } from './PlanModeScene';
import { WorkflowScene } from './WorkflowScene';
import styles from './guides.module.css';

export function FeatureGuideDialog({ id, open, onClose, onComplete, onAction, actionKey = 'guides.tryIt' }: {
  readonly id: GuideId;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onComplete: () => void;
  readonly onAction: () => void;
  readonly actionKey?: string;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onClose={onClose} ariaLabel={`${t('guides.introduction')} · ${t(`guides.items.${id}.title`)}`} width={800} className={styles.dialog} bodyClassName={styles.dialogBody}>
      <div className={styles.demoFrame}>
        {open && (id === 'getting-started' ? <PlanModeScene /> : <WorkflowScene id={id} />)}
      </div>
      <p className={styles.srOnly}>{t(`guides.items.${id}.summary`)}</p>
      <footer className={styles.footer}>
        <button type="button" className={styles.tryButton} onClick={() => { onComplete(); onAction(); }}>{t(actionKey)}<ArrowUpRight size={13} aria-hidden /></button>
        <button type="button" className={styles.completeButton} onClick={onComplete}>{t('guides.understood')}</button>
      </footer>
    </Dialog>
  );
}
