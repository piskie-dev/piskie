/**
 * ToastHost —— 右下角通知栈(2026-08-25 去 antd notification 重设计)。
 *
 * Lumen 形制:玻璃卡 + 左缘语义光条,无描边、亮起靠光;右上角驻留(让开天际栏),
 * 进场自上浮入(@starting-style),悬停暂停消隐计时,critical 常驻带脉动光条。
 */

import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useToastStore, type ToastItem } from './toast-store';
import styles from './toasts.module.css';

const ToastCard: React.FC<{ readonly toast: ToastItem }> = ({ toast }) => {
  const { t } = useTranslation();
  const dismiss = useToastStore((state) => state.dismiss);
  const [hovering, setHovering] = useState(false);
  /** 悬停暂停:记录剩余时长,移出后接着倒计时 */
  const remaining = useRef(toast.durationMs);
  const startedAt = useRef(0);

  useEffect(() => {
    remaining.current = toast.durationMs;
  }, [toast.durationMs, toast.pushedAt]);

  useEffect(() => {
    if (toast.durationMs === 0 || hovering) return;
    startedAt.current = Date.now();
    const timer = window.setTimeout(() => dismiss(toast.id), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(1000, remaining.current - (Date.now() - startedAt.current));
    };
  }, [dismiss, hovering, toast.durationMs, toast.id, toast.pushedAt]);

  return (
    <div
      className={styles.card}
      data-tone={toast.tone}
      role={toast.tone === 'info' ? 'status' : 'alert'}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <div className={styles.title}>{toast.title}</div>
      {toast.detail && <div className={styles.detail}>{toast.detail}</div>}
      <button
        type="button"
        className={styles.close}
        onClick={() => dismiss(toast.id)}
        aria-label={t('common.dismissNotification')}
      >
        <X size={13} />
      </button>
    </div>
  );
};

export const ToastHost: React.FC = () => {
  const toasts = useToastStore((state) => state.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className={styles.host}>
      {toasts.map((toast) => <ToastCard key={toast.id} toast={toast} />)}
    </div>
  );
};
