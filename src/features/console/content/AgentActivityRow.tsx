import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { OrbIndicator } from './OrbIndicator';
import { formatActivityDuration } from './formatActivityDuration';

import activeTextStyles from './activeText.module.css';
import styles from './Transcript.module.css';

export const AgentActivityRow = memo<{ activeStartedAt: number }>(({ activeStartedAt }) => {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activeStartedAt]);

  const elapsed = formatActivityDuration(now - activeStartedAt, t);
  return (
    <div
      className={styles.activityRow}
      aria-label={t('sessionWorkbenchUi.agentActivity.elapsedAria', { elapsed })}
    >
      <span className={styles.activityIcon}>
        <OrbIndicator size={14} variant="expanding" />
      </span>
      <span className={activeTextStyles.text}>{t('sessionWorkbenchUi.agentActivity.working')}</span>
      <span className={styles.activitySeparator}>·</span>
      <span className={styles.activityElapsed}>{elapsed}</span>
    </div>
  );
});

AgentActivityRow.displayName = 'AgentActivityRow';
