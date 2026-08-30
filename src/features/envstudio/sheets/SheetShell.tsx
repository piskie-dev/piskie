/**
 * EnvStudio · 侧滑面板骨架（Forge/Depot/Vault 共用）
 * 页内右侧滑入：scrim 点击关闭、Esc 关闭、底部动作槽。
 */

import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ActPill } from '../glyphs/ActPill';
import styles from '../studio.module.css';

interface SheetShellProps {
  title: string;
  sub?: string;
  onClose(): void;
  foot?: React.ReactNode;
  children: React.ReactNode;
}

export const SheetShell: React.FC<SheetShellProps> = ({ title, sub, onClose, foot, children }) => {
  const { t } = useTranslation();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <button
        type="button"
        className={styles.scrim}
        aria-label={t('environmentUi.sheet.closePanel')}
        onClick={onClose}
      />
      <aside className={styles.sheet} role="dialog" aria-label={title}>
        <header className={styles.sheetHead}>
          <span className={styles.sheetTitle}>{title}</span>
          {sub && <span className={styles.sheetSub}>{sub}</span>}
          <span className={styles.sheetClose}>
            <ActPill tone="hush" onClick={onClose}>
              {t('environmentUi.sheet.closeAction')}
            </ActPill>
          </span>
        </header>
        <div className={styles.sheetBody}>{children}</div>
        {foot && <footer className={styles.sheetFoot}>{foot}</footer>}
      </aside>
    </>
  );
};
