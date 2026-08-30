import { memo, useEffect, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { OrbIndicator } from './OrbIndicator';

import activeTextStyles from './activeText.module.css';
import styles from './Transcript.module.css';

function elapsedLabel(startedAt: number, now: number, t: TFunction): string {
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return t('sessionWorkbenchUi.agentActivity.durationHours', { hours, minutes, seconds });
  }
  if (minutes > 0) {
    return t('sessionWorkbenchUi.agentActivity.durationMinutes', { minutes, seconds });
  }
  return t('sessionWorkbenchUi.agentActivity.durationSeconds', { seconds });
}

export const AgentActivityRow = memo<{ activeStartedAt: number }>(({ activeStartedAt }) => {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activeStartedAt]);

  const elapsed = elapsedLabel(activeStartedAt, now, t);
  return (
    <div
      className={styles.activityRow}
      aria-label={t('sessionWorkbenchUi.agentActivity.elapsedAria', { elapsed })}
    >
      <span className={styles.activityIcon}>
        <OrbIndicator size={14} />
      </span>
      <span className={activeTextStyles.text}>{t('sessionWorkbenchUi.agentActivity.working')}</span>
      <span className={styles.activitySeparator}>·</span>
      <span className={styles.activityElapsed}>{elapsed}</span>
    </div>
  );
});

AgentActivityRow.displayName = 'AgentActivityRow';
