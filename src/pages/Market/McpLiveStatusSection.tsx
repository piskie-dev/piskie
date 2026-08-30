import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Check,
  CircleDashed,
  LoaderCircle,
  PlugZap,
  RefreshCw,
  ShieldAlert,
  X,
} from 'lucide-react';

import type {
  AgentMcpServerView,
  McpRuntimeState,
  McpSessionRuntimeSummary,
} from '@shared/types/mcp';
import type { MarketProjectOption } from '@shared/types/market';
import { projectDisplayName } from '@shared/types/project';
import {
  resolvePresentationText,
  type PresentationText,
} from '../../i18n/presentationText';

import {
  canRetryMcpRuntime,
  mcpServerStateLabel,
  queryActiveMcpSessions,
  retryMcpRuntime,
  type McpRuntimeStateLabels,
} from '../../features/console/data/mcpRuntime';
import type { CapabilityLocation } from './market-workbench-model';
import {
  isMcpSessionWorkspaceEligible,
  mcpLiveQueryWorkspaces,
  mcpLiveSessionQuery,
} from './mcp-live-model';
import styles from './market.module.css';

export interface McpInstallProbeReceipt {
  status: 'passed' | 'failed';
  checkedAt: number;
  toolCount?: number;
  protocolVersion?: string;
  error?: PresentationText;
}

interface McpLiveStatusSectionProps {
  serverName: string;
  locations: readonly CapabilityLocation[];
  projects: readonly MarketProjectOption[];
  probe?: McpInstallProbeReceipt;
}

interface SessionServerStatus {
  summary: McpSessionRuntimeSummary;
  server?: AgentMcpServerView;
  state: McpRuntimeState;
}

type LiveTranslator = (key: string, values?: Record<string, string | number>) => string;

const runtimeStateLabels = (translate: LiveTranslator): McpRuntimeStateLabels => ({
  not_started: translate('marketUi.mcpLive.notStarted'),
  dormant: translate('marketUi.mcpLive.connectOnUse'),
  starting: translate('marketUi.mcpLive.connecting'),
  ready: translate('marketUi.mcpLive.connected'),
  failed: translate('marketUi.mcpLive.connectionFailed'),
  reconnecting: translate('marketUi.mcpLive.reconnecting'),
  blocked: translate('marketUi.mcpLive.actionRequired'),
  cachedStarting: translate('marketUi.mcpLive.cachedConnecting'),
  cachedDormant: translate('marketUi.mcpLive.cachedConnectOnUse'),
});

const stateText = (status: SessionServerStatus, translate: LiveTranslator): string => {
  if (status.server) return mcpServerStateLabel(status.server, runtimeStateLabels(translate));
  return translate('marketUi.mcpLive.notStartedCurrentSession');
};

const projectKey = (session: McpSessionRuntimeSummary): string => (
  session.workspace ?? session.projectContextId
);

function projectLabel(
  key: string,
  session: McpSessionRuntimeSummary,
  projects: readonly MarketProjectOption[],
  translate: LiveTranslator,
): string {
  const project = projects.find((candidate) => candidate.workspace === session.workspace);
  if (project) return projectDisplayName(project);
  if (session.workspace) return session.workspace.split(/[\\/]/).filter(Boolean).at(-1) ?? session.workspace;
  return key === 'global-default' || key.startsWith('default:')
    ? translate('marketUi.mcpLive.defaultWorkspace')
    : translate('marketUi.mcpLive.currentProject');
}

const ownerKindLabel = (
  kind: McpSessionRuntimeSummary['ownerKind'],
  translate: LiveTranslator,
): string => {
  if (kind === 'worker') return translate('marketUi.mcpLive.workerOwner');
  if (kind === 'composer') return translate('marketUi.mcpLive.composerOwner');
  return translate('marketUi.mcpLive.mainOwner');
};

