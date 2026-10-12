import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentOutputTokens } from '@shared/types/agent-control';
import { OrbIndicator } from './OrbIndicator';
import { formatActivityDuration } from './formatActivityDuration';

import activeTextStyles from './activeText.module.css';
import styles from './Transcript.module.css';

export const AgentActivityRow = memo<{
  activeStartedAt: number;
  activeOutputTokens?: AgentOutputTokens;
}>(({ activeStartedAt, activeOutputTokens }) => {
  const { t, i18n } = useTranslation();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activeStartedAt]);

  const elapsed = formatActivityDuration(now - activeStartedAt, t);
  const tokens = activeOutputTokens
    ? new Intl.NumberFormat(i18n.resolvedLanguage ?? i18n.language).format(activeOutputTokens.count)
    : undefined;
  const displayTokens = activeOutputTokens && activeOutputTokens.count >= 1_000
    ? `${(activeOutputTokens.count / 1_000).toFixed(1)}k`
    : tokens;
  const outputLabel = activeOutputTokens && t(activeOutputTokens.estimated
    ? 'sessionWorkbenchUi.agentActivity.estimatedOutputTokens'
    : 'sessionWorkbenchUi.agentActivity.outputTokens', { tokens: displayTokens });
  const outputAria = activeOutputTokens && t(activeOutputTokens.estimated
    ? 'sessionWorkbenchUi.agentActivity.estimatedOutputAria'
    : 'sessionWorkbenchUi.agentActivity.outputAria', { tokens });
  return (
    <div
      className={styles.activityRow}
      aria-label={outputAria
        ? t('sessionWorkbenchUi.agentActivity.elapsedOutputAria', { elapsed, output: outputAria })
        : t('sessionWorkbenchUi.agentActivity.elapsedAria', { elapsed })}
    >
      <span className={styles.activityIcon}>
        <OrbIndicator size={14} variant="expanding" />
      </span>
      <span className={activeTextStyles.text}>{t('sessionWorkbenchUi.agentActivity.working')}</span>
      <span className={styles.activitySeparator}>·</span>
      <span className={styles.activityElapsed}>{elapsed}</span>
      {activeOutputTokens && (
        <span className={styles.activityTokens} title={t(activeOutputTokens.estimated
          ? 'sessionWorkbenchUi.agentActivity.estimatedOutputDescription'
          : 'sessionWorkbenchUi.agentActivity.outputDescription')}>
          <span className={styles.activitySeparator} aria-hidden="true">·</span>
          <span>{outputLabel}</span>
        </span>
      )}
    </div>
  );
});

AgentActivityRow.displayName = 'AgentActivityRow';
