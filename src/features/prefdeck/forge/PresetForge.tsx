/**
 * 供应商预设选择弹窗 · 品牌墙。
 *
 * 图标优先的网格墙:顶部搜索 + 分翼过滤 lever;格子 = 品牌图标 + 名称,
 * 悬停浮出简介;自定义端点与普通格子同交互同样式(过滤时始终可见)。
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X } from 'lucide-react';
import { useNativeDialog } from '../../../components/task-definition/useNativeDialog';
import { BrandMark } from '../bits/BrandMark';
import {
  WING_ORDER,
  vendorsFor,
  vendorLocaleKey,
  type GatewayKind,
  type VendorSpec,
  type VendorWing,
} from '../data/vendor-atlas';
import styles from '../deck.module.css';

export interface PresetForgeProps {
  readonly gateway: GatewayKind;
  readonly onClose: () => void;
  readonly onPick: (spec: VendorSpec) => void;
}

type WingPick = 'all' | Exclude<VendorWing, 'diy'>;

/** 过滤 lever 短标签(自定义翼恒显,不设档位) */
const WING_LEVERS: Record<GatewayKind, readonly { key: WingPick; labelKey: string }[]> = {
  ai: [
    { key: 'all', labelKey: 'settings.preset.all' },
    { key: 'flagship', labelKey: 'settings.preset.flagshipAi' },
    { key: 'openhub', labelKey: 'settings.preset.openHub' },
    { key: 'onprem', labelKey: 'settings.preset.onPrem' },
  ],
  image: [
    { key: 'all', labelKey: 'settings.preset.all' },
    { key: 'flagship', labelKey: 'settings.preset.flagshipImage' },
    { key: 'openhub', labelKey: 'settings.preset.openHub' },
    { key: 'onprem', labelKey: 'settings.preset.onPrem' },
  ],
};

export const PresetForge: React.FC<PresetForgeProps> = ({ gateway, onClose, onPick }) => {
  const { t } = useTranslation();
  const dialogRef = useNativeDialog(true, onClose);
  const [query, setQuery] = React.useState('');
  const [wingPick, setWingPick] = React.useState<WingPick>('all');
  const atlas = vendorsFor(gateway);

  const needle = query.trim().toLocaleLowerCase();
  const hits = atlas.filter((spec) => {
    const wingOk = wingPick === 'all' || spec.wing === wingPick || spec.wing === 'diy';
    const textOk = !needle
      || `${t(vendorLocaleKey(spec, 'title'))} ${t(vendorLocaleKey(spec, 'brief'))}`
        .toLocaleLowerCase()
        .includes(needle);
    return wingOk && textOk;
  });

  return (
    <dialog
      ref={dialogRef}
      className={styles.forgeShell}
      data-wall="true"
      aria-label={t('settings.preset.addProvider')}
    >
      <div className={styles.forgeHead}>
        <span className={styles.forgeTitle}>
          {t('settings.preset.addProvider')}
          <span className={styles.forgeSub}>
            {t('settings.preset.choosePlatform', {
              gateway: t(gateway === 'ai' ? 'settings.preset.aiGateway' : 'settings.preset.imageGateway'),
            })}
          </span>
        </span>
        <button type="button" className={styles.orbBtn} aria-label={t('common.close')} onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className={styles.wallTools}>
        <span className={styles.textIn}>
          <Search size={13} />
          <input
            type="search"
            placeholder={t('settings.preset.searchPlaceholder')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </span>
        <span className={styles.lever}>
          {WING_LEVERS[gateway].map((option) => (
            <button
              key={option.key}
              type="button"
              data-on={wingPick === option.key ? 'true' : 'false'}
              onClick={() => setWingPick(option.key)}
            >
              {t(option.labelKey)}
            </button>
          ))}
        </span>
      </div>
      <div className={styles.forgeBody}>
        {hits.length === 0 && <div className={styles.wallEmpty}>{t('settings.preset.noMatches')}</div>}
        {WING_ORDER.map((wing) => {
          const specs = hits.filter((spec) => spec.wing === wing);
          if (specs.length === 0) return null;
          return (
            <section key={wing}>
              <div className={styles.sectCap}>{t(`settings.preset.wing${wing === 'openhub' ? 'OpenHub' : wing === 'onprem' ? 'OnPrem' : wing === 'diy' ? 'Diy' : 'Flagship'}`)}</div>
              <div className={styles.brandWall}>
                {specs.map((spec) => (
                  <button
                    key={spec.key}
                    type="button"
                    className={styles.brandTile}
                    onClick={() => onPick(spec)}
                  >
                    <span className={styles.tileMark}>
                      <BrandMark brand={spec.brand} title={t(vendorLocaleKey(spec, 'title'))} size={20} />
                    </span>
                    <span className={styles.tileName}>{t(vendorLocaleKey(spec, 'title'))}</span>
                    <span className={styles.tileBrief}>{t(vendorLocaleKey(spec, 'brief'))}</span>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </dialog>
  );
};