const McpLiveStatusSection: React.FC<McpLiveStatusSectionProps> = ({
  serverName,
  locations,
  projects,
  probe,
}) => {
  const { t } = useTranslation();
  const [queried, setQueried] = useState<McpSessionRuntimeSummary[]>([]);
  const [queryError, setQueryError] = useState<string>();
  const [retrying, setRetrying] = useState<string>();
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const workspaceQueryKey = useMemo(() => {
    return JSON.stringify(mcpLiveQueryWorkspaces(locations, projects).map((workspace) => workspace ?? null));
  }, [locations, projects]);

  useEffect(() => {
    let cancelled = false;
    const queriedWorkspaces = (JSON.parse(workspaceQueryKey) as Array<string | null>)
      .map((workspace) => workspace ?? undefined);
    const load = () => {
      void Promise.allSettled(queriedWorkspaces.map((workspace) => (
        queryActiveMcpSessions(mcpLiveSessionQuery(workspace))
      )))
        .then((results) => {
          if (cancelled) return;
          const successful = results.flatMap((result) => (
            result.status === 'fulfilled' && result.value ? result.value : []
          ));
          const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
          setQueried(successful);
          setQueryError(results.every((result) => result.status === 'rejected')
            ? failure?.reason instanceof Error ? failure.reason.message : String(failure?.reason)
            : undefined);
        })
        .catch((error) => {
          if (!cancelled) setQueryError(error instanceof Error ? error.message : String(error));
        });
    };
    load();
    const interval = window.setInterval(load, 4_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [refreshEpoch, serverName, workspaceQueryKey]); // queriedWorkspaces is represented by its stable key

  const groups = useMemo(() => {
    const sessions = queried.filter((session) => isMcpSessionWorkspaceEligible(session, locations));
    const byProject = new Map<string, SessionServerStatus[]>();
    for (const summary of sessions) {
      const server = summary.servers.find((candidate) => candidate.name === serverName);
      const status: SessionServerStatus = {
        summary,
        server,
        state: server?.state ?? 'not_started',
      };
      const key = projectKey(summary);
      byProject.set(key, [...(byProject.get(key) ?? []), status]);
    }
    return [...byProject.entries()].map(([key, statuses]) => ({
      key,
      label: projectLabel(key, statuses[0]!.summary, projects, t),
      statuses,
    }));
  }, [locations, projects, queried, serverName, t]);

  const retry = async (status: SessionServerStatus) => {
    setRetrying(status.summary.sessionRuntimeId);
    setQueryError(undefined);
    try {
      await retryMcpRuntime(status.summary.sessionRuntimeId, [serverName]);
      setRefreshEpoch((epoch) => epoch + 1);
    } catch (error) {
      setQueryError(error instanceof Error ? error.message : String(error));
    } finally {
      setRetrying(undefined);
    }
  };

  return (
    <section className={`${styles.section} ${styles.mcpRuntimeSection}`}>
      <div className={styles.sectionTitle}>
        <span>{t('marketUi.mcpLive.sectionTitle')}</span>
        <small>{t('marketUi.mcpLive.sectionHint')}</small>
      </div>

      <div className={styles.mcpStatusLegend}>
        <PlugZap aria-hidden />
        <span>{t('marketUi.mcpLive.legend')}</span>
      </div>

      {groups.length === 0 ? (
        <div className={styles.mcpNoSessions}>
          <CircleDashed aria-hidden />
          <span>{t('marketUi.mcpLive.noActiveSessions')}</span>
        </div>
      ) : (
        <div className={styles.mcpProjectGroups}>
          {groups.map((group) => {
            const ready = group.statuses.filter((status) => status.state === 'ready').length;
            const failed = group.statuses.filter((status) => status.state === 'failed').length;
            const starting = group.statuses.filter((status) => (
              status.state === 'starting' || status.state === 'reconnecting'
            )).length;
            return (
              <div className={styles.mcpProjectGroup} key={group.key}>
                <div className={styles.mcpProjectHead}>
                  <strong>{group.label}</strong>
                  <span>
                    {t('marketUi.mcpLive.activeSessionCount', { count: group.statuses.length })}
                    {ready > 0 && <> · {t('marketUi.mcpLive.readyCount', { count: ready })}</>}
                    {starting > 0 && <> · {t('marketUi.mcpLive.startingCount', { count: starting })}</>}
                    {failed > 0 && <> · {t('marketUi.mcpLive.failedCount', { count: failed })}</>}
                  </span>
                </div>
                <div className={styles.mcpSessionRows}>
                  {group.statuses.map((status) => {
                    const loading = status.state === 'starting' || status.state === 'reconnecting';
                    const Icon = status.state === 'ready'
                      ? Check
                      : status.state === 'failed'
                        ? X
                        : status.state === 'blocked'
                          ? ShieldAlert
                          : loading
                            ? LoaderCircle
                            : CircleDashed;
                    return (
                      <div
                        className={styles.mcpSessionRow}
                        data-state={status.state}
                        key={status.summary.sessionRuntimeId}
                      >
                        <Icon className={loading ? styles.spin : undefined} aria-hidden />
                        <span className={styles.mcpSessionIdentity}>
                          <strong>{status.summary.ownerLabel || status.summary.ownerId.slice(0, 8)}</strong>
                          <small>{ownerKindLabel(status.summary.ownerKind, t)}</small>
                        </span>
                        <span className={styles.mcpSessionState}>{stateText(status, t)}</span>
                        {status.state === 'failed'
                          && status.server?.retryable !== false
                          && canRetryMcpRuntime() && (
                          <button
                            type="button"
                            disabled={retrying === status.summary.sessionRuntimeId}
                            onClick={() => void retry(status)}
                          >
                            <RefreshCw className={retrying === status.summary.sessionRuntimeId ? styles.spin : undefined} />
                            {t('marketUi.mcpLive.retryAction')}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {queryError && (
        <div className={styles.mcpStatusError}><AlertTriangle aria-hidden />{queryError}</div>
      )}

      <div className={styles.mcpProbeReceipt} data-status={probe?.status ?? 'unchecked'}>
        <span className={styles.mcpProbeIcon}>
          {probe?.status === 'passed' ? <Check /> : probe?.status === 'failed' ? <X /> : <CircleDashed />}
        </span>
        <span>
          <strong>
            {probe?.status === 'passed'
              ? t('marketUi.mcpLive.probePassed')
              : probe?.status === 'failed'
                ? t('marketUi.mcpLive.probeFailed')
                : t('marketUi.mcpLive.probeUnchecked')}
          </strong>
          <small>
            {probe?.status === 'passed'
              ? probe.toolCount === undefined
                ? t('marketUi.mcpLive.probeClosed')
                : t('marketUi.mcpLive.probeClosedWithTools', { count: probe.toolCount })
              : probe?.status === 'failed'
                ? probe.error
                  ? resolvePresentationText(probe.error, (key, values) => t(key, values ?? {}))
                  : t('marketUi.mcpLive.probeIncomplete')
                : t('marketUi.mcpLive.probeExplanation')}
          </small>
        </span>
      </div>
    </section>
  );
};

export default McpLiveStatusSection;
