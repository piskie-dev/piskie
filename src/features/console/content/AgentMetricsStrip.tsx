import { memo, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { AgentRunMetrics } from '../../../../shared/types/agent-control';
import { agentMetricLabels } from './agentMetricLabels';
import styles from './agentMetricsStrip.module.css';

export interface AgentMetricsStripProps {
  readonly metrics: AgentRunMetrics;
  readonly activeLlmStartedAt?: number;
  readonly activeToolPhaseStartedAt?: number;
}

export const AgentMetricsStrip = memo<AgentMetricsStripProps>(
  ({ metrics, activeLlmStartedAt, activeToolPhaseStartedAt }) => {
    const { t, i18n } = useTranslation();
    const active = activeLlmStartedAt !== undefined || activeToolPhaseStartedAt !== undefined;
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
      setNow(Date.now());
      if (!active) return;
      const timer = window.setInterval(() => setNow(Date.now()), 1000);
      return () => window.clearInterval(timer);
    }, [active, activeLlmStartedAt, activeToolPhaseStartedAt]);

    const labels = useMemo(
      () => agentMetricLabels(metrics, now, activeLlmStartedAt, activeToolPhaseStartedAt, {
        locale: i18n.resolvedLanguage ?? i18n.language,
        rounds: (count) => t('sessionWorkbenchUi.metrics.rounds', { count }),
        steps: (count) => t('sessionWorkbenchUi.metrics.steps', { count }),
      }),
      [activeLlmStartedAt, activeToolPhaseStartedAt, i18n.language, i18n.resolvedLanguage, metrics, now, t],
    );
    const detail = [
      labels.rounds,
      labels.steps,
      `LLM ${labels.llm}`,
      `${t('sessionWorkbenchUi.metrics.toolCalls')} ${labels.tools}`,
      `${t('sessionWorkbenchUi.metrics.firstTokenAverage')} ${labels.firstVisible}`,
      labels.throughput,
      `${t('sessionWorkbenchUi.metrics.cacheHit')} ${labels.cache}`,
      `${t('sessionWorkbenchUi.metrics.input')} ${labels.input} tok`,
      `${t('sessionWorkbenchUi.metrics.output')} ${labels.output} tok`,
    ].join(' · ');

    return (
      <div className={styles.strip} aria-label={detail}>
        <span className={styles.group} data-priority="core">
          <span>{labels.rounds}</span><span aria-hidden>·</span><span>{labels.steps}</span>
        </span>
        <span className={styles.group} data-priority="duration">
          <span>LLM {labels.llm}</span><span aria-hidden>·</span><span>{t('sessionWorkbenchUi.metrics.toolCalls')} {labels.tools}</span>
        </span>
        <span className={styles.group} data-priority="latency">
          <span>{t('sessionWorkbenchUi.metrics.firstTokenAverage')} {labels.firstVisible}</span><span aria-hidden>·</span><span>{labels.throughput}</span>
        </span>
        <span className={styles.group} data-priority="cache">{t('sessionWorkbenchUi.metrics.cacheHit')} {labels.cache}</span>
        <span className={styles.group} data-priority="tokens">
          <span>{t('sessionWorkbenchUi.metrics.input')} {labels.input} tok</span><span aria-hidden>·</span><span>{t('sessionWorkbenchUi.metrics.output')} {labels.output} tok</span>
        </span>
      </div>
    );
  },
);

AgentMetricsStrip.displayName = 'AgentMetricsStrip';
