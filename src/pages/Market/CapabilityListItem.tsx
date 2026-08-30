import React from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';

import type { MarketEntry } from '@shared/types/market';

import { CapabilityTag, ListItemCard, StatusBadge } from '../../components/shared';
import { kindGlyph, kindGlyphClass, kindTag } from './kind-visuals';
import { compatibilityLabel, compatibilityVariant } from './plugin-compatibility';
import styles from './market.module.css';

interface CapabilityListItemProps {
  entry: MarketEntry;
  selected: boolean;
  busy: boolean;
  onSelect: (entry: MarketEntry) => void;
  onInstall: (entry: MarketEntry) => void;
  onManage: (entry: MarketEntry) => void;
}

const CapabilityListItem: React.FC<CapabilityListItemProps> = ({
  entry,
  selected,
  busy,
  onSelect,
  onInstall,
  onManage,
}) => {
  const { t } = useTranslation();
  const compatibilityStatus = entry.compatibility ? compatibilityLabel(entry.compatibility, t) : null;

  return (
    <ListItemCard selected={selected} onClick={() => onSelect(entry)}>
      <div className={styles.itemRow}>
        <span className={`${styles.itemGlyph} ${kindGlyphClass(entry.kind)}`}>{kindGlyph(entry.kind)}</span>
        <div className={styles.itemBody}>
          <div className={styles.itemTitle}>
            <strong>{entry.name}</strong>
            {entry.updateAvailable && (
              <span className={styles.updateDot} title={t('marketUi.list.updateAvailable')} />
            )}
          </div>
          <span className={styles.itemDescription}>
            {entry.description || t('marketUi.list.noDescription')}
          </span>
          <div className={styles.itemMeta}>
            <CapabilityTag type={kindTag(entry.kind, entry.executable)} />
            {compatibilityStatus && entry.compatibility && (
              <StatusBadge variant={compatibilityVariant(entry.compatibility)}>
                {compatibilityStatus}
              </StatusBadge>
            )}
            <span>{entry.sourceName}</span>
            {entry.version && <span>v{entry.version}</span>}
          </div>
        </div>
        <div className={styles.itemAside}>
          {entry.installed ? (
            <button
              type="button"
              className={styles.rowButton}
              disabled={busy || entry.installable === false}
              title={entry.installable === false ? entry.installDisabledReason : undefined}
              onClick={(event) => {
                event.stopPropagation();
                onManage(entry);
              }}
            >
              {entry.updateAvailable
                ? t('marketUi.list.updateAction')
                : <><Check />{t('marketUi.list.installed')}</>}
            </button>
          ) : (
            <button
              type="button"
              className={styles.rowButtonPrimary}
              disabled={busy || entry.installable === false}
              title={entry.installable === false ? entry.installDisabledReason : undefined}
              onClick={(event) => {
                event.stopPropagation();
                onInstall(entry);
              }}
            >
              {entry.installable === false
                ? t('marketUi.list.unsupported')
                : t('marketUi.list.installAction')}
            </button>
          )}
        </div>
      </div>
    </ListItemCard>
  );
};

export default CapabilityListItem;
