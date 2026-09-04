/**
 * 关于页（重写）。
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Globe2, LoaderCircle, RefreshCw, RotateCcw } from 'lucide-react';

import type { PiskieUpdateStatus } from '@shared/electron-contracts/updates';
import styles from '../deck.module.css';
import logo128 from '/logo-128.png';

const ABOUT_TITLE_ID = 'piskie-about-title';

export const AboutDesk: React.FC = () => {
  const { t } = useTranslation();
  const version = window.piskie.runtime.version;
  const [updateStatus, setUpdateStatus] = useState<PiskieUpdateStatus>();
  const [updateActionPending, setUpdateActionPending] = useState(false);

  useEffect(() => {
    let active = true;
    const apply = (status: PiskieUpdateStatus): void => {
      if (active) setUpdateStatus(status);
    };
    const unsubscribe = window.piskie.updates.observeStatus(apply);
    void window.piskie.updates.status().then(apply).catch(() => {
      apply({
        state: 'error',
        currentVersion: version,
        error: 'generic',
        checkedAt: new Date().toISOString(),
        retryable: true,
      });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [version]);

  const runUpdateAction = async (): Promise<void> => {
    if (!updateStatus || updateActionPending) return;
    setUpdateActionPending(true);
    try {
      if (updateStatus.state === 'downloaded') {
        await window.piskie.updates.restartAndInstall();
        return;
      }
      const status = await window.piskie.updates.check();
      setUpdateStatus(status);
    } catch {
      setUpdateStatus({
        state: 'error',
        currentVersion: version,
        error: 'generic',
        checkedAt: new Date().toISOString(),
        retryable: true,
      });
    } finally {
      setUpdateActionPending(false);
    }
  };

  const actionBusy = updateActionPending
    || updateStatus?.state === 'checking'
    || updateStatus?.state === 'available'
    || updateStatus?.state === 'downloading';
  const actionDisabled = !updateStatus
    || updateStatus.state === 'disabled'
    || actionBusy;
  const updateText = updateStatusText(updateStatus, t);

  return (
    <>
      <div className={styles.deskHead}>
        <div className={styles.deskIdent}>
          <h1 id={ABOUT_TITLE_ID} className={styles.deskTitle}>
            <span>{t('settings.tabs.about')}</span>
          </h1>
          <div className={styles.deskSub}>{t('settings.about.deckSubtitle')}</div>
        </div>
      </div>

      <div className={styles.deskBody}>
        <div className={styles.aboutStack}>
          <img src={logo128} alt="Piskie" className={`${styles.aboutBadge} app-logo-adaptive`} />
          <div>
            <div className={styles.aboutTitle}>piskie</div>
            <div className={styles.fieldNote} style={{ textAlign: 'center' }}>
              {t('console.entryPromise')}
            </div>
          </div>

          <div className={styles.aboutRow}>
            {t('settings.about.version')}
            <span className={styles.monoNote} style={{ fontSize: 11.5 }}>{version}</span>
          </div>
          <div className={styles.aboutRow}>
            {t('settings.about.status')}
            <span className={styles.chip} data-state="prime">{t('settings.about.releaseStage')}</span>
          </div>
          <div className={`${styles.aboutRow} ${styles.aboutUpdateRow}`} aria-busy={actionBusy}>
            <span className={styles.aboutUpdateCopy}>
              <span>{t('settings.about.update')}</span>
              <span
                className={styles.aboutUpdateText}
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                {updateText}
              </span>
            </span>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnQuiet} ${styles.aboutUpdateButton}`}
              disabled={actionDisabled}
              onClick={() => void runUpdateAction()}
              title={updateStatus?.state === 'downloaded'
                ? t('settings.about.restartAndUpdate')
                : t('settings.about.checkForUpdates')}
            >
              {updateStatus?.state === 'downloaded'
                ? <RotateCcw size={13} />
                : actionBusy
                  ? <LoaderCircle size={13} className={styles.accountSpin} />
                  : <RefreshCw size={13} />}
              {updateStatus?.state === 'downloaded'
                ? t('settings.about.restartAndUpdate')
                : t('settings.about.checkForUpdates')}
            </button>
            {updateStatus?.state === 'downloading' && (
              <span className={styles.aboutUpdateProgress} aria-hidden="true">
                <span style={{ inlineSize: `${Math.round(updateStatus.percent)}%` }} />
              </span>
            )}
          </div>

          <div className={styles.fieldNote} style={{ textAlign: 'center' }}>
            {t('settings.about.productSynopsis')}
          </div>

          <button
            type="button"
            className={styles.btn}
            onClick={() => void window.piskie.desktop.system.openExternal('https://www.piskie.dev')}
          >
            <Globe2 size={13} /> {t('settings.about.website')}
          </button>

          <div className={styles.fieldNote}>
            {t('settings.about.credit')}
          </div>
        </div>
      </div>
    </>
  );
};

function updateStatusText(
  status: PiskieUpdateStatus | undefined,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  if (!status) return t('settings.about.updateLoading');
  switch (status.state) {
    case 'disabled':
      return t(`settings.about.updateDisabled.${status.reason}`);
    case 'idle':
      return t('settings.about.updateIdle');
    case 'checking':
      return t('settings.about.updateChecking');
    case 'up-to-date':
      return t('settings.about.updateCurrent');
    case 'available':
      return t('settings.about.updateAvailable', { version: status.target.version });
    case 'downloading':
      return t('settings.about.updateDownloading', {
        version: status.target.version,
        percent: Math.round(status.percent),
      });
    case 'downloaded':
      return t('settings.about.updateDownloaded', { version: status.target.version });
    case 'error':
      return t(`settings.about.updateErrors.${status.error}`);
  }
}
