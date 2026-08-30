import { mcpConnectionManager } from '../../mcp/runtime/index.js';
import type { RuntimeComponent } from '../component-manifest.js';

export function createMcpComponent(): RuntimeComponent<typeof mcpConnectionManager> {
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= mcpConnectionManager.dispose();
    return closePromise;
  };

  return {
    id: 'mcp',
    requirement: 'required',
    dependsOn: ['proxy-transports'],
    async start(_context, scope) {
      scope.register({
        kind: 'custom',
        label: 'mcp-connection-manager',
        close,
        inspect: () => {
          const snapshot = mcpConnectionManager.lifecycleSnapshot();
          return snapshot.disposed && snapshot.runtimeIds.length === 0 ? 'closed' : 'live';
        },
        describe: () => mcpConnectionManager.lifecycleSnapshot(),
      });
      return mcpConnectionManager;
    },
    stop: close,
    async verifyStopped() {
      const snapshot = mcpConnectionManager.lifecycleSnapshot();
      return {
        state: snapshot.runtimeIds.length === 0
          && snapshot.prewarmTokens.length === 0
          ? 'stopped'
          : 'live',
        details: snapshot,
      };
    },
  };
}
