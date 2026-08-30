import { appLog } from '@electron/observability/logging/app-log.js';
import type { MarketChangeEvent } from '../../../shared/types/market.js';
import type { ChangeSink } from '../../core/change-channel.js';
import { startSkillsRegistryWatch } from '../../core/pilot/pilot-manager.js';
import { mcpConnectionManager } from '../../mcp/runtime/index.js';
import { watchPluginsFile } from '../../plugins/watch.js';
import type { RuntimeComponent } from '../component-manifest.js';
import type { InferenceComponentState } from './inference.component.js';

interface OwnedReceipt {
  label: string;
  close(): Promise<void>;
  isClosed(): boolean;
}

export function createMarketWatchersComponent(options: {
  userDataDirectory: string;
  inference: InferenceComponentState;
  changes: ChangeSink<MarketChangeEvent>;
}): RuntimeComponent<void> {
  const receipts: OwnedReceipt[] = [];

  const own = (label: string, closer: () => void | Promise<void>): OwnedReceipt => {
    let closed = false;
    let closePromise: Promise<void> | undefined;
    const receipt: OwnedReceipt = {
      label,
      close() {
        closePromise ??= Promise.resolve()
          .then(closer)
          .then(() => {
            closed = true;
          });
        return closePromise;
      },
      isClosed: () => closed,
    };
    receipts.push(receipt);
    return receipt;
  };

  const closeAll = async (): Promise<void> => {
    const results = await Promise.allSettled(
      [...receipts].reverse().map((receipt) => receipt.close())
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        'One or more market watchers failed to close'
      );
    }
  };

  return {
    id: 'market-watchers',
    requirement: 'optional',
    dependsOn: ['agent'],
    async start(_context, scope) {
      const inferenceHost = options.inference.bindings?.inferenceHost;
      if (!inferenceHost) throw new Error('Inference component is not ready');

      const configReceipt = own(
        'config-market-watch',
        inferenceHost.configHost.subscribe((event) => {
          if (scope.signal.aborted || event.domain !== 'mcp') return;
          mcpConnectionManager.invalidateCatalogCache();
          options.changes.publish({ kind: 'mcp', type: 'changed' });
        })
      );
      scope.register({
        kind: 'change-subscription',
        label: configReceipt.label,
        close: () => configReceipt.close(),
        inspect: () => (configReceipt.isClosed() ? 'closed' : 'live'),
      });

      const stopSkills = await startSkillsRegistryWatch((diff) => {
        if (scope.signal.aborted) return;
        for (const item of diff) {
          options.changes.publish({ kind: 'skill', type: item.kind, name: item.name });
        }
      });
      const skillsReceipt = own('skills-registry-watch', stopSkills);
      scope.register({
        kind: 'file-watcher',
        label: skillsReceipt.label,
        close: () => skillsReceipt.close(),
        inspect: () => (skillsReceipt.isClosed() ? 'closed' : 'live'),
      });

      const pluginWatch = await watchPluginsFile({
        configRoot: options.userDataDirectory,
        onChange: (_next, diff) => {
          if (scope.signal.aborted) return;
          mcpConnectionManager.invalidateCatalogCache();
          for (const item of diff) {
            options.changes.publish({ kind: 'plugin', type: item.kind, name: item.name });
          }
        },
        onError: (error) =>
          appLog.warn({
            event: 'market.plugin_registry.watch.degraded',
            message: 'Plugin registry watch degraded',
            context: { scope: 'market.plugin_registry' },
            error: error,
          }),
      });
      const pluginsReceipt = own('plugins-registry-watch', () => pluginWatch.close());
      scope.register({
        kind: 'file-watcher',
        label: pluginsReceipt.label,
        close: () => pluginsReceipt.close(),
        inspect: () => (pluginsReceipt.isClosed() ? 'closed' : 'live'),
      });
    },
    stop: closeAll,
    async verifyStopped() {
      const open = receipts
        .filter((receipt) => !receipt.isClosed())
        .map((receipt) => receipt.label);
      return {
        state: open.length === 0 ? 'stopped' : 'live',
        details: { open },
      };
    },
  };
}
