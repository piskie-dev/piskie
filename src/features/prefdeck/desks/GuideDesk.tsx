import { useTranslation } from 'react-i18next';
import { GuideLibrary } from '../../guides/GuideLibrary';
import styles from '../deck.module.css';

export function GuideDesk() {
  const { t } = useTranslation();
  return (
    <>
      <div className={styles.deskHead}>
        <div className={styles.deskTitle}>{t('guides.library')}</div>
      </div>
      <div className={styles.deskBody}>
        <GuideLibrary />
      </div>
    </>
  );
}
