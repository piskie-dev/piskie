import React, { useRef, useState } from 'react';
import { CircleArrowUp, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { PopShell } from '../../components/shared/PopShell';
import { useUpdateStatus } from '../updates/useUpdateStatus';
import styles from './skybar.module.css';

export const UpdateIndicator: React.FC = () => {
  const status = useUpdateStatus();
  if (status?.state !== 'downloaded') return null;
  return <DownloadedUpdateIndicator version={status.target.version} />;
};

const DownloadedUpdateIndicator: React.FC<{ version: string }> = ({ version }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const openAtPointerDown = useRef(false);

  const restartAndInstall = async (): Promise<void> => {
    if (pending) return;
    setPending(true);
    try {
      const accepted = await window.piskie.updates.restartAndInstall().catch(() => false);
      if (accepted) setOpen(false);
    } finally {
      setPending(false);
    }
  };

  const triggerLabel = t('skybar.update.available');
  return (
    <PopShell
      open={open}
      onClose={() => setOpen(false)}
      placement="block-end"
      triggerClassName={styles.updateAnchor}
      trigger={(
        <button
          type="button"
          className={styles.updateTrigger}
          aria-label={triggerLabel}
          aria-expanded={open}
          aria-haspopup="dialog"
          title={triggerLabel}
          onPointerDown={() => {
            openAtPointerDown.current = open;
          }}
          onClick={(event) => {
            const wasOpen = event.detail === 0 ? open : openAtPointerDown.current;
            setOpen(!wasOpen);
          }}
        >
          <CircleArrowUp size={15} aria-hidden="true" />
          <span>{t('skybar.update.newVersion')}</span>
        </button>
      )}
    >
      <div className={styles.updatePanel} role="dialog" aria-label={triggerLabel}>
        <div className={styles.updatePanelCopy}>
          <strong>{t('skybar.update.title')}</strong>
          <span>{t('skybar.update.ready', { version })}</span>
        </div>
        <div className={styles.updatePanelActions}>
          <button type="button" onClick={() => setOpen(false)}>
            {t('skybar.update.later')}
          </button>
          <button
            type="button"
            className={styles.updatePanelPrimary}
            disabled={pending}
            onClick={() => void restartAndInstall()}
          >
            {pending && <LoaderCircle className={styles.updateSpin} size={13} aria-hidden="true" />}
            {t('settings.about.restartAndUpdate')}
          </button>
        </div>
      </div>
    </PopShell>
  );
};
