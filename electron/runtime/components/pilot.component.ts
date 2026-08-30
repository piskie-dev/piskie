import { BrowserManager } from '../../piskiepilot/browser/core/browser/browser-manager.js';
import { pilotRuntimeHost } from '../../core/pilot/pilot-manager.js';
import type { RuntimeComponent } from '../component-manifest.js';

export function createPilotComponent(): RuntimeComponent<typeof pilotRuntimeHost> {
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= pilotRuntimeHost.stop();
    return closePromise;
  };

  return {
    id: 'pilot',
    requirement: 'required',
    dependsOn: ['storage'],
    async start(_context, scope) {
      scope.register({
        kind: 'custom',
        label: 'pilot-runtime',
        close,
        inspect: () => {
          const snapshot = pilotRuntimeHost.lifecycleSnapshot();
          return !snapshot.ready && snapshot.ownedBrowserIds.length === 0 ? 'closed' : 'live';
        },
        describe: () => pilotRuntimeHost.lifecycleSnapshot(),
      });
      await pilotRuntimeHost.initialize();
      return pilotRuntimeHost;
    },
    stop: close,
    async forceClose() {
      await BrowserManager.emergencyKillAll();
      await close().catch(() => undefined);
    },
    async verifyStopped() {
      const snapshot = pilotRuntimeHost.lifecycleSnapshot();
      return {
        state: !snapshot.ready && snapshot.ownedBrowserIds.length === 0 ? 'stopped' : 'live',
        details: snapshot,
      };
    },
  };
}
