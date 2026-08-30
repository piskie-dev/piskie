/**
 * ErrorBar —— 错误与重试条（面板头部第二带）。
 *
 * 两个信息源**严格分离**：
 * - **重试在途 / backoff**：来自权威的 `aiRequestState`（VM 里的 `RequestVM`），不从 AgentIncident 推断
 * - **最终错误**：来自 AgentIncident
 *
 * 倒计时与耗时统一由绝对时间戳派生。
 */

import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { useTimeSeconds } from '../../../hooks/useTimeSeconds';
import type { RequestVM } from '../data/vm';
import { Tooltip } from './Tooltip';
import styles from './chrome.module.css';

export interface ErrorBarProps {
  /** 最终错误（无重试在途时展示） */
  readonly error?: { readonly message: string; readonly code?: string; readonly reason?: string };
  /** 重试瞬时态；存在时优先展示，并把整条压成 waiting 语气 */
  readonly request?: RequestVM;
}

export const ErrorBar = memo<ErrorBarProps>(({ error, request }) => {
  const { t } = useTranslation();
  const retrying = !!request?.retrying;
  const countdown = useTimeSeconds(
    request?.backoff ? request.retryAt : undefined,
    'remaining',
  );
  const elapsed = useTimeSeconds(request?.attemptStartedAt, 'elapsed');

  if (!retrying && !error) return null;

  const message = retrying
    ? request?.backoff
      ? request.errorMessage ?? t('sessionWorkbenchUi.request.failedWaitingRetry')
      : t('sessionWorkbenchUi.request.attemptRequesting', {
          current: request?.attempt ?? 0,
          total: request?.maxAttempts ?? 0,
        })
    : (error?.message ?? '');

  const code = retrying ? request?.errorCode : error?.code;
  const reason = retrying ? undefined : error?.reason;

  return (
    <div className={styles.errorBar} data-retrying={retrying}>
      <div className={styles.errorLine}>
        <Tooltip title={message}>
          <span className={styles.errorMessage}>{message}</span>
        </Tooltip>
        {code && <span className={styles.errorCode}>{code}</span>}
      </div>

      {retrying && request && (
        <div className={styles.retryLine}>
          <span>
            {t('sessionWorkbenchUi.request.attemptProgress', {
              current: request.attempt,
              total: request.maxAttempts,
            })}
          </span>
          {request.backoff && request.retryAt !== undefined ? (
            <span>{countdown > 0
              ? t('sessionWorkbenchUi.request.retryAfterSeconds', { seconds: countdown })
              : t('sessionWorkbenchUi.request.retrying')}</span>
          ) : request.attemptStartedAt ? (
            <span>{t('sessionWorkbenchUi.request.runningSeconds', { seconds: elapsed })}</span>
          ) : null}
        </div>
      )}

      {reason && (
        <Tooltip title={reason}>
          <div className={styles.errorReason}>{reason}</div>
        </Tooltip>
      )}
    </div>
  );
});

ErrorBar.displayName = 'ErrorBar';
