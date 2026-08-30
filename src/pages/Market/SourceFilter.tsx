import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Database, SlidersHorizontal } from 'lucide-react';

import type { MarketSource } from '@shared/types/market';

import styles from './market.module.css';

interface SourceFilterProps {
  sources: MarketSource[];
  selected: string[];
  onChange: (ids: string[]) => void;
  onManage: () => void;
}

const sourceKindLabel = (source: MarketSource, translate: (key: string) => string): string => {
  if (source.kind === 'mcp-registry') return translate('marketUi.source.kindMcpRegistry');
  if (source.kind === 'openai-plugin-marketplace') return translate('marketUi.source.kindOpenAiPlugins');
  if (source.kind === 'anthropic-plugin-marketplace') return translate('marketUi.source.kindAnthropicPlugins');
  return translate('marketUi.source.kindSkillsRepository');
};

const SourceFilter: React.FC<SourceFilterProps> = ({ sources, selected, onChange, onManage }) => {
  const { t } = useTranslation();
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    popoverRef.current?.setAttribute('popover', 'auto');
  }, []);

  return (
    <>
      <button
        type="button"
        className={`${styles.toolButton} ${styles.sourceAnchor}`}
        onClick={() => popoverRef.current?.togglePopover()}
      >
        <SlidersHorizontal aria-hidden />
        <span>{t('marketUi.source.filterLabel')}</span>
        {selected.length > 0 && <span className={styles.filterCount}>{selected.length}</span>}
      </button>
      <div ref={popoverRef} className={styles.sourcePopover}>
        <div className={styles.sourceOptions}>
          {sources.map((source) => {
            const checked = selected.includes(source.id);
            return (
              <label
                className={`${styles.sourceOption} ${checked ? styles.sourceOptionSelected : ''}`}
                key={source.id}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => onChange(event.target.checked
                    ? [...selected, source.id]
                    : selected.filter((id) => id !== source.id))}
                />
                <span className={styles.projectIndicator} aria-hidden>{checked && <Check />}</span>
                <span className={styles.sourceOptionLabel}>
                  <strong>{source.name}</strong>
                  <small>
                    {sourceKindLabel(source, t)}
                    {source.builtin ? ` · ${t('marketUi.source.builtin')}` : ''}
                  </small>
                </span>
              </label>
            );
          })}
          {sources.length === 0 && (
            <span className={styles.sourceOptionLabel}>
              <small><Database aria-hidden /> {t('marketUi.source.noneConfigured')}</small>
            </span>
          )}
        </div>
        <div className={styles.popoverFoot}>
          {selected.length > 0 && (
            <button type="button" className={styles.footButton} onClick={() => onChange([])}>
              {t('marketUi.source.showAll')}
            </button>
          )}
          <button type="button" className={styles.footButton} onClick={onManage}>
            {t('marketUi.source.manageAction')}
          </button>
        </div>
      </div>
    </>
  );
};

export default SourceFilter;
