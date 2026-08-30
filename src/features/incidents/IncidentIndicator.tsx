/**
 * 顶栏事故指示器(Lumen 重写,替换旧 antd Popover/Button/Tag 版)。
 *
 * 光斑计数签 + 锚定浮层:按严重度点亮(错误红 / 仅警告琥珀),新事故 5 秒呼吸光晕;
 * 浮层为事故台账——每行来源 / 代码签 / 消息 / 原始错误,行内「跳转·清除」,眉标一键清空。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentTarget } from '../../../shared/types';
import { useIncidentStore } from '../../store/incidentStore';
import { selectVisibleIncidents } from './selectors';
import styles from './IncidentIndicator.module.css';

interface IncidentIndicatorProps {
  onFocusTarget?: (target: AgentTarget) => void;
}

function targetLabel(target: AgentTarget): string {
  return target.workerId
    ? `Worker: ${target.workerId} · Agent: ${target.agentId}`
    : `Agent: ${target.agentId}`;
}

export function IncidentIndicator({ onFocusTarget }: IncidentIndicatorProps) {
  const { t } = useTranslation();
  const incidents = useIncidentStore((state) => state.incidents);
  const clearIncident = useIncidentStore((state) => state.clearIncident);
  const clearAllIncidents = useIncidentStore((state) => state.clearAllIncidents);
  const visibleIncidents = useMemo(() => selectVisibleIncidents(incidents), [incidents]);
  const latestId = visibleIncidents[0]?.id;
  const previousLatestId = useRef<string>();
  const [hasNewIncident, setHasNewIncident] = useState(false);
  const [open, setOpen] = useState(false);
  const dockRef = useRef<HTMLSpanElement>(null);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!latestId || latestId === previousLatestId.current) return undefined;
    previousLatestId.current = latestId;
    setHasNewIncident(true);
    const timer = setTimeout(() => setHasNewIncident(false), 5000);
    return () => clearTimeout(timer);
  }, [latestId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent): void => {
      if (dockRef.current && !dockRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [open]);

  if (visibleIncidents.length === 0) return null;

  const errorCount = visibleIncidents.filter((incident) => (
    incident.severity === 'error' || incident.severity === 'critical'
  )).length;
  const warningCount = visibleIncidents.length - errorCount;
  const tone = errorCount === 0 ? 'warning' : 'error';
  const statusText = [
    errorCount > 0 ? t('error.incidentCount', { count: errorCount }) : '',
    warningCount > 0 ? t('error.warningCountDetected', { count: warningCount }) : '',
  ].filter(Boolean).join(' · ');

  return (
    <span ref={dockRef} className={styles.dock}>
      <button
        type="button"
        className={styles.beacon}
        data-tone={tone}
        data-new={hasNewIncident ? 'true' : undefined}
        aria-expanded={open}
        aria-label={statusText}
        aria-live="polite"
        onClick={() => setOpen((current) => !current)}
      >
        <span className={styles.beaconDot} aria-hidden />
        {statusText}
        {/* 告警氛围:胶囊内部斜向扫光(独立裁剪层,不影响边框上的瓢虫) */}
        <span className={styles.sheen} aria-hidden />
      </button>

      {open && (
        <div className={styles.ledger} role="dialog" aria-label={t('error.incidentTitle')}>
          <div className={styles.ledgerCap} data-tone={tone}>
            {t('error.incidentTitle')} · {visibleIncidents.length}
            <span className={styles.capSpring} />
            <button
              type="button"
              className={styles.capAct}
              onClick={() => void clearAllIncidents()}
            >
              {t('error.clearAll')}
            </button>
          </div>

          <div className={styles.ledgerBody}>
            {visibleIncidents.map((incident) => (
              <article
                key={incident.id}
                className={styles.caseRow}
                data-severity={incident.severity}
              >
                <div className={styles.caseHead}>
                  <span className={styles.caseWho} title={targetLabel(incident.source)}>
                    {targetLabel(incident.source)}
                  </span>
                  <code className={styles.caseCode}>
                    {incident.details?.code || incident.category}
                  </code>
                </div>

                <p className={styles.caseMsg}>{incident.message}</p>
                {incident.details?.originalError && (
                  <pre className={styles.caseRaw}>{incident.details.originalError}</pre>
                )}

                <div className={styles.caseActs}>
                  {onFocusTarget && (
                    <button
                      type="button"
                      className={styles.caseAct}
                      onClick={() => onFocusTarget(incident.source)}
                    >
                      {t('error.jumpTo')} →
                    </button>
                  )}
                  <button
                    type="button"
                    className={`${styles.caseAct} ${styles.caseActHalt}`}
                    onClick={() => void clearIncident(incident.id)}
                  >
                    {t('error.clear')}
                  </button>
                </div>
              </article>
            ))}
          </div>
        </div>
      )}
    </span>
  );
}
