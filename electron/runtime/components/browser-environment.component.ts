import type { BrowserEnvironmentRuntime } from '../../services/browser-environment-runtime.js';
import type { RuntimeComponent } from '../component-manifest.js';

export function createBrowserEnvironmentComponent(
  browserEnvironmentRuntime: BrowserEnvironmentRuntime,
): RuntimeComponent<BrowserEnvironmentRuntime> {
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= browserEnvironmentRuntime.destroy();
    return closePromise;
  };

  return {
    id: 'browser-environment',
    requirement: 'required',
    dependsOn: ['pilot', 'storage'],
    async start(_context, scope) {
      scope.register({
        kind: 'custom',
        label: 'browser-environment-manager',
        close,
        inspect: () => {
          const snapshot = browserEnvironmentRuntime.lifecycleSnapshot();
          return !snapshot.initialized && snapshot.runningEnvironmentIds.length === 0
            ? 'closed'
            : 'live';
        },
        describe: () => browserEnvironmentRuntime.lifecycleSnapshot(),
      });
      await browserEnvironmentRuntime.initialize();
      return browserEnvironmentRuntime;
    },
    stop: close,
    async verifyStopped() {
      const snapshot = browserEnvironmentRuntime.lifecycleSnapshot();
      return {
        state: !snapshot.initialized && snapshot.runningEnvironmentIds.length === 0
          ? 'stopped'
          : 'live',
        details: snapshot,
      };
    },
  };
}
