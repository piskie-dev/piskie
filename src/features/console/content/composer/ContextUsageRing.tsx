import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { TOKEN_WARNING_THRESHOLDS } from '../../../../../shared/constants/token';
import type { ContextUsage } from '../../../../../shared/types/token';
import { ContextBreakdown } from '../../../context-inspector/ContextBreakdown';
import { ContextInspector } from '../../../context-inspector/ContextInspector';
import inspectorStyles from '../../../context-inspector/context-inspector.module.css';
import {
  useContextInspectorResource,
  useRendererRuntime,
} from '../../../../renderer-runtime/hooks';
import { Tooltip } from '../../chrome/Tooltip';
import { Popover } from '../../chrome/Popover';
import styles from './conversationComposer.module.css';

export interface ContextUsageRingProps {
  readonly usage?: ContextUsage;
  readonly agentId: string;
  readonly sourceVersion: number;
  readonly viewerEnabled?: boolean;
}

function formatTokens(value: number | undefined, locale: string): string {
  if (value === undefined) return '—';
  return new Intl.NumberFormat(locale).format(value);
}

function levelOf(percentage: number | undefined): 'normal' | 'warning' | 'critical' {
  if (percentage !== undefined && percentage >= TOKEN_WARNING_THRESHOLDS.high) return 'critical';
  if (percentage !== undefined && percentage >= TOKEN_WARNING_THRESHOLDS.medium) return 'warning';
  return 'normal';
}

export const ContextUsageRing = memo<ContextUsageRingProps>(
  ({ usage, agentId, sourceVersion, viewerEnabled = false }) => {
    const { t, i18n } = useTranslation();
    const locale = i18n.resolvedLanguage ?? i18n.language;
    const percentage = usage?.percentage;
    const label = percentage === undefined ? '—' : `${Math.round(percentage)}%`;
    const tooltip = t('contextUi.meter.usage', {
      used: formatTokens(usage?.tokens, locale),
      limit: formatTokens(usage?.limit, locale),
    });
    const content = (
      <span className={styles.contextUsage} data-level={levelOf(percentage)}>
        <svg className={styles.contextRing} viewBox="0 0 20 20" aria-hidden>
          <circle className={styles.contextTrack} cx="10" cy="10" r="7.5" pathLength="100" />
          {percentage !== undefined && (
            <circle
              className={styles.contextValue}
              cx="10"
              cy="10"
              r="7.5"
              pathLength="100"
              strokeDasharray={`${Math.min(100, Math.max(0, percentage))} 100`}
            />
          )}
        </svg>
        <span className={styles.contextLabel}>{label}</span>
      </span>
    );

    return (
      <>
        {viewerEnabled ? (
          <InteractiveContextMeter
            key={agentId}
            agentId={agentId}
            sourceVersion={sourceVersion}
            tooltip={tooltip}
            inspectAria={t('contextUi.meter.inspectAria', { usage: tooltip })}
          >
            {content}
          </InteractiveContextMeter>
        ) : (
          <Tooltip title={tooltip} enterDelay={100}>
            <span className={styles.contextButton} aria-label={tooltip}>
              {content}
            </span>
          </Tooltip>
        )}
      </>
    );
  },
);

ContextUsageRing.displayName = 'ContextUsageRing';

function InteractiveContextMeter({
  agentId,
  sourceVersion,
  tooltip,
  inspectAria,
  children,
}: {
  readonly agentId: string;
  readonly sourceVersion: number;
  readonly tooltip: string;
  readonly inspectAria: string;
  readonly children: ReactNode;
}) {
  const runtime = useRendererRuntime();
  const resource = useContextInspectorResource((value) => value);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const openedRef = useRef(false);
  const versionRef = useRef(sourceVersion);

  useEffect(() => {
    if (!popoverOpen || inspectorOpen || versionRef.current === sourceVersion) return;
    versionRef.current = sourceVersion;
    void runtime.contextInspector.refresh();
  }, [inspectorOpen, popoverOpen, runtime, sourceVersion]);

  useEffect(() => {
    if (!openedRef.current || popoverOpen || inspectorOpen) return;
    runtime.contextInspector.close(agentId);
    openedRef.current = false;
  }, [agentId, inspectorOpen, popoverOpen, runtime]);

  useEffect(() => () => runtime.contextInspector.close(agentId), [agentId, runtime]);

  const setOpen = (next: boolean) => {
    setPopoverOpen(next);
    if (!next) return;
    openedRef.current = true;
    versionRef.current = sourceVersion;
    void runtime.contextInspector.open(agentId);
  };

  return (
    <>
      <Popover
        open={popoverOpen}
        onClose={() => setOpen(false)}
        placement="block-start"
        className={inspectorStyles.breakdownPopover}
        trigger={(
          <Tooltip title={tooltip} enterDelay={100}>
            <button
              type="button"
              className={styles.contextButton}
              aria-label={inspectAria}
              aria-expanded={popoverOpen}
              onClick={() => setOpen(!popoverOpen)}
            >
              {children}
            </button>
          </Tooltip>
        )}
      >
          <ContextBreakdown
            resource={resource}
            agentId={agentId}
            onRetry={() => void runtime.contextInspector.open(agentId)}
            onInspect={() => {
              setInspectorOpen(true);
              setPopoverOpen(false);
            }}
          />
      </Popover>
      <ContextInspector
        open={inspectorOpen}
        onClose={() => setInspectorOpen(false)}
        agentId={agentId}
        sourceVersion={sourceVersion}
      />
    </>
  );
}
