/**
 * 自绘单选下拉（通用件）。
 *
 * 原生 <select> 承载不了皮肤与"选项副行说明"(API 协议/代理/思考协议都需要),
 * 换成锚定浮层清单:当前项打勾、禁用项置灰、Esc/点外关闭。
 */

import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown } from 'lucide-react';

import styles from '../deck.module.css';

export interface DeckOption {
  readonly value: string;
  readonly label: string;
  /** 选项副行说明(可选) */
  readonly brief?: string;
  /** 右侧附注(mono 小字,可选) */
  readonly side?: string;
  readonly disabled?: boolean;
}

export interface DeckSelectProps {
  readonly options: readonly DeckOption[];
  readonly value: string | undefined;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly fault?: boolean;
  readonly ariaLabel?: string;
  readonly onPick: (value: string) => void;
}

export const DeckSelect: React.FC<DeckSelectProps> = ({
  options,
  value,
  placeholder,
  disabled,
  fault,
  ariaLabel,
  onPick,
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = value !== undefined ? options.find((option) => option.value === value) : undefined;

  return (
    <div ref={wrapRef} className={styles.dropWrap}>
      <button
        type="button"
        className={styles.dropIn}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        data-fault={fault ? 'true' : undefined}
        disabled={disabled}
        onClick={() => setOpen((state) => !state)}
      >
        <span className={styles.dropText} data-empty={!current}>
          {current?.label ?? placeholder ?? t('settings.selectPlaceholder')}
        </span>
        <ChevronDown size={13} className={styles.dropCaret} />
      </button>
      {open && (
        <div className={styles.dropCard} role="listbox">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={styles.dropOpt}
              data-on={option.value === value}
              disabled={option.disabled}
              onClick={() => {
                onPick(option.value);
                setOpen(false);
              }}
            >
              <span className={styles.optMain}>
                {option.label}
                {option.brief && <span className={styles.optBrief}>{option.brief}</span>}
              </span>
              {option.side && <span className={styles.optSide}>{option.side}</span>}
              {option.value === value && <Check size={12} className={styles.optCheck} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
