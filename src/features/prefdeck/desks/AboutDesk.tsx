/**
 * 关于页（重写）。
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Globe2 } from 'lucide-react';

import styles from '../deck.module.css';
import logo128 from '/logo-128.png';

export const AboutDesk: React.FC = () => {
  const { t } = useTranslation();
  const version = window.piskie.runtime.version;

  return (
    <>
      <div className={styles.deskHead}>
        <span className={styles.deskIdent}>
          <div className={styles.deskTitle}><span>{t('settings.tabs.about')}</span></div>
          <div className={styles.deskSub}>{t('settings.about.deckSubtitle')}</div>
        </span>
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

          <div className={styles.fieldNote} style={{ textAlign: 'center' }}>
            {t('settings.about.productSynopsis')}
          </div>

          <button
            type="button"
            className={styles.btn}
            onClick={() => void window.piskie.desktop.system.openExternal('https://piskie.dev')}
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
