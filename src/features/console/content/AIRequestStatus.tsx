import { memo } from 'react';
import { AlertTriangle, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useTimeSeconds } from '../../../hooks/useTimeSeconds';
import type { RequestVM } from '../data/vm';
import styles from './mcpRuntimeCard.module.css';

export interface AIRequestStatusProps {
  readonly request?: RequestVM;
  readonly variant?: 'main' | 'worker' | 'composer';
}

export const AIRequestStatus = memo<AIRequestStatusProps>(({ request, variant = 'main' }) => {
  const { t } = useTranslation();
  const countdown = useTimeSeconds(
    request?.backoff ? request.retryAt : undefined,
    'remaining',
  );
  const elapsed = useTimeSeconds(
    request?.retrying ? request.attemptStartedAt : undefined,
    'elapsed',
  );

  if (!request) return null;

  if (request.activity) {
    const label = request.activity === 'compacting'
      ? t('sessionWorkbenchUi.request.compacting')
      : t('sessionWorkbenchUi.request.compactedRetry');
    return (
      <div className={styles.status} data-variant={variant} aria-live="polite">
        <div className={styles.line} data-tone="progress">
          <LoaderCircle className={styles.spin} aria-hidden />
          <span className={styles.copy}><strong>{label}</strong></span>
        </div>
      </div>
    );
  }

  if (request.retrying) {
    const progress = request.maxAttempts > 0
      ? `${request.attempt}/${request.maxAttempts}`
      : String(request.attempt);
    const detail = request.backoff
      ? countdown > 0
        ? t('sessionWorkbenchUi.request.retryAfterSeconds', { seconds: countdown })
        : t('sessionWorkbenchUi.request.retrying')
      : request.attemptStartedAt
        ? t('sessionWorkbenchUi.request.runningSeconds', { seconds: elapsed })
        : t('sessionWorkbenchUi.request.requesting');

    return (
      <div className={styles.status} data-variant={variant} aria-live="polite">
        <div className={styles.line} data-tone="progress">
          <LoaderCircle className={styles.spin} aria-hidden />
          <span className={styles.copy}>
            <strong>{t('sessionWorkbenchUi.request.retryProgress', {
              current: request.attempt,
              total: request.maxAttempts > 0 ? request.maxAttempts : progress,
            })}</strong>
            <span className={styles.reason}> · {detail}</span>
            {request.errorMessage && request.backoff && (
              <span className={styles.names} title={request.errorMessage}>：{request.errorMessage}</span>
            )}
          </span>
          {request.errorCode && <span className={styles.code}>{request.errorCode}</span>}
        </div>
      </div>
    );
  }

  if (!request.failed || !request.errorMessage) return null;

  return (
    <div className={styles.status} data-variant={variant} aria-live="polite">
      <div className={`${styles.line} ${styles.finalErrorLine}`} data-tone="error">
        <AlertTriangle aria-hidden />
        <span className={`${styles.copy} ${styles.providerCopy}`}>
          <strong className={styles.providerMessage}>{request.errorMessage}</strong>
        </span>
        {(request.attempt > 0 || request.errorCode) && (
          <span className={styles.errorMeta}>
            {request.attempt > 0 && (
              <span className={styles.retryCount}>
                {t('sessionWorkbenchUi.request.retriedCount', { count: request.attempt })}
              </span>
            )}
            {request.errorCode && <span className={styles.code}>{request.errorCode}</span>}
          </span>
        )}
      </div>
    </div>
  );
});

AIRequestStatus.displayName = 'AIRequestStatus';
