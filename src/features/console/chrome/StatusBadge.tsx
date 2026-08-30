/**
 * StatusBadge / StatusDot —— 状态展示。
 *
 * `statusOf` 只负责视觉语义，状态文案由当前 locale 即时解析。
 */

import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { StatusKey } from '../data/vm';
import { statusOf } from './statusOf';
import styles from './chrome.module.css';

export interface StatusBadgeProps {
  readonly status: StatusKey;
  /** 只显示状态点（折叠态侧栏 / 密集列表用） */
  readonly dotOnly?: boolean;
  readonly className?: string;
}

export const StatusBadge = memo<StatusBadgeProps>(({ status, dotOnly, className }) => {
  const { t } = useTranslation();
  const { tone, pulse } = statusOf(status);
  const label = t(`sessionWorkbenchUi.runStatus.${status}`);

  if (dotOnly) {
    return (
      <span
        className={`${styles.dot} ${className ?? ''}`}
        data-tone={tone}
        data-pulse={pulse}
        role="img"
        aria-label={label}
      />
    );
  }

  return (
    <span className={`${styles.badge} ${className ?? ''}`} data-tone={tone}>
      <span className={styles.dot} data-tone={tone} data-pulse={pulse} aria-hidden="true" />
      {label}
    </span>
  );
});

StatusBadge.displayName = 'StatusBadge';
