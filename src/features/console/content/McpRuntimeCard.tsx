import { memo, useState } from 'react';
import { AlertTriangle, ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import type { AgentMcpServerView, AgentMcpView } from '../../../../shared/types/mcp';
import {
  canRetryMcpRuntime,
  failedMcpServerNames,
  mcpConfigPath,
  retryMcpRuntime,
} from '../data/mcpRuntime';
import styles from './mcpRuntimeCard.module.css';

export interface McpRuntimeCardProps {
  readonly view?: AgentMcpView;
  readonly error?: string;
  readonly workspace?: string;
  readonly variant?: 'main' | 'worker' | 'composer';
}

function namesOf(servers: readonly AgentMcpServerView[]): string {
  return servers.map((server) => server.name).join(', ');
}

function detailsOf(servers: readonly AgentMcpServerView[]): string | undefined {
  const details = servers
    .map((server) => server.errorSummary && `${server.name}: ${server.errorSummary}`)
    .filter((detail): detail is string => Boolean(detail));
  return details.length > 0 ? details.join('\n') : undefined;
}

export const McpRuntimeCard = memo<McpRuntimeCardProps>(({
  view,
  error,
  workspace,
  variant = 'main',
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [retrying, setRetrying] = useState(false);
  const [actionError, setActionError] = useState<string>();

  // A successful runtime is deliberately silent. This is transient/error chrome, not a badge.
  if (view
    && view.total > 0
    && view.ready === view.total
    && view.starting === 0
    && view.failed === 0
    && view.blocked === 0) return null;

  const connectingServers = view?.servers.filter(
    (server) => server.state === 'starting' || server.state === 'reconnecting',
  ) ?? [];
  const problemServers = view?.servers.filter(
    (server) => server.state === 'failed' || server.state === 'blocked',
  ) ?? [];
  const connecting = Boolean(view && (view.starting > 0 || connectingServers.length > 0));
  const problems = Boolean(view && (view.failed > 0 || view.blocked > 0 || problemServers.length > 0));

  if (!connecting && !problems && !error && !actionError) return null;

  const retryNames = view ? failedMcpServerNames(view) : [];
  const canRetry = retryNames.length > 0 && canRetryMcpRuntime();
  const firstProblem = problemServers[0];
  const problemCount = view ? Math.max(problemServers.length, view.failed + view.blocked) : 0;
  const problemLabel = view?.failed
    ? t('sessionWorkbenchUi.mcpRuntime.connectionFailed')
    : t('sessionWorkbenchUi.mcpRuntime.unavailable');
  const problemDetails = detailsOf(problemServers);
  const inlineProblem = problemServers.length === 1 ? problemServers[0]?.errorSummary : undefined;

  const retry = async () => {
    if (!view) return;
    setRetrying(true);
    setActionError(undefined);
    try {
      await retryMcpRuntime(view.sessionRuntimeId, retryNames);
    } catch (retryError) {
      setActionError(retryError instanceof Error ? retryError.message : String(retryError));
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className={styles.status} data-variant={variant} aria-live="polite">
      {connecting && view && (
        <div className={styles.line} data-tone="progress">
          <LoaderCircle className={styles.spin} aria-hidden />
          <span className={styles.copy}>
            <strong>{t('sessionWorkbenchUi.mcpRuntime.connectingCount', { count: `${view.ready}/${view.total}` })}</strong>
            {connectingServers.length > 0 && (
              <span className={styles.names} title={namesOf(connectingServers)}>
                : {namesOf(connectingServers)}
              </span>
            )}
          </span>
        </div>
      )}

      {problems && view && (
        <div className={styles.line} data-tone="error">
          <AlertTriangle aria-hidden />
          <span className={styles.copy} title={problemDetails}>
            <strong>{problemLabel} ({problemCount}/{view.total})</strong>
            {problemServers.length > 0 && (
              <span className={styles.names}>: {namesOf(problemServers)}</span>
            )}
            {(actionError || inlineProblem) && (
              <span className={styles.reason}> · {actionError ?? inlineProblem}</span>
            )}
          </span>
          <span className={styles.actions}>
            {canRetry && (
              <button type="button" disabled={retrying} onClick={() => void retry()}>
                <RefreshCw className={retrying ? styles.spin : undefined} aria-hidden />
                {retrying
                  ? t('sessionWorkbenchUi.mcpRuntime.retrying')
                  : t('sessionWorkbenchUi.mcpRuntime.retry')}
              </button>
            )}
            <button
              type="button"
              onClick={() => navigate(mcpConfigPath(firstProblem?.name, workspace))}
            >
              <ExternalLink aria-hidden />{t('sessionWorkbenchUi.mcpRuntime.configure')}
            </button>
          </span>
        </div>
      )}

      {!problems && (error || actionError) && (
        <div className={styles.line} data-tone="error">
          <AlertTriangle aria-hidden />
          <span className={styles.copy}>
            <strong>{view
              ? t('sessionWorkbenchUi.mcpRuntime.statusReadFailed')
              : t('sessionWorkbenchUi.mcpRuntime.connectionFailed')}</strong>
            <span className={styles.reason}>: {actionError ?? error}</span>
          </span>
          <button
            type="button"
            className={styles.configAction}
            onClick={() => navigate(mcpConfigPath(undefined, workspace))}
          >
            <ExternalLink aria-hidden />{t('sessionWorkbenchUi.mcpRuntime.configure')}
          </button>
        </div>
      )}
    </div>
  );
});

McpRuntimeCard.displayName = 'McpRuntimeCard';
