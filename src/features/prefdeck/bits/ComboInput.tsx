/**
 * 联想输入（通用件）:可自由输入,也可从建议清单选取。
 *
 * 模型 ID 场景:选中建议回调 onAdopt(带建议附加值),手动改动回调 onChange;
 * 建议按输入子串过滤(大小写不敏感,匹配 label 与 value)。
 */

import React, { useEffect, useRef, useState } from 'react';

import styles from '../deck.module.css';

export interface ComboSuggestion {
  readonly value: string;
  readonly label: string;
  /** 附带载荷(如目录模型 id),选中时透传给 onAdopt */
  readonly payload?: string;
}

export interface ComboInputProps {
  readonly value: string;
  readonly suggestions: readonly ComboSuggestion[];
  readonly placeholder?: string;
  readonly fault?: boolean;
  readonly ariaLabel?: string;
  readonly onChange: (value: string) => void;
  readonly onAdopt: (suggestion: ComboSuggestion) => void;
}

export const ComboInput: React.FC<ComboInputProps> = ({
  value,
  suggestions,
  placeholder,
  fault,
  ariaLabel,
  onChange,
  onAdopt,
}) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [open]);

  const needle = value.trim().toLocaleLowerCase();
  const matched = needle.length === 0
    ? suggestions
    : suggestions.filter((item) => (
      `${item.label} ${item.value}`.toLocaleLowerCase().includes(needle)
    ));

  return (
    <div ref={wrapRef} className={styles.dropWrap}>
      <div className={styles.textIn} data-fault={fault ? 'true' : undefined}>
        <input
          value={value}
          placeholder={placeholder}
          aria-label={ariaLabel}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setOpen(false);
          }}
        />
      </div>
      {open && matched.length > 0 && (
        <div className={styles.dropCard} role="listbox">
          {matched.map((item) => (
            <button
              key={`${item.value}:${item.payload ?? ''}`}
              type="button"
              role="option"
              aria-selected={item.value === value}
              className={styles.dropOpt}
              data-on={item.value === value}
              onClick={() => {
                onAdopt(item);
                setOpen(false);
              }}
            >
              <span className={styles.optMain}>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
