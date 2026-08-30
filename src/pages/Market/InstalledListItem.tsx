import React from 'react';
import { useTranslation } from 'react-i18next';

import type { MarketInstalledItem } from '@shared/types/market';

import { CapabilityTag, ListItemCard, StatusBadge } from '../../components/shared';
import { kindGlyph, kindGlyphClass } from './kind-visuals';
import styles from './market.module.css';

interface InstalledListItemProps {
  item: MarketInstalledItem;
  selected: boolean;
  busy: boolean;
  onSelect: (item: MarketInstalledItem) => void;
  onUpdate: (item: MarketInstalledItem) => void;
  projectLabel?: string;
}

const installedKindTag = (item: MarketInstalledItem) => {
  if (item.kind === 'mcp') return 'mcp' as const;
  if (item.kind === 'plugin') return 'plugin' as const;
  return item.executionType === 'executable' ? 'executable' as const : 'skill' as const;
};

const InstalledListItem: React.FC<InstalledListItemProps> = ({
  item,
  selected,
  busy,
  onSelect,
  onUpdate,
  projectLabel,
}) => {
  const { t } = useTranslation();
  const workspaceLabel = projectLabel
    || item.workspace?.split(/[\\/]/).filter(Boolean).at(-1);

  return (
    <ListItemCard selected={selected} disabled={!item.enabled} onClick={() => onSelect(item)}>
      <div className={styles.itemRow}>
        <span className={`${styles.itemGlyph} ${kindGlyphClass(item.kind)}`}>{kindGlyph(item.kind)}</span>
        <div className={styles.itemBody}>
          <div className={styles.itemTitle}>
            <strong>{item.name}</strong>
            {item.updateAvailable && (
              <span className={styles.updateDot} title={t('marketUi.list.updateAvailable')} />
            )}
          </div>
          <span className={styles.itemDescription}>
            {item.description
              || item.endpoint
              || (item.plugin ? t('marketUi.list.installedWithPlugin', { plugin: item.plugin }) : '')}
          </span>
          <div className={styles.itemMeta}>
            <CapabilityTag type={installedKindTag(item)} />
            <StatusBadge
              variant={item.scope === 'project' ? 'accent' : item.scope === 'builtin' ? 'default' : 'primary'}
              bordered
            >
              {item.scope === 'builtin'
                ? t('marketUi.location.builtinShort')
                : item.scope === 'project'
                  ? t('marketUi.location.project')
                  : t('marketUi.location.global')}
            </StatusBadge>
            {item.scope === 'project' && workspaceLabel && (
              <span title={item.workspace}>{workspaceLabel}</span>
            )}
            {item.plugin && <span>{t('marketUi.list.fromPlugin', { plugin: item.plugin })}</span>}
            {!item.enabled && (
              <StatusBadge variant="warning" dot>{t('marketUi.list.disabled')}</StatusBadge>
            )}
          </div>
        </div>
        <div className={styles.itemAside}>
          {item.updateAvailable ? (
            <button
              type="button"
              className={styles.rowButtonPrimary}
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                onUpdate(item);
              }}
            >
              {t('marketUi.list.updateAction')}
            </button>
          ) : (
            item.version && <span className={styles.itemMeta}>v{item.version}</span>
          )}
        </div>
      </div>
    </ListItemCard>
  );
};

export default InstalledListItem;
