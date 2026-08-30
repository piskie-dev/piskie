/**
 * 任务模板自绘下拉（排他呈现）。
 *
 * 原生 <select> 承载不了皮肤与占用者标注,换成锚定浮层清单:
 * 被其他 Bot 占用的模板置灰并标注「已被 xx 占用」;当前选中项打勾。
 * 排他与锁改绑语义全部在交互上体现(2026-08-20 用户裁决:不再配说明文案)。
 */

import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { TemplateClaim } from './data/template-claims';
import styles from './dossier.module.css';

export interface TemplateDropdownProps {
  readonly claims: readonly TemplateClaim[];
  readonly value: string | undefined;
  readonly placeholder: string;
  readonly disabled?: boolean;
  /** 禁用原因(如运行中锁改绑),挂 title */
  readonly disabledHint?: string;
  /** 校验失败态:红光描边(宿主定位滚动) */
  readonly fault?: boolean;
  readonly onPick: (definitionId: string) => void;
}

export const TemplateDropdown: React.FC<TemplateDropdownProps> = ({
  claims,
  value,
  placeholder,
  disabled,
  disabledHint,
  fault,
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

  const current = value ? claims.find((claim) => claim.id === value) : undefined;

  return (
    <div ref={wrapRef} className={styles.dropWrap}>
      <button
        type="button"
        className={styles.dropIn}
        aria-expanded={open}
        aria-haspopup="listbox"
        data-fault={fault ? 'true' : undefined}
        disabled={disabled}
        title={disabled ? disabledHint : undefined}
        onClick={() => setOpen((state) => !state)}
      >
        <span className={styles.dropText} data-empty={!current}>
          {current?.name ?? placeholder}
        </span>
        <ChevronDown size={13} className={styles.dropCaret} />
      </button>
      {open && (
        <div className={styles.dropCard} role="listbox">
          {claims.length === 0 ? (
            <div className={styles.popEmpty}>{t('imPlugin.templatePicker.noTemplates')}</div>
          ) : (
            claims.map((claim) => (
              <button
                key={claim.id}
                type="button"
                role="option"
                aria-selected={claim.id === value}
                className={styles.dropOpt}
                data-on={claim.id === value}
                disabled={claim.lockedByOther}
                onClick={() => {
                  onPick(claim.id);
                  setOpen(false);
                }}
              >
                <span className={styles.optName}>{claim.name}</span>
                {claim.lockedByOther && (
                  <span className={styles.optNote}>
                    {t('imPlugin.templatePicker.assignedTo', { name: claim.holders[0] })}
                  </span>
                )}
                {claim.id === value && <Check size={12} className={styles.optCheck} />}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
};
