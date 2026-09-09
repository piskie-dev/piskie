import React from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { useNativeDialog } from '../../../components/task-definition/useNativeDialog';
import { useWebSearchStore } from '../../../store/webSearchStore';
import { BrandMark } from '../bits/BrandMark';
import styles from '../deck.module.css';

export const SearchPresetForge: React.FC<{ onClose(): void; onAdded(id: string): void }> = ({ onClose, onAdded }) => {
  const { t } = useTranslation();
  const dialogRef = useNativeDialog(true, onClose);
  const { config, presets, addProvider, isApplying } = useWebSearchStore();
  const available = presets.filter((preset) => !config?.providers[preset.id]);
  return <dialog ref={dialogRef} className={styles.forgeShell} data-wall="true" aria-label={t('settings.preset.addProvider')}>
    <div className={styles.forgeHead}>
      <span className={styles.forgeTitle}>{t('settings.preset.addProvider')}<span className={styles.forgeSub}>{t('settings.webSearch.title')}</span></span>
      <button type="button" className={styles.orbBtn} aria-label={t('common.close')} onClick={onClose}><X size={14} /></button>
    </div>
    <div className={styles.forgeBody}>
      {available.length === 0 ? <div className={styles.wallEmpty}>{t('settings.webSearch.allAdded')}</div> : <div className={styles.brandWall}>
        {available.map((preset) => <button type="button" key={preset.id} className={styles.brandTile} disabled={isApplying}
          onClick={() => void addProvider(preset.id).then((saved) => { if (saved) onAdded(preset.id); })}>
          <span className={styles.tileMark}><BrandMark brand={preset.id} title={preset.label} size={20} /></span>
          <span className={styles.tileName}>{preset.label}</span>
          <span className={styles.tileBrief}>{t('settings.webSearch.anonymous')}</span>
        </button>)}
      </div>}
    </div>
  </dialog>;
};
